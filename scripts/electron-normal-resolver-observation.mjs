/** Local build/self-check by default. --run-once makes ONE actual anonymous robots GET.
 * --api6 selects one fixed API6 echo and, only on success, its matching-IP geography query.
 * No resolveHost prewarming, forced address family, resolver override or account/bootstrap import.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url),
  root = path.resolve(path.dirname(script), "..");
const api6 = process.argv.includes("--api6");
const host = api6 ? "api6.ipify.org" : "api.bilibili.com",
  publicUrl = `https://${host}/${api6 ? "" : "robots.txt"}`;
const controllerUrl = "http://127.0.0.1:9790",
  run = process.argv.includes("--run-once");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const assert = (v, reason) => {
  if (!v) throw Error(reason);
};
const safeError = (e) => (/^[A-Z_]{1,100}$/.test(e?.message ?? "") ? e.message : "OBSERVATION_UNAVAILABLE");
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const record = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
const canonicalIp = (v) =>
  typeof v === "string" && !v.includes("%")
    ? net.isIP(v) === 4
      ? v
      : net.isIP(v) === 6
        ? new URL(`https://[${v}]`).hostname.slice(1, -1)
        : null
    : null;
function projectFactoryResult(sample) {
  if (!api6 || !sample.available) return sample;
  const value = sample.observation;
  return {
    available: true,
    observation: {
      factoryId: value.factoryId,
      source: value.source,
      reportedAddressHash: sha(canonicalIp(value.ip)),
      reportedAddressFamily: value.reportedAddressFamily,
      countryCode: value.countryCode,
      asn: value.asn,
      transportContextId: value.transportContextId,
      startedAtMono: value.startedAtMono,
      observedAtMono: value.observedAtMono,
      completedAtMono: value.completedAtMono,
      echo: value.echo,
      geo: value.geo,
    },
  };
}
function parserSource() {
  const filename = "src/main/network/anonymous-request-socket.ts";
  const original = fs.readFileSync(path.join(root, filename), "utf8");
  if (!api6)
    return {
      filename,
      original,
      adapted: null,
      contents: "export {parseAnonymousRequestSocket} from './anonymous-request-socket.ts';",
    };
  const exactLine =
    '    const exactUrl = `https://${target.host}${target.port === 443 ? "" : `:${target.port}`}/robots.txt`;';
  assert(original.split(exactLine).length === 2, "PARSER_SOURCE_CHANGED");
  const adapted = original.replace(
    exactLine,
    '    if (target.host !== "api6.ipify.org" || target.port !== 443) fail("INPUT_INVALID");\n    const exactUrl = "https://api6.ipify.org/";',
  );
  return { filename, original, adapted, contents: adapted };
}
const address = (v) => {
  const ip = canonicalIp(v);
  if (ip) return { family: net.isIP(ip) === 4 ? "ipv4" : "ipv6", addressHash: sha(ip), port: null };
  if (typeof v !== "string" || v.length > 96) return null;
  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(v) ?? /^([^:]+):(\d{1,5})$/.exec(v);
  if (!match || !canonicalIp(match[1]) || Number(match[2]) > 65535) return null;
  return {
    family: net.isIP(match[1]) === 4 ? "ipv4" : "ipv6",
    addressHash: sha(canonicalIp(match[1])),
    port: Number(match[2]),
  };
};
const bounded = async (work, ms) => {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("DRAIN_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Script-private projection only. Original rows/URLs/IPs never leave this function. */
function resolverProjection(text, parseSocket) {
  assert(typeof text === "string" && Buffer.byteLength(text) <= 8 * 1024 * 1024, "NETLOG_LIMIT");
  const log = JSON.parse(text),
    constants = record(log.constants);
  assert(
    constants &&
      record(constants.logEventTypes) &&
      record(constants.logSourceType) &&
      Array.isArray(log.events) &&
      log.events.length <= 50000,
    "NETLOG_SHAPE_INVALID",
  );
  const table = (value, max) => {
    assert(Object.keys(value).length <= max, "NETLOG_LIMIT");
    const rows = Object.entries(value);
    assert(
      rows.every(([name, id]) => /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && integer(id)) &&
        new Set(rows.map(([, id]) => id)).size === rows.length,
      "NETLOG_CONSTANTS_INVALID",
    );
    return new Map(rows.map(([name, id]) => [id, name]));
  };
  const types = table(constants.logEventTypes, 4096),
    sourceTypes = table(constants.logSourceType, 512);
  const identities = new Map();
  const dependencies = (value) => {
    const out = new Set(),
      pending = [{ value, depth: 0 }];
    let count = 0;
    while (pending.length) {
      const entry = pending.pop();
      assert(++count <= 2048 && entry.depth <= 16, "NETLOG_LIMIT");
      if (!entry.value || typeof entry.value !== "object") continue;
      for (const [key, v] of Object.entries(entry.value)) {
        if (key === "source_dependency") {
          assert(record(v) && integer(v.id), "NETLOG_DEPENDENCY_INVALID");
          out.add(v.id);
        } else if (v && typeof v === "object") pending.push({ value: v, depth: entry.depth + 1 });
      }
    }
    return [...out];
  };
  const rows = log.events.map((e) => {
    assert(
      record(e) &&
        record(e.source) &&
        integer(e.source.id) &&
        sourceTypes.has(e.source.type) &&
        types.has(e.type),
      "NETLOG_EVENT_INVALID",
    );
    assert(
      !identities.has(e.source.id) || identities.get(e.source.id) === e.source.type,
      "NETLOG_SOURCE_CHANGED",
    );
    identities.set(e.source.id, e.source.type);
    const params = record(e.params) ?? {};
    return {
      id: e.source.id,
      sourceType: sourceTypes.get(e.source.type),
      event: types.get(e.type),
      ticks: typeof e.time === "string" && /^\d+(?:\.\d+)?$/.test(e.time) ? e.time : null,
      phase: integer(e.phase) ? e.phase : null,
      params,
      dependencies: dependencies(params),
    };
  });
  const resolverType = (name) => /HOST_RESOLVER|DNS_TRANSACTION|DNS_QUERY|DNS_OVER_HTTPS|MDNS/.test(name);
  const sharedType = (name) =>
    name === "NONE" || resolverType(name) || /CERT_VERIF|PROXY|PAC_FILE/.test(name);
  const resolverEvent = (name) =>
    /HOST_RESOLVER|DNS_TRANSACTION|DNS_TASK|DNS_OVER_HTTPS|DNS_QUERY|MDNS/.test(name);
  const localEdges = new Map();
  const link = (edges, a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  for (const row of rows) {
    if (sharedType(row.sourceType) || /HOST_RESOLVER|DNS_|PROXY_|CERT_VERIFIER/.test(row.event)) continue;
    for (const id of row.dependencies) {
      const type = sourceTypes.get(identities.get(id));
      if (!type || sharedType(type)) continue;
      link(localEdges, row.id, id);
      link(localEdges, id, row.id);
    }
  }
  const walk = (edges, initial) => {
    const found = new Set(initial),
      queue = [...initial];
    for (let i = 0; i < queue.length; i++)
      for (const id of edges.get(queue[i]) ?? []) {
        if (found.has(id)) continue;
        assert(found.size < 256, "NETLOG_GRAPH_LIMIT");
        found.add(id);
        queue.push(id);
      }
    return found;
  };
  const roots = [
    ...new Set(
      rows
        .filter(
          (r) => r.sourceType === "URL_REQUEST" && /URL_REQUEST/.test(r.event) && r.params.url === publicUrl,
        )
        .map((r) => r.id),
    ),
  ];
  const local = roots.length === 1 ? walk(localEdges, roots) : new Set();
  const localAmbiguous =
    roots.length !== 1 ||
    rows.some(
      (r) =>
        local.has(r.id) &&
        r.sourceType === "URL_REQUEST" &&
        /URL_REQUEST/.test(r.event) &&
        typeof r.params.url === "string" &&
        (r.params.url !== publicUrl || r.id !== roots[0]),
    );
  const graph = new Map(),
    graphEdges = [];
  for (const row of rows) {
    if (!resolverEvent(row.event)) continue;
    for (const id of row.dependencies) {
      const otherType = sourceTypes.get(identities.get(id));
      if (!otherType) continue;
      // A resolver may be shared. Traverse into resolver nodes, never through them to another
      // request/connection or an unrelated DoH URL_REQUEST. Sharing is reported below.
      if (resolverType(otherType) && (local.has(row.id) || resolverType(row.sourceType))) {
        link(graph, row.id, id);
        graphEdges.push({ from: row.id, to: id, event: row.event, ticks: row.ticks });
      }
      if (resolverType(row.sourceType) && (local.has(id) || resolverType(otherType))) {
        link(graph, id, row.id);
        graphEdges.push({ from: id, to: row.id, event: row.event, ticks: row.ticks });
      }
    }
  }
  const reached = localAmbiguous ? new Set() : walk(graph, local);
  const associatedIds = new Set(
    [...reached].filter((id) => rows.some((r) => r.id === id && resolverEvent(r.event))),
  );
  const exactHost = (value) => {
    if (typeof value !== "string") return null;
    if (
      value === host ||
      value === `${host}:443` ||
      value === `https://${host}` ||
      value === `https://${host}:443`
    )
      return true;
    return false;
  };
  const externalAttachments = rows
    .filter((r) => associatedIds.has(r.id) && resolverType(r.sourceType))
    .flatMap((r) =>
      r.dependencies
        .filter(
          (id) => identities.has(id) && !resolverType(sourceTypes.get(identities.get(id))) && !local.has(id),
        )
        .map((id) => ({ resolverSourceId: r.id, otherSourceId: id, event: r.event, ticks: r.ticks })),
    );
  for (const row of rows) {
    if (local.has(row.id) || resolverType(row.sourceType) || !resolverEvent(row.event)) continue;
    for (const id of row.dependencies)
      if (associatedIds.has(id) && resolverType(sourceTypes.get(identities.get(id))))
        externalAttachments.push({
          resolverSourceId: id,
          otherSourceId: row.id,
          event: row.event,
          ticks: row.ticks,
        });
  }
  const addressContainers = [
    "address_list",
    "addresses",
    "endpoints",
    "endpoint_results",
    "results",
    "saved_results",
    "ip_endpoints",
    "ipv4_endpoints",
    "ipv6_endpoints",
    "ipv4_addresses",
    "ipv6_addresses",
    "service_endpoints",
  ];
  const projectAddresses = (params) => {
    const out = [],
      groups = [],
      resultGroups = [];
    let count = 0,
      containerCount = 0,
      unknownShapes = 0;
    for (const field of addressContainers) {
      if (!Object.hasOwn(params, field)) continue;
      containerCount++;
      const pending = [{ value: params[field], groupIndex: null, depth: 0 }];
      while (pending.length) {
        const entry = pending.pop();
        assert(++count <= 2048 && entry.depth <= 12, "NETLOG_ADDRESS_LIMIT");
        const ip = address(entry.value);
        if (ip) {
          out.push({ field, groupIndex: entry.groupIndex, ...ip });
          continue;
        }
        if (Array.isArray(entry.value)) {
          assert(entry.value.length <= 256, "NETLOG_ADDRESS_LIMIT");
          entry.value.forEach((v, index) =>
            pending.push({ value: v, groupIndex: entry.groupIndex ?? index, depth: entry.depth + 1 }),
          );
        } else if (record(entry.value)) {
          const obj = entry.value,
            metadata = record(obj.metadata);
          const knownKeys = [
            ...addressContainers,
            "metadata",
            "address",
            "port",
            "query_type",
            "type",
            "source",
            "domain_name",
            "timed_expiration",
            "expiration",
            "aliases",
          ];
          if (Object.keys(obj).some((key) => !knownKeys.includes(key))) unknownShapes++;
          if (Object.hasOwn(obj, "query_type"))
            resultGroups.push({
              field,
              groupIndex: entry.groupIndex,
              queryType:
                typeof obj.query_type === "string" &&
                /^(A|AAAA|HTTPS|SVCB|TXT|PTR|SRV|UNSPECIFIED)$/.test(obj.query_type)
                  ? obj.query_type
                  : null,
              resultType: ["data", "metadata", "error", "alias"].includes(obj.type) ? obj.type : null,
              resultSource: ["dns", "hosts", "unknown"].includes(obj.source) ? obj.source : null,
              domainMatchesExpected: typeof obj.domain_name === "string" ? obj.domain_name === host : null,
              originalTimedExpiration:
                typeof obj.timed_expiration === "string" && /^\d+(?:\.\d+)?$/.test(obj.timed_expiration)
                  ? obj.timed_expiration
                  : Number.isFinite(obj.timed_expiration)
                    ? obj.timed_expiration
                    : null,
            });
          if (metadata)
            groups.push({
              field,
              groupIndex: entry.groupIndex,
              supportedAlpns: Array.isArray(metadata.supported_protocol_alpns)
                ? metadata.supported_protocol_alpns
                    .filter((v) => typeof v === "string" && /^(h2|http\/1\.1|h3(?:-\d+)?)$/.test(v))
                    .slice(0, 16)
                : null,
              echConfigPresent:
                typeof metadata.ech_config_list === "string" ? metadata.ech_config_list.length > 0 : null,
              targetNameMatchesExpected:
                typeof metadata.target_name === "string" ? metadata.target_name === host : null,
            });
          // Known endpoint fields only. Do not recurse through aliases, metadata, URLs or arbitrary labels.
          for (const key of addressContainers)
            if (Object.hasOwn(obj, key))
              pending.push({ value: obj[key], groupIndex: entry.groupIndex, depth: entry.depth + 1 });
          if (typeof obj.address === "string") {
            const item = address(obj.address);
            if (item)
              out.push({
                field,
                groupIndex: entry.groupIndex,
                ...item,
                port: integer(obj.port) && obj.port <= 65535 ? obj.port : item.port,
              });
            else unknownShapes++;
          } else if (Object.hasOwn(obj, "address")) unknownShapes++;
        } else unknownShapes++;
      }
    }
    return {
      addresses: out.slice(0, 512),
      endpointGroups: groups.slice(0, 128),
      resultGroups: resultGroups.slice(0, 128),
      recognizedAddressContainerCount: containerCount,
      unknownAddressShapeCount: unknownShapes,
      addressProjectionState:
        containerCount === 0
          ? "no-recognized-container"
          : unknownShapes
            ? "partial-unknown-shapes"
            : "recognized-shapes-only",
      addressProjectionTruncated: out.length > 512 || groups.length > 128 || resultGroups.length > 128,
    };
  };
  const projectEvent = (r, attribution) => {
    const p = r.params,
      allowed = [
        "dns_query_types",
        "dns_query_type",
        "tasks",
        "secure_dns_mode",
        "secure_dns_policy",
        "source",
        "allow_cached_response",
        "is_speculative",
        "ipv6_available",
        "cached",
        "secure",
        "net_error",
        "error",
        "os_error",
      ];
    const fields = {};
    for (const key of allowed) {
      const v = p[key];
      if (typeof v === "boolean" || (typeof v === "number" && Number.isSafeInteger(v))) fields[key] = v;
      if (key === "dns_query_types" && Array.isArray(v))
        fields[key] =
          v.length <= 16 &&
          v.every((s) => typeof s === "string" && /^(A|AAAA|HTTPS|SVCB|TXT|PTR|SRV|UNSPECIFIED)$/.test(s))
            ? [...v]
            : null;
      if (key === "tasks" && Array.isArray(v))
        fields[key] = v.length <= 32 && v.every(integer) ? [...v] : null;
      if (
        key === "dns_query_type" &&
        typeof v === "string" &&
        /^(A|AAAA|HTTPS|SVCB|TXT|PTR|SRV|UNSPECIFIED)$/.test(v)
      )
        fields[key] = v;
    }
    if (Object.hasOwn(p, "transactions_needed"))
      fields.transactions_needed =
        Array.isArray(p.transactions_needed) && p.transactions_needed.length <= 16
          ? p.transactions_needed.map((v) =>
              typeof v?.dns_query_type === "string" &&
              /^(A|AAAA|HTTPS|SVCB|TXT|PTR|SRV|UNSPECIFIED)$/.test(v.dns_query_type)
                ? v.dns_query_type
                : null,
            )
          : null;
    return {
      sourceId: r.id,
      sourceType: r.sourceType,
      event: r.event,
      timeTicks: r.ticks,
      phase: r.phase,
      attribution,
      explicitHostMatchesExpected: exactHost(p.host),
      parameterFieldNames: Object.keys(p)
        .filter((key) => /^[a-z][a-z0-9_]{0,63}$/.test(key))
        .sort()
        .slice(0, 32),
      parameterFieldNamesOmitted:
        Object.keys(p).filter((key) => !/^[a-z][a-z0-9_]{0,63}$/.test(key)).length +
        Math.max(0, Object.keys(p).filter((key) => /^[a-z][a-z0-9_]{0,63}$/.test(key)).length - 32),
      fields,
      responseShape: {
        hasFailureResult: Object.hasOwn(p, "failure_result"),
        hasSavedResults: Object.hasOwn(p, "saved_results"),
        hasAddressList: Object.hasOwn(p, "address_list"),
        hasResults: Object.hasOwn(p, "results"),
        isIncrementalUpdate: /SERVICE_ENDPOINTS_UPDATED/.test(r.event),
        isStaleObservation: /STALE_RESULTS/.test(r.event),
        terminalShape:
          r.phase !== 2
            ? "not-an-end-event"
            : Object.hasOwn(p, "failure_result") || (typeof p.net_error === "number" && p.net_error !== 0)
              ? "reported-failure"
              : Object.hasOwn(p, "address_list") || Object.hasOwn(p, "results")
                ? "returned-result-payload"
                : "no-returned-result-payload",
      },
      ...projectAddresses(p),
      relatedDependencies: r.dependencies.filter((id) => reached.has(id)),
    };
  };
  const events = rows
    .filter((r) => associatedIds.has(r.id) && resolverEvent(r.event))
    .map((r) =>
      projectEvent(r, local.has(r.id) ? "request-local-source" : "request-dependency-resolver-node"),
    );
  const globalReachability = rows
    .filter((r) => r.event === "HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK" && !associatedIds.has(r.id))
    .map((r) => projectEvent(r, "unattributed-process-observation"));
  const hostConflict = events.some((e) => e.explicitHostMatchesExpected === false);
  const socket = parseSocket(text, { host, port: 443 });
  return {
    graphProjectionVersion: "clipdock-normal-resolver-observation-v1",
    request: {
      exactRootCount: roots.length,
      rootId: roots.length === 1 ? roots[0] : null,
      associated: !localAmbiguous,
      requestLocalSourceIds: [...local].sort((a, b) => a - b),
    },
    resolver: {
      associated: !localAmbiguous && events.length > 0 && !hostConflict,
      basis: "observed-source-type-and-dependency-edges; no host-only or global-event fallback",
      sourceIds: [...associatedIds].sort((a, b) => a - b),
      hostConflict,
      sharedWithOtherRequestOrSource: externalAttachments.length > 0,
      externalAttachments,
      edges: graphEdges.filter((e) => reached.has(e.from) && reached.has(e.to)),
      events,
    },
    socket: socket.available
      ? {
          available: true,
          basis: "exact-request-netlog-tcp-graph; Windows owner not sampled here",
          rootId: socket.observation.rootId,
          socketSourceId: socket.observation.socketSourceId,
          evidenceId: socket.observation.evidenceId,
          source: address(
            `${net.isIP(socket.observation.tuple.sourceAddress) === 6 ? `[${socket.observation.tuple.sourceAddress}]` : socket.observation.tuple.sourceAddress}:${socket.observation.tuple.sourcePort}`,
          ),
          remote: address(
            `${net.isIP(socket.observation.tuple.remoteAddress) === 6 ? `[${socket.observation.tuple.remoteAddress}]` : socket.observation.tuple.remoteAddress}:${socket.observation.tuple.remotePort}`,
          ),
        }
      : socket,
    unattributedIpv6Reachability: globalReachability,
    limits: [
      "NetLog ticks remain original strings; not converted to performance.now or renewed TTL.",
      "A dependency-linked shared resolver job is participation, not exclusive ownership.",
      "cached IPv6 reachability is an observed instant; never an ongoing single-family permission.",
      "cached:false may log last_ipv6_probe_result before the async probe completes; its tick is not the completion tick.",
      "JOB query types are planned types; DNS_TASK transactions_needed reflects its actual task, and endpoint updates can be incremental or stale.",
      "Returned endpoint families and the selected TCP socket family are separate facts.",
      "An empty address projection is not proof of no AAAA: inspect container presence, unknown shapes and all task/end events.",
      "No DNS-server, DIRECT, kernel mapping, physical route or business applicability is inferred.",
    ],
  };
}

function localChecks(parseSocket) {
  const types = {
    URL_REQUEST_START_JOB: 1,
    HTTP_STREAM_JOB_BOUND_TO_REQUEST: 2,
    SOCKET_POOL_BOUND_TO_SOCKET: 3,
    TCP_CONNECT: 4,
    SOCKET_ALIVE: 5,
    HOST_RESOLVER_MANAGER_REQUEST: 6,
    HOST_RESOLVER_MANAGER_JOB_ATTACH: 7,
    HOST_RESOLVER_MANAGER_JOB: 8,
    HOST_RESOLVER_SYSTEM_TASK: 9,
    HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK: 10,
    HOST_RESOLVER_MANAGER_TASK_SEQUENCE_CREATED: 11,
    HOST_RESOLVER_DNS_TASK: 12,
  };
  const event = (id, sourceType, type, params, phase = 0) => ({
    source: { id, type: sourceType },
    type,
    params,
    phase,
    time: "123456.7",
  });
  const fixture = () => ({
    constants: {
      logEventTypes: types,
      logSourceType: { URL_REQUEST: 1, HTTP_STREAM_JOB: 2, SOCKET: 3, HOST_RESOLVER_IMPL_JOB: 4, NONE: 5 },
    },
    events: [
      event(1, 1, 1, { url: publicUrl }),
      event(2, 2, 2, { source_dependency: { id: 1 } }),
      event(2, 2, 3, { source_dependency: { id: 3 } }),
      event(3, 3, 4, { address_list: ["198.18.0.1:443"] }),
      event(3, 3, 5, { source_address: "192.0.2.1:54321" }),
      event(2, 2, 6, { host: `${host}:443`, dns_query_type: "UNSPECIFIED" }, 1),
      event(2, 2, 7, { source_dependency: { id: 4 } }),
      event(
        4,
        4,
        8,
        {
          host: `${host}:443`,
          dns_query_types: ["A", "AAAA", "HTTPS"],
          tasks: [0, 1],
          secure_dns_mode: 0,
          source_dependency: { id: 2 },
        },
        1,
      ),
      event(
        4,
        4,
        9,
        { address_list: ["198.18.0.1:443", "[2001:db8::1]:443"], aliases: ["sensitive-alias.example"] },
        2,
      ),
      event(
        4,
        4,
        8,
        {
          endpoint_results: [
            {
              ip_endpoints: ["[2001:db8::1]:443"],
              metadata: {
                supported_protocol_alpns: ["h2"],
                ech_config_list: "sensitive-ech",
                target_name: host,
              },
            },
          ],
        },
        2,
      ),
      event(
        4,
        4,
        12,
        { secure: false, transactions_needed: [{ dns_query_type: "A" }, { dns_query_type: "HTTPS" }] },
        1,
      ),
      event(
        4,
        4,
        12,
        {
          results: [
            {
              domain_name: host,
              query_type: "HTTPS",
              type: "data",
              source: "dns",
              timed_expiration: "12345678",
              endpoints: [{ address: "2001:db8::1", port: 443 }],
            },
          ],
        },
        2,
      ),
      event(2, 2, 10, { ipv6_available: false, cached: true }),
      event(2, 2, 11, { tasks: [1] }),
      event(90, 5, 10, { ipv6_available: true, cached: false }),
    ],
  });
  let count = 0;
  const project = (v) => resolverProjection(JSON.stringify(v), parseSocket);
  const first = project(fixture());
  assert(
    first.request.associated && first.resolver.associated && first.socket.available,
    "LOCAL_GRAPH_FAILED",
  );
  count++;
  assert(
    first.resolver.events.some((e) => e.fields.dns_query_types?.includes("HTTPS")) &&
      first.resolver.events.some((e) => e.addresses.some((a) => a.family === "ipv6")) &&
      first.resolver.events.some((e) => e.endpointGroups.length > 0) &&
      first.resolver.events.some(
        (e) => e.fields.secure === false && e.fields.transactions_needed?.includes("HTTPS"),
      ) &&
      first.resolver.events.some((e) =>
        e.resultGroups.some((g) => g.queryType === "HTTPS" && g.originalTimedExpiration === "12345678"),
      ),
    "LOCAL_ENDPOINT_PROJECTION_FAILED",
  );
  count++;
  assert(
    first.unattributedIpv6Reachability.length === 1 &&
      first.unattributedIpv6Reachability[0].fields.ipv6_available &&
      first.resolver.events.some(
        (e) => e.fields.ipv6_available === false && e.fields.cached === true && e.timeTicks === "123456.7",
      ),
    "LOCAL_GLOBAL_SIGNAL_MIXED",
  );
  count++;
  assert(
    !/198\.18\.0\.1|2001:db8|sensitive-|robots\.txt/.test(JSON.stringify(first)),
    "LOCAL_REDACTION_FAILED",
  );
  count++;
  const unrelated = fixture();
  unrelated.events = unrelated.events.filter((e) => e.type !== 7 && e.type !== 8);
  const orphan = project(unrelated);
  assert(!orphan.resolver.events.some((e) => e.sourceId === 4), "LOCAL_ORPHAN_RESOLVER_JOINED");
  count++;
  const ambiguous = fixture();
  ambiguous.events.push(event(99, 1, 1, { url: publicUrl }));
  const second = project(ambiguous);
  assert(
    !second.request.associated && !second.resolver.associated && !second.socket.available,
    "LOCAL_AMBIGUOUS_REQUEST_ACCEPTED",
  );
  count++;
  const conflict = fixture();
  conflict.events.find((e) => e.type === 8).params.host = "foreign.example:443";
  assert(!project(conflict).resolver.associated, "LOCAL_CONFLICTING_HOST_ACCEPTED");
  count++;
  const shared = fixture();
  shared.events.push(
    event(91, 2, 6, { host: `${host}:443` }),
    event(4, 4, 7, { source_dependency: { id: 91 } }),
  );
  const sharedResult = project(shared);
  assert(
    sharedResult.resolver.sharedWithOtherRequestOrSource && !sharedResult.resolver.sourceIds.includes(91),
    "LOCAL_SHARED_JOB_ESCAPED_TO_OTHER_REQUEST",
  );
  count++;
  const reverseShared = fixture();
  reverseShared.events.push(
    event(91, 2, 6, { host: `${host}:443` }),
    event(91, 2, 7, { source_dependency: { id: 4 } }),
  );
  const reverseResult = project(reverseShared);
  assert(
    reverseResult.resolver.sharedWithOtherRequestOrSource && !reverseResult.resolver.sourceIds.includes(91),
    "LOCAL_REVERSE_SHARED_ATTACHMENT_MISSED",
  );
  count++;
  const unknownAddress = fixture();
  unknownAddress.events.find((e) => e.type === 9).params.address_list = [
    { future_address_shape: "sensitive-unknown-ip" },
  ];
  const unknownResult = project(unknownAddress);
  assert(
    unknownResult.resolver.events.some(
      (e) => e.parameterFieldNames.includes("address_list") && e.unknownAddressShapeCount > 0,
    ) && !JSON.stringify(unknownResult).includes("sensitive-unknown-ip"),
    "LOCAL_UNKNOWN_ADDRESS_HIDDEN",
  );
  count++;
  if (api6) {
    const wrongPath = fixture();
    wrongPath.events[0].params.url = `https://${host}/robots.txt`;
    assert(
      !parseSocket(JSON.stringify(wrongPath), { host, port: 443 }).available,
      "LOCAL_API6_WRONG_PATH_ACCEPTED",
    );
    count++;
    assert(
      !parseSocket(JSON.stringify(fixture()), { host: "other.example", port: 443 }).available,
      "LOCAL_API6_OTHER_HOST_ACCEPTED",
    );
    count++;
    const ip = "2001:db8::abcd";
    const projected = projectFactoryResult({
      available: true,
      observation: {
        factoryId: "clipdock-anonymous-egress-v1",
        source: "ipify-ipv6",
        ip,
        reportedAddressFamily: "ipv6",
        countryCode: "CN",
        asn: 1,
        transportContextId: "local-redaction-fixture",
        startedAtMono: 1,
        observedAtMono: 2,
        completedAtMono: 3,
        echo: { origin: { host, port: 443 } },
        geo: { origin: { host: "ipwho.is", port: 443 } },
      },
    });
    assert(
      !JSON.stringify(projected).includes(ip) && projected.observation.reportedAddressHash === sha(ip),
      "LOCAL_EGRESS_IP_PROJECTION_FAILED",
    );
    count++;
  }
  return count;
}

let lastResort = () => {};
if (!process.versions.electron) await parent();
else
  void child().catch((error) => {
    lastResort(error);
    process.exit(1);
  });

async function parent() {
  assert(
    process.argv.slice(2).every((arg) => ["--run-once", "--build-only", "--api6"].includes(arg)) &&
      !(run && process.argv.includes("--build-only")),
    "INVALID_ARGUMENT",
  );
  const { build } = await import("esbuild"),
    { default: electron } = await import("electron");
  const temporaryParent = path.resolve(root, "docs/.compare");
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryParent, "normal-resolver-observation-"));
  const report = path.join(
    root,
    `docs/network-normal-resolver-observation.${new Date().toISOString().replace(/[-:.]/g, "")}.results.json`,
  );
  let result;
  try {
    const selectedParser = parserSource();
    const common = {
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["electron", "node:*"],
      tsconfig: path.join(root, "tsconfig.electron.json"),
      logLevel: "silent",
    };
    await build({
      ...common,
      stdin: {
        contents: selectedParser.contents,
        resolveDir: path.join(root, "src/main/network"),
        loader: "ts",
      },
      outfile: path.join(temporary, "parser.mjs"),
    });
    const parser = await import(pathToFileURL(path.join(temporary, "parser.mjs")).href);
    const checks = localChecks(parser.parseAnonymousRequestSocket);
    const built = await build({
      ...common,
      stdin: {
        contents: [
          selectedParser.contents,
          api6
            ? "export {AnonymousEgressProbe} from './anonymous-egress-probe.ts';"
            : "export {AnonymousProofProbe} from './anonymous-proof-probe.ts';",
          "export {AnonymousNetLogCapture} from './anonymous-netlog-capture.ts';",
          "export {ClashReader} from './clash-reader.ts';",
          "export {evaluateRules} from './rules.ts';",
          "export {configureChromiumTransport,readChromiumTransportState} from './chromium-transport.ts';",
        ].join("\n"),
        resolveDir: path.join(root, "src/main/network"),
        loader: "ts",
      },
      outfile: path.join(temporary, "production.mjs"),
      metafile: true,
    });
    const hashes = Object.fromEntries(
      Object.keys(built.metafile.inputs)
        .filter((name) => name.startsWith("src/"))
        .map((name) => [name, sha(fs.readFileSync(path.join(root, name)))]),
    );
    hashes[selectedParser.filename] = sha(selectedParser.original);
    if (!run) {
      console.log(
        JSON.stringify({
          buildOnly: true,
          mode: api6 ? "api6-echo" : "bilibili-robots",
          localChecks: checks,
          productionSourceCount: Object.keys(hashes).length,
          publicRequestsIssued: 0,
          controllerRequests: 0,
          resolveHostCalls: 0,
          accountSessions: 0,
        }),
      );
      return;
    }
    const env = { ...process.env, CLIPDOCK_NORMAL_RESOLVER_ROOT: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, "--run-once", ...(api6 ? ["--api6"] : [])], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    let watchdog = false;
    const timer = setTimeout(() => {
      watchdog = true;
      worker.kill();
    }, 35000);
    const code = await new Promise((resolve) => {
      worker.once("error", () => resolve(1));
      worker.once("exit", (value) => resolve(value ?? 1));
    });
    clearTimeout(timer);
    const checkpoint = path.join(temporary, "result.json");
    result = fs.existsSync(checkpoint)
      ? JSON.parse(fs.readFileSync(checkpoint, "utf8"))
      : { failure: "CHILD_RESULT_MISSING", requestCountUnavailable: true };
    Object.assign(result, {
      childExitCode: code,
      parentWatchdogFired: watchdog,
      scriptHash: sha(fs.readFileSync(script)),
      sourceHashes: hashes,
      bundleHash: sha(fs.readFileSync(path.join(temporary, "production.mjs"))),
      localChecks: checks,
      parserSourceHash: sha(selectedParser.original),
      privateEchoParserAdapterHash: selectedParser.adapted ? sha(selectedParser.adapted) : null,
      parserAdaptation: api6
        ? "one exact fixed-root-URL replacement; original NetLog unchanged"
        : "unmodified production robots parser",
      sourceHashesStable: Object.entries(hashes).every(
        ([name, hash]) => sha(fs.readFileSync(path.join(root, name))) === hash,
      ),
    });
  } finally {
    const exact = path.resolve(temporary);
    assert(
      path.dirname(exact) === temporaryParent &&
        path.basename(exact).startsWith("normal-resolver-observation-"),
      "UNSAFE_TEMPORARY_PATH",
    );
    assert(fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), "TEMPORARY_PATH_CHANGED");
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      fs.rmSync(exact, { recursive: true });
    } catch {
      /* Exact owned directory only; no retry. */
    }
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (result) {
    result.executionCompleted = Boolean(
      result.childExitCode === 0 &&
      !result.failure &&
      !result.parentWatchdogFired &&
      result.sourceHashesStable &&
      result.rawTemporaryDataRemoved &&
      result.cleanup?.drained,
    );
    fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    console.log(
      JSON.stringify(
        {
          report: path.relative(root, report),
          executionCompleted: result.executionCompleted,
          factoryResult: result.factoryResult,
          request: result.resolverObservation?.request,
          resolverAssociated: result.resolverObservation?.resolver?.associated ?? null,
          socket: result.resolverObservation?.socket,
          failure: result.failure ?? null,
          cleanup: result.cleanup,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.executionCompleted ? 0 : 1;
  }
}

async function child() {
  const { app, session, BrowserWindow, webContents } = await import("electron");
  const temporary = process.env.CLIPDOCK_NORMAL_RESOLVER_ROOT;
  assert(
    run &&
      temporary &&
      path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
      path.basename(temporary).startsWith("normal-resolver-observation-"),
    "ISOLATION_REQUIRED",
  );
  app.setPath("userData", path.join(temporary, "userData"));
  app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-background-networking");
  app.commandLine.appendSwitch("disable-component-update");
  app.on("window-all-closed", () => {});
  const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
  production.configureChromiumTransport(app);
  const result = {
    kind: "normal-resolver-observation",
    mode: api6 ? "api6-echo" : "bilibili-robots",
    executedAt: new Date().toISOString(),
    origin: { host, port: 443 },
    runtime: {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      transport: production.readChromiumTransportState(app),
    },
    isolation: {
      temporaryProfile: true,
      accountData: false,
      bootstrap: false,
      rawNetLogPersisted: false,
      rawIpPersisted: false,
      rawUrlPathQueryPersisted: false,
      factoryPatched: false,
      resolverOverride: false,
      resolveHostPrewarm: false,
      kernelDnsPrewarm: false,
      normalDns: true,
      productionDeadlineMs: api6 ? 12000 : 8000,
      netLogScope: api6 ? "echo-only; geography is never logged" : "single-robots-request",
      configurationChanged: false,
      qualificationGranted: false,
      familyConstraintProduced: false,
    },
    counts: {
      factoryCalls: 0,
      publicHeaderSends: 0,
      echoHeaderSends: 0,
      geoHeaderSends: 0,
      anonymousSessions: 0,
      unexpectedRequests: 0,
      controllerReads: 0,
      resolveHostCalls: 0,
      windowsCreated: 0,
      webContentsCreated: 0,
    },
    controller: [],
    observer: [],
    networkErrors: [],
    factoryResult: null,
    resolverObservation: null,
  };
  const checkpoint = (phase) => {
    result.phase = phase;
    result.checkpointAtMono = performance.now();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result));
  };
  lastResort = (error) => {
    result.failure = safeError(error);
    try {
      checkpoint("top-level-failure");
    } catch {
      /* Parent handles missing checkpoint. */
    }
  };
  const abort = new AbortController();
  let probe,
    capture,
    collecting = false,
    activeStage = null,
    revoked = false,
    finished = false;
  const quiet = () =>
    !revoked &&
    !abort.signal.aborted &&
    BrowserWindow.getAllWindows().length === 0 &&
    webContents.getAllWebContents().length === 0 &&
    path.resolve(app.getPath("userData")) === path.resolve(temporary, "userData");
  const revoke = () => {
    revoked = true;
    abort.abort();
  };
  const guard = (signal) => assert(quiet() && !signal?.aborted, "EXPERIMENT_CANCELLED");
  app.on("browser-window-created", () => {
    result.counts.windowsCreated++;
    revoke();
  });
  app.on("web-contents-created", () => {
    result.counts.webContentsCreated++;
    revoke();
  });
  const timer = setTimeout(() => {
    result.failure = "EXPERIMENT_TIMEOUT";
    revoke();
    checkpoint("deadline");
  }, 25000);
  checkpoint("startup");
  try {
    await app.whenReady();
    assert(process.platform === "win32" && process.versions.electron === "43.3.0", "UNSUPPORTED_RUNTIME");
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    guard();
    app.on("session-created", (created) => {
      if (!collecting || created.storagePath !== null || result.counts.anonymousSessions !== 0) {
        revoke();
        return;
      }
      result.counts.anonymousSessions++;
      created.webRequest.onSendHeaders((details) => {
        let targetAllowed = activeStage === "echo" && details.url === publicUrl;
        if (api6 && activeStage === "geo") {
          try {
            const url = new URL(details.url);
            targetAllowed =
              url.protocol === "https:" &&
              url.hostname === "ipwho.is" &&
              !url.port &&
              !url.search &&
              !url.username &&
              !url.password &&
              canonicalIp(decodeURIComponent(url.pathname.slice(1))) !== null;
          } catch {
            targetAllowed = false;
          }
        }
        const key = activeStage === "geo" ? "geoHeaderSends" : "echoHeaderSends";
        const valid =
          quiet() &&
          targetAllowed &&
          details.method === "GET" &&
          !Object.keys(details.requestHeaders).some((key) => /cookie|authorization/i.test(key)) &&
          result.counts[key] === 0 &&
          result.counts.publicHeaderSends < (api6 ? 2 : 1);
        result.counts.publicHeaderSends++;
        result.counts[key]++;
        if (!valid) {
          result.counts.unexpectedRequests++;
          revoke();
        }
        checkpoint(valid ? "anonymous-headers-sent" : "unexpected-request");
      });
      created.webRequest.onErrorOccurred((details) => {
        const error = /^net::ERR_[A-Z_]+$/.test(details.error ?? "") ? details.error : "REQUEST_FAILED";
        result.networkErrors.push({ stage: activeStage, error });
        result.networkError = error;
        checkpoint("request-error");
      });
    });
    const reader = new production.ClashReader({ controllerUrl, getSecret: () => null });
    let fingerprint = null;
    const readController = async (phase) => {
      guard();
      result.counts.controllerReads++;
      const value = await reader.read();
      guard();
      const decision = production.evaluateRules(value.mode, value.rules, {
        host,
        port: 443,
        network: "tcp",
        destination: { stage: "unknown" },
      });
      result.controller.push({
        phase,
        startedAtMono: value.startedAtMono,
        completedAtMono: value.completedAtMono,
        mode: value.mode,
        tun: value.tun,
        version: value.version,
        fingerprint: value.fingerprint,
        ruleCount: value.rules.length,
        rulesDigest: sha(JSON.stringify(value.rules)),
        decision,
      });
      checkpoint("controller-read");
      assert(value.mode === "rule" && value.tun && decision.route === "direct", "CURRENT_ROUTE_UNVERIFIABLE");
      assert(fingerprint === null || value.fingerprint === fingerprint, "CONTROLLER_CHANGED");
      fingerprint = value.fingerprint;
    };
    await readController("before");
    capture = new production.AnonymousNetLogCapture({ isQuiescent: quiet, temporaryRoot: temporary });
    // Preserve each real factory's defaults: TLS 8s; echo+geography together 12s.
    probe = api6 ? new production.AnonymousEgressProbe() : new production.AnonymousProofProbe();
    const finishCapture = async (context) => {
      if (finished) return;
      finished = true;
      const text = await capture.finish(context.signal);
      guard(context.signal);
      // finish has removed the original file; project only in private memory, never rewrite it.
      result.resolverObservation = resolverProjection(text, production.parseAnonymousRequestSocket);
      checkpoint("resolver-projected");
    };
    collecting = true;
    result.counts.factoryCalls++;
    const hooks = {
      beforeSend: async (context) => {
        guard(context.signal);
        const stage = api6 ? context.stage : "echo";
        assert(
          (stage === "echo" || (api6 && stage === "geo")) &&
            context.origin.host === (stage === "geo" ? "ipwho.is" : host) &&
            context.origin.port === 443,
          "WRONG_FACTORY_ORIGIN",
        );
        activeStage = stage;
        result.observer.push({
          boundary: "beforeSend",
          stage,
          atMono: performance.now(),
          factoryId: context.factoryId,
          transportContextId: context.transportContextId,
        });
        if (stage === "echo") await capture.start(context.trace.netLog, context.signal);
        guard(context.signal);
        checkpoint(stage === "echo" ? "capture-started" : "geo-before-send");
      },
      headers: async (context, timing) => {
        guard(context.signal);
        const stage = api6 ? context.stage : "echo";
        result.observer.push({ boundary: "headers", stage, ...timing });
        if (stage === "echo") await finishCapture(context);
      },
      cleanup: async (context) => {
        const stage = api6 ? context.stage : "echo";
        // A normal request error may still leave useful resolver facts. A revoked capture does
        // not permit recovery with another signal or an extended deadline.
        if (stage === "echo" && !finished && !context.signal.aborted) {
          try {
            await finishCapture(context);
          } catch (error) {
            result.projectionFailure = safeError(error);
          }
        }
        if (stage === "echo") {
          await capture.dispose();
          await capture.whenIdle();
        }
        activeStage = null;
        result.observer.push({ boundary: "cleanup", stage, atMono: performance.now() });
        checkpoint(stage === "echo" ? "capture-cleaned" : "geo-cleaned");
      },
    };
    const sample = api6
      ? await probe.probe("ipify-ipv6", abort.signal, hooks)
      : await probe.probeTls({ host, port: 443 }, abort.signal, hooks);
    await probe.whenIdle();
    collecting = false;
    result.factoryResult = projectFactoryResult(sample);
    checkpoint("factory-completed");
    await readController("after");
    assert(
      result.counts.factoryCalls === 1 &&
        result.counts.publicHeaderSends <= (api6 ? 2 : 1) &&
        result.counts.echoHeaderSends <= 1 &&
        result.counts.geoHeaderSends <= (api6 ? 1 : 0) &&
        result.counts.unexpectedRequests === 0,
      "REQUEST_BUDGET_EXCEEDED",
    );
  } catch (error) {
    result.failure = safeError(error);
    checkpoint("failed");
  } finally {
    clearTimeout(timer);
    abort.abort();
    collecting = false;
    const drain = await bounded(
      Promise.allSettled([probe?.dispose(), probe?.whenIdle(), capture?.dispose(), capture?.whenIdle()]),
      8000,
    ).catch(() => null);
    result.cleanup = {
      drained: !!drain && drain.every((r) => r.status === "fulfilled"),
      windows: BrowserWindow.getAllWindows().length,
      webContents: webContents.getAllWebContents().length,
    };
    checkpoint("finished");
    app.exit(result.failure || !result.cleanup.drained ? 1 : 0);
  }
}
