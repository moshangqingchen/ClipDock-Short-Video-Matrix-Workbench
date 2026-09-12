import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateRules,
  rulesVersion,
  type KernelRule,
  type RuleContext,
  type RuleSourceParameters,
} from "./rules";

const context = { host: "creator.douyin.com", port: 443, network: "tcp" as const };
const direct: KernelRule = { type: "DomainSuffix", payload: "douyin.com", proxy: "DIRECT" };
const withParameters = (
  source: Omit<RuleSourceParameters, "parametersFingerprint">,
): RuleSourceParameters => ({
  ...source,
  parametersFingerprint: createHash("sha256").update(JSON.stringify(source.parameters)).digest("hex"),
});

describe("live kernel ordered rule subset", () => {
  it("accepts current domain rules, but never bypasses a preceding unknown rule", () => {
    expect(evaluateRules("rule", [direct], context).route).toBe("direct");
    for (const type of ["GeoSite", "GeoIP", "RuleSet", "IPCIDR", "And"]) {
      expect(evaluateRules("rule", [{ type, payload: "cn", proxy: "DIRECT" }, direct], context).route).toBe(
        "unknown",
      );
    }
  });
  it("respects boundaries, process branches, order, mode and exact policy identity", () => {
    expect(evaluateRules("rule", [direct], { ...context, host: "douyin.com.evil.test" }).route).toBe(
      "unknown",
    );
    expect(evaluateRules("global", [direct], context).reason).toBe("GLOBAL_MODE");
    expect(evaluateRules("direct", [direct], context).route).toBe("unknown");
    expect(evaluateRules("rule", [{ ...direct, proxy: "DIRECT group" }], context).route).toBe("proxy");
    const rules = [{ type: "ProcessName", payload: "node.exe", proxy: "PROXY" }, direct];
    expect(evaluateRules("rule", rules, context).route).toBe("unknown");
    expect(evaluateRules("rule", rules, { ...context, processName: "node.exe" }).route).toBe("proxy");
    expect(evaluateRules("rule", rules, { ...context, processName: "electron.exe" }).route).toBe("direct");
  });
  it("fingerprints order, mode and effective config, not only matched rules", () => {
    expect(rulesVersion("rule", true, [direct], "a")).not.toBe(rulesVersion("rule", true, [direct], "b"));
    expect(rulesVersion("rule", true, [direct])).not.toBe(rulesVersion("global", true, [direct]));
  });
});

