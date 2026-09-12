import { describe, expect, it } from "vitest";
import { checkingNetworkSnapshot, networkSettingsSchema } from "./network";

describe("public network boundary", () => {
  it("accepts only literal local controllers without secrets or arbitrary paths", () => {
    expect(networkSettingsSchema.parse({}).controllerUrl).toBe("http://127.0.0.1:9790");
    for (const controllerUrl of [
      "http://example.com",
      "http://localhost:9790",
      "http://127.0.0.1:0",
      "http://127.1:9790",
      "http://2130706433:9790",
      "http://u:p@127.0.0.1:9790",
      "http://127.0.0.1:9790/?secret=a",
      "http://127.0.0.1:9790/configs",
    ]) {
      expect(networkSettingsSchema.safeParse({ controllerUrl }).success).toBe(false);
    }
    expect(networkSettingsSchema.safeParse({ clashSecret: "never-public" }).success).toBe(false);
  });
  it("starts checking without accounts, evidence or a remembered green light", () => {
    const first = checkingNetworkSnapshot();
    first.direct.state = "reachable";
    expect(checkingNetworkSnapshot().state).toBe("checking");
    expect(checkingNetworkSnapshot().direct.state).toBe("checking");
    expect(checkingNetworkSnapshot().accounts).toEqual([]);
  });
  it("keeps legacy settings unchanged and accepts an explicit source removal", () => {
    const legacy = { controllerUrl: "http://127.0.0.1:9790", diagnosticProxyPort: 10090 };
    expect(networkSettingsSchema.parse(legacy)).toEqual(legacy);
    expect(networkSettingsSchema.parse({ ...legacy, selectedClientResourcesPath: null })).toEqual({
      ...legacy,
      selectedClientResourcesPath: null,
    });
  });
  it.each(["C:\\Apps\\猫猫云\\resources", "D:/Apps/猫猫云/resources"])(
    "accepts a local absolute path without claiming it exists: %s",
    (path) => {
      expect(networkSettingsSchema.parse({ selectedClientResourcesPath: `  ${path}  ` }))
        .toHaveProperty("selectedClientResourcesPath", path);
    },
  );
  it.each([
    "",
    "resources",
    "C:resources",
    "\\resources",
    "\\\\server\\share\\resources",
    "\\\\?\\C:\\resources",
    "file:///C:/resources",
    "https://example.test/resources",
    "C:\\resources:stream",
    "C:\\res?ources",
    "C:\\res*ources",
    "C:\\res|ources",
    'C:\\res"ources',
    "C:\\res<ources",
    "C:\\res>ources",
    "C:\\resources\n",
    "C:\\res\u0000ources",
    `C:\\${"a".repeat(4096)}`,
  ])("rejects unsafe or nonlocal source path %j", (selectedClientResourcesPath) => {
    expect(networkSettingsSchema.safeParse({ selectedClientResourcesPath }).success).toBe(false);
  });
});