describe("same-source CIDR parameters and actual rule-stage destination", () => {
  const cidr = (payload = "10.0.0.0/8", proxy = "REJECT", type = "IP-CIDR"): KernelRule => ({
    type,
    payload,
    proxy,
  });
  const known = (address: string): RuleContext => ({
    ...context,
    destination: { stage: "resolved", address },
  });
  const evaluate = (rule: KernelRule, ctx: RuleContext, parameters: readonly string[] = ["no-resolve"]) => {
    const rules = [rule, direct];
    return evaluateRules("rule", rules, ctx, withParameters({ rules, parameters: [parameters, []] }));
  };

  it("does not interpret a live IPCIDR row without its same-source modifiers", () => {
    const rules = [cidr(), direct];
    expect(evaluateRules("rule", rules, known("192.0.2.1"))).toMatchObject({
      route: "unknown",
      ruleIndex: 0,
    });
    expect(
      evaluateRules("rule", rules, known("192.0.2.1"), withParameters({ rules, parameters: [[], []] })).route,
    ).toBe("direct");
  });

  it.each([undefined, { stage: "unknown" }] as const)(
    "never treats missing/unknown destination as unresolved (%j)",
    (destination) => {
      expect(evaluate(cidr(), { ...context, destination }).route).toBe("unknown");
    },
  );

  it("skips no-resolve only for a positively known unresolved destination", () => {
    const unresolved = { ...context, destination: { stage: "unresolved" as const } };
    expect(evaluate(cidr(), unresolved)).toMatchObject({ route: "direct", ruleIndex: 1 });
    expect(evaluate(cidr(), unresolved, [])).toMatchObject({ route: "unknown", ruleIndex: 0 });
  });

  it.each([{ parameters: [] }, { parameters: ["no-resolve"] }])(
    "matches an existing destination regardless of resolve modifier ($parameters)",
    ({ parameters }) => {
      expect(evaluate(cidr(), known("10.1.2.3"), parameters)).toMatchObject({ route: "proxy", ruleIndex: 0 });
      expect(evaluate(cidr(), known("11.1.2.3"), parameters)).toMatchObject({
        route: "direct",
        ruleIndex: 1,
      });
    },
  );

  it.each([
    ["0.0.0.0/0", "255.255.255.255", true],
    ["192.0.2.128/25", "192.0.2.127", false],
    ["192.0.2.128/25", "192.0.2.128", true],
    ["192.0.2.128/25", "192.0.2.255", true],
    ["192.0.2.128/25", "192.0.3.0", false],
    ["192.0.2.12/32", "192.0.2.12", true],
    ["192.0.2.12/32", "192.0.2.13", false],
    ["192.0.2.123/24", "192.0.2.90", true],
    ["::/0", "2001:db8::1", true],
    ["2001:db8::/32", "2001:db8:ffff::1", true],
    ["2001:db8::/32", "2001:db9::1", false],
    ["2001:db8::1/128", "2001:0db8:0:0:0:0:0:1", true],
    ["2001:db8::1/128", "2001:db8::2", false],
    ["2001:db8::/64", "192.0.2.1", false],
    ["192.0.2.0/24", "2001:db8::1", false],
    ["::ffff:192.0.2.0/120", "::ffff:192.0.2.7", true],
    ["192.0.2.0/24", "::ffff:192.0.2.7", false],
  ])("compares %s against %s with family-aware prefix membership", (prefix, address, matches) => {
    expect(evaluate(cidr(prefix), known(address)).ruleIndex).toBe(matches ? 0 : 1);
  });

  it.each(["IPCIDR", "IP-CIDR", "IP_CIDR", "IP-CIDR6"])("uses kernel CIDR alias semantics for %s", (type) => {
    expect(evaluate(cidr("192.0.2.0/24", "REJECT", type), known("192.0.2.3")).route).toBe("proxy");
    expect(evaluate(cidr("2001:db8::/32", "REJECT", type), known("2001:db8::3")).route).toBe("proxy");
  });

  it.each([
    "10.0.0.0",
    "10.0.0.0/33",
    "10.0.0.0/-1",
    "10.0.0.0/08",
    "2001:db8::/129",
    "::1/32/2",
    "host.invalid/24",
    "10.00.0.0/8",
  ])("rejects malformed prefix %s even when unresolved", (prefix) => {
    expect(evaluate(cidr(prefix), { ...context, destination: { stage: "unresolved" } }).route).toBe(
      "unknown",
    );
  });

  it.each(["", "host.invalid", "192.0.2.1:443", "[2001:db8::1]", "fe80::1%12", "1.2.3.999"])(
    "does not convert an invalid/scoped destination %s into a nonmatch",
    (address) => {
      expect(evaluate(cidr(), known(address)).route).toBe("unknown");
    },
  );

  it.each([
    [["src"]],
    [["no-resolve", "src"]],
    [["no-resolve", "no-resolve"]],
    [["NO-RESOLVE"]],
    [["future-option"]],
    [[""]],
  ])("does not interpret unmodeled or repeated parameters %j as destination CIDR", (parameters) => {
    expect(evaluate(cidr(), known("192.0.2.1"), parameters).route).toBe("unknown");
  });

  it.each(["length", "parameter-length", "order", "type", "payload", "policy", "missing-row"])(
    "rejects %s mismatch in the complete parameter alignment",
    (change) => {
      const rules = [cidr(), direct];
      const supplied = {
        ...withParameters({ rules, parameters: [["no-resolve"], []] }),
        rules: structuredClone(rules),
        parameters: [["no-resolve"], []],
      };
      if (change === "length") supplied.rules.pop();
      if (change === "parameter-length") supplied.parameters.pop();
      if (change === "order") supplied.rules.reverse();
      if (change === "type") supplied.rules[0].type = "SRC-IP-CIDR";
      if (change === "payload") supplied.rules[0].payload = "192.0.0.0/8";
      if (change === "policy") supplied.rules[0].proxy = "DIRECT";
      if (change === "missing-row") delete supplied.parameters[0];
      expect(evaluateRules("rule", rules, known("192.0.2.1"), supplied).route).toBe("unknown");
    },
  );

  it("compares normalized live/source spelling without discarding parameter provenance", () => {
    const rules = [cidr("2001:db8::/32", "REJECT", "IPCIDR"), direct];
    const source = withParameters({
      rules: [{ ...rules[0], type: "IP-CIDR6" }, direct],
      parameters: [["no-resolve"], []],
    });
    expect(evaluateRules("rule", rules, known("2001:db8::1"), source).ruleIndex).toBe(0);
  });

  it.each(["missing", "wrong", "malformed", "changed-parameters", "swapped-identical-triples"])(
    "rejects %s parameter fingerprint integrity failure",
    (change) => {
      const rules = [cidr(), cidr(), direct];
      const original = withParameters({ rules, parameters: [["no-resolve"], [], []] });
      const supplied = structuredClone(original);
      if (change === "missing") delete (supplied as Partial<RuleSourceParameters>).parametersFingerprint;
      if (change === "wrong")
        (supplied as { parametersFingerprint: string }).parametersFingerprint = "0".repeat(64);
      if (change === "malformed")
        (supplied as { parametersFingerprint: string }).parametersFingerprint = "not-a-fingerprint";
      if (change === "changed-parameters") (supplied.parameters as string[][])[0] = [];
      if (change === "swapped-identical-triples")
        (supplied.parameters as string[][]).splice(0, 2, [], ["no-resolve"]);
      expect(evaluateRules("rule", rules, known("192.0.2.1"), supplied).route).toBe("unknown");
    },
  );

  it("rejects unknown modifiers on reached domain rules but leaves later unrelated rules uninterpreted", () => {
    const later = { type: "GeoIP", payload: "cn", proxy: "DIRECT" };
    const rules = [direct, later];
    expect(
      evaluateRules("rule", rules, context, withParameters({ rules, parameters: [["future-option"], []] }))
        .route,
    ).toBe("unknown");
    expect(
      evaluateRules("rule", rules, context, withParameters({ rules, parameters: [[], ["no-resolve"]] }))
        .route,
    ).toBe("direct");
  });

  it("does not skip a resolving rule or invent geo data to reach a later direct rule", () => {
    const rules = [cidr(), { type: "GeoIP", payload: "cn", proxy: "DIRECT" }, direct];
    expect(
      evaluateRules(
        "rule",
        rules,
        { ...context, destination: { stage: "unresolved" } },
        withParameters({ rules, parameters: [[], [], []] }),
      ).ruleIndex,
    ).toBe(0);
    expect(
      evaluateRules(
        "rule",
        rules,
        known("192.0.2.1"),
        withParameters({ rules, parameters: [["no-resolve"], [], []] }),
      ),
    ).toMatchObject({ route: "unknown", ruleIndex: 1 });
  });

  it("models the observed rule shape without claiming the api6 path is DIRECT", () => {
    const rules: KernelRule[] = [
      cidr("198.18.0.0/16", "DIRECT"),
      { type: "ProcessName", payload: "com.viu.pad", proxy: "OTHER" },
      { type: "DomainSuffix", payload: "ipip.net", proxy: "DIRECT" },
      cidr("::/0", "REJECT", "IP-CIDR6"),
      { type: "GeoIP", payload: "cn", proxy: "DIRECT" },
      { type: "Match", payload: "", proxy: "OTHER" },
    ];
    const source = withParameters({ rules, parameters: [["no-resolve"], [], [], ["no-resolve"], [], []] });
    const actual = {
      ...known("2001:db8::10"),
      host: "api6.ipify.org",
      processName: "reviewed-test-factory.exe",
    };
    expect(evaluateRules("rule", rules, actual, source)).toMatchObject({ route: "proxy", ruleIndex: 3 });
    expect(
      evaluateRules("rule", rules, { ...actual, destination: { stage: "unresolved" } }, source),
    ).toMatchObject({ route: "unknown", ruleIndex: 4 });
    expect(
      evaluateRules("rule", rules, { ...actual, destination: { stage: "unknown" } }, source),
    ).toMatchObject({ route: "unknown", ruleIndex: 0 });
    expect(evaluateRules("rule", rules, { ...actual, host: "myip.ipip.net" }, source)).toMatchObject({
      route: "direct",
      ruleIndex: 2,
    });
    expect(
      evaluateRules("rule", rules, { ...actual, host: "myip.ipip.net", processName: undefined }, source),
    ).toMatchObject({ route: "unknown", ruleIndex: 1 });
  });
});
