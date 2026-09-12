/** Loopback-only DIRECT dialer experiment. No selected configuration, OS or production code writes. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const binary =
  "C:/Users/Administrator/AppData/Local/Programs/MAOMAOYUNAPP/resources/extra/mihomo-windows-386.exe";
const expectedHash = "d354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9";
const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
const output = path.join(root, `docs/network-mihomo-direct-family-compatibility.${stamp}.results.json`);
const parent = path.join(root, "docs/.compare");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fact(condition, code) {
  if (!condition) throw new Error(code);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loopback = (address) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const result = {
  kind: "isolated-mihomo-direct-family-compatibility",
  startedAt: new Date().toISOString(),
  scriptHash: hash(fs.readFileSync(script)),
  binaryHashBefore: null,
  binaryHashAfter: null,
  binaryStable: false,
  qualificationGranted: false,
  completed: false,
  failure: null,
  isolation: {
    tunEnabled: false,
    modifiedSelectedConfiguration: false,
    modifiedSystemDns: false,
    modifiedSystemProxy: false,
    modifiedOsRoutes: false,
    accountDataUsed: false,
    publicTestRequests: 0,
    onlyOwnedChildrenTerminated: true,
    input: "loopback-socks5-domain-or-literal",
    chromiumUsed: false,
  },
  endpoints: {},
  ipv6Capability: null,
  ipv4RefusalControl: null,
  configurations: [],
  cases: [],
  receiverEvents: [],
  processes: [],
  checks: [],
  counters: {
    upstreamUdp: 0,
    upstreamTcp: 0,
    unexpectedDns: 0,
    downloadRequests: 0,
    controllerReadiness: 0,
    socksConnects: 0,
  },
  cleanup: {
    childrenExited: false,
    residualOwnedPids: [],
    localSocketsClosed: false,
    localServersClosed: false,
    temporaryRemoved: false,
    errors: [],
  },
};
const children = new Map();
const servers = new Set();
const sockets = new Set();
const dnsRecords = new Map();
const tokens = new Map();
let temporary;
let fatal = null;
let currentCase = null;
let watchdog;
function save() {
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
}
function check(name, passed) {
  result.checks.push({ name, passed: Boolean(passed) });
}
function interrupt(code) {
  fatal ??= code;
  for (const child of children.keys()) if (child.exitCode === null) child.kill();
  for (const socket of sockets) socket.destroy();
}
function tracked(socket) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  return socket;
}
async function bind(server, host = "127.0.0.1", port = 0) {
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    const bound = () => {
      server.removeListener("error", failed);
      resolve();
    };
    if (server instanceof dgram.Socket) server.bind(port, host, bound);
    else server.listen({ port, host, ipv6Only: host === "::1" }, bound);
  });
  server.on("error", () => interrupt("LOCAL_SERVER_ERROR"));
  servers.add(server);
  return server.address().port;
}
async function closeServer(server) {
  await new Promise((resolve, reject) => {
    try {
      server.close((error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
  servers.delete(server);
}
async function allocatePort() {
  const server = net.createServer();
  const port = await bind(server);
  await closeServer(server);
  return port;
}
function nameAt(buffer, start) {
  const labels = [];
  const seen = new Set();
  let offset = start;
  let end;
  for (let i = 0; i < 128; i++) {
    fact(offset < buffer.length && !seen.has(offset), "DNS_NAME_INVALID");
    seen.add(offset);
    const size = buffer[offset++];
    if (size === 0) return { name: labels.join(".").toLowerCase(), end: end ?? offset };
    if ((size & 0xc0) === 0xc0) {
      fact(offset < buffer.length, "DNS_POINTER_INVALID");
      end ??= offset + 1;
      offset = ((size & 0x3f) << 8) | buffer[offset];
      continue;
    }
    fact(size <= 63 && offset + size <= buffer.length, "DNS_LABEL_INVALID");
    labels.push(buffer.subarray(offset, offset + size).toString("ascii"));
    offset += size;
  }
  throw new Error("DNS_NAME_LIMIT");
}
function dnsResponse(buffer, transport) {
  fact(buffer.length >= 12 && buffer.readUInt16BE(4) === 1, "DNS_QUESTION_INVALID");
  const name = nameAt(buffer, 12);
  fact(name.end + 4 <= buffer.length, "DNS_QUESTION_SHORT");
  const type = buffer.readUInt16BE(name.end),
    end = name.end + 4;
  const record = dnsRecords.get(name.name);
  result.counters[transport === "udp" ? "upstreamUdp" : "upstreamTcp"]++;
  if (!record || ![1, 28].includes(type) || buffer.readUInt16BE(name.end + 2) !== 1) {
    result.counters.unexpectedDns++;
    interrupt("UNEXPECTED_DNS_REQUEST");
    const refused = Buffer.from(buffer.subarray(0, end));
    refused.writeUInt16BE(0x8185, 2);
    return refused;
  }
  const address = type === 1 ? record.a : record.aaaa;
  const header = Buffer.from(buffer.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(address ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  currentCase?.dns.push({
    transport,
    name: name.name,
    type,
    address: address ?? null,
    ttl: address ? 30 : null,
    atMono: performance.now(),
  });
  if (!address) return Buffer.concat([header, buffer.subarray(12, end)]);
  fact(address === "127.0.0.1" || address === "::1", "DNS_NONLOCAL_ANSWER");
  const data =
    type === 1 ? Buffer.from([127, 0, 0, 1]) : Buffer.from("00000000000000000000000000000001", "hex");
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0);
  answer.writeUInt16BE(type, 2);
  answer.writeUInt16BE(1, 4);
  answer.writeUInt32BE(30, 6);
  answer.writeUInt16BE(data.length, 10);
  return Buffer.concat([header, buffer.subarray(12, end), answer, data]);
}
function receiver() {
  return net.createServer((socket) => {
    tracked(socket);
    socket.setTimeout(2000, () => socket.destroy());
    const event = {
      acceptedAtMono: performance.now(),
      caseId: null,
      acknowledged: false,
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      localFamily: socket.localFamily,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      remoteFamily: socket.remoteFamily,
    };
    result.receiverEvents.push(event);
    if (!loopback(socket.remoteAddress)) {
      interrupt("RECEIVER_NONLOCAL");
      return;
    }
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("ascii");
      if (text.length > 256) {
        interrupt("RECEIVER_DATA_LIMIT");
        return;
      }
      if (!text.endsWith("\n")) return;
      const expected = tokens.get(text);
      if (!expected || event.acknowledged) {
        interrupt("RECEIVER_TOKEN_UNKNOWN");
        return;
      }
      event.caseId = expected.caseId;
      event.acknowledged = true;
      event.receivedAtMono = performance.now();
      expected.events.push(event);
      socket.end(expected.response);
    });
  });
}
class BufferedSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.error = null;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > 8192) {
        this.fail(new Error("SOCKET_DATA_LIMIT"));
        socket.destroy();
      }
      this.flush();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("SOCKET_CLOSED")));
  }
  fail(error) {
    this.error ??= error;
    this.flush();
  }
  flush() {
    const pending = this.pending;
    if (!pending) return;
    if (this.buffer.length >= pending.count) {
      this.pending = null;
      const out = this.buffer.subarray(0, pending.count);
      this.buffer = this.buffer.subarray(pending.count);
      pending.resolve(out);
    } else if (this.error) {
      this.pending = null;
      pending.reject(this.error);
    }
  }
  read(count) {
    fact(!this.pending, "SOCKET_CONCURRENT_READ");
    return new Promise((resolve, reject) => {
      this.pending = { count, resolve, reject };
      this.flush();
    });
  }
}
async function connectSocket(address, port, timeoutMs) {
  fact(loopback(address), "CLIENT_NONLOCAL");
  const socket = tracked(new net.Socket());
  const reader = new BufferedSocket(socket);
  const timer = setTimeout(() => socket.destroy(new Error("DIAL_TIMEOUT")), timeoutMs);
  socket.once("close", () => clearTimeout(timer));
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    socket.once("error", failed);
    socket.connect({ host: address, port, family: net.isIP(address) }, () => {
      socket.removeListener("error", failed);
      resolve();
    });
  });
  return { socket, reader };
}
async function socketClose(socket) {
  if (!sockets.has(socket)) return;
  await new Promise((resolve) => {
    socket.once("close", resolve);
    socket.destroy();
  });
}
async function directControl(address, port, id) {
  const token = `clipdock-dial-v1:${crypto.randomUUID()}\n`,
    response = Buffer.from(`ok:${id}\n`);
  const record = { caseId: id, response, events: [] };
  tokens.set(token, record);
  let link;
  try {
    link = await connectSocket(address, port, 1500);
    link.socket.write(token);
    const body = await link.reader.read(response.length);
    fact(body.equals(response), "CONTROL_BODY_MISMATCH");
    return { available: true, address, port, events: record.events };
  } catch (error) {
    return {
      available: false,
      address,
      port,
      reason: /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "LOCAL_CONTROL_FAILED",
    };
  } finally {
    if (link) await socketClose(link.socket);
    tokens.delete(token);
  }
}
async function socksAttempt(socksPort, input, record) {
  let link;
  const token = `clipdock-dial-v1:${crypto.randomUUID()}\n`;
  const response = Buffer.from(`ok:${record.id}\n`);
  const expected = { caseId: record.id, response, events: [] };
  tokens.set(token, expected);
  record.startedAtMono = performance.now();
  try {
    result.counters.socksConnects++;
    link = await connectSocket("127.0.0.1", socksPort, 6500);
    link.socket.write(Buffer.from([5, 1, 0]));
    fact((await link.reader.read(2)).equals(Buffer.from([5, 0])), "SOCKS_METHOD_INVALID");
    let destination;
    if (input.kind === "domain") {
      fact(dnsRecords.has(input.host), "SOCKS_DOMAIN_UNREVIEWED");
      const host = Buffer.from(input.host, "ascii");
      destination = Buffer.concat([Buffer.from([3, host.length]), host]);
    } else {
      fact(input.host === "::1", "SOCKS_LITERAL_NONLOCAL");
      destination = Buffer.concat([Buffer.from([4]), Buffer.from("00000000000000000000000000000001", "hex")]);
    }
    const port = Buffer.alloc(2);
    port.writeUInt16BE(input.port);
    link.socket.write(Buffer.concat([Buffer.from([5, 1, 0]), destination, port]));
    const header = await link.reader.read(4);
    fact(header[0] === 5 && header[2] === 0, "SOCKS_REPLY_INVALID");
    const addressLength =
      header[3] === 1 ? 4 : header[3] === 4 ? 16 : header[3] === 3 ? (await link.reader.read(1))[0] : null;
    fact(addressLength !== null, "SOCKS_REPLY_ADDRESS_INVALID");
    await link.reader.read(addressLength + 2);
    record.socksReply = header[1];
    if (header[1] !== 0) {
      record.outcome = "socks-rejected";
      return;
    }
    link.socket.write(token);
    const body = await link.reader.read(response.length);
    fact(body.equals(response), "RECEIVER_BODY_MISMATCH");
    record.outcome = "connected";
  } catch (error) {
    record.outcome = "transport-failed";
    record.reason = /^[A-Z0-9_]+$/.test(error.code ?? "")
      ? error.code
      : /^[A-Z0-9_]+$/.test(error.message ?? "")
        ? error.message
        : "SOCKS_ATTEMPT_FAILED";
  } finally {
    if (link) await socketClose(link.socket);
    record.completedAtMono = performance.now();
    record.receiverEvents = expected.events;
    record.actualFamilies = [...new Set(expected.events.map((event) => event.localFamily))];
    tokens.delete(token);
    save();
  }
}
async function localVersion(port) {
  result.counters.controllerReadiness++;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/version", agent: false, timeout: 400 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
          if (body.length > 4096) req.destroy();
        });
        res.on("end", () => {
          try {
            fact(res.statusCode === 200, "VERSION_STATUS");
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("VERSION_BODY"));
          }
        });
        res.on("error", () => reject(new Error("VERSION_RESPONSE")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("VERSION_TIMEOUT")));
    req.on("error", () => reject(new Error("VERSION_UNAVAILABLE")));
  });
}
function launch(args, timeoutMs) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(CLASH|MIHOMO)_|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete env[key];
  const child = spawn(binary, args, {
    cwd: temporary,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let captured = "";
  let byteCount = 0;
  let timedOut = false;
  const capture = (chunk) => {
    byteCount += chunk.length;
    if (byteCount > 128 * 1024) {
      interrupt("CHILD_LOG_LIMIT");
      return;
    }
    captured += chunk.toString();
    if (/download(?:ing)?|can.t find.*(?:mmdb|geosite|geoip)/i.test(captured))
      interrupt("EXTERNAL_RESOURCE_REQUIRED");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const ended = new Promise((resolve) => {
    child.once("error", () => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ pid: child.pid ?? null, exitCode: null, spawnFailed: true, timedOut });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({
        pid: child.pid ?? null,
        exitCode,
        signal,
        timedOut,
        logHash: hash(captured),
        logBytes: byteCount,
      });
    });
  });
  children.set(child, ended);
  return { child, ended, text: () => captured };
}
function configuration({
  id,
  globalIpv6,
  namedIpv4,
  dnsPort,
  controllerPort,
  socksPort,
  upstreamPort,
  trapPort,
  hostsName,
}) {
  const policy = namedIpv4 ? "loopback-ipv4-direct" : "DIRECT";
  return {
    port: 0,
    "socks-port": socksPort,
    "mixed-port": 0,
    "redir-port": 0,
    "tproxy-port": 0,
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "rule",
    ipv6: globalIpv6,
    "log-level": "info",
    "external-controller": `127.0.0.1:${controllerPort}`,
    "external-controller-tls": "",
    "external-controller-unix": "",
    "external-controller-pipe": "",
    "external-ui": "",
    "external-ui-url": `http://127.0.0.1:${trapPort}/disabled-ui`,
    "external-doh-server": "",
    secret: "",
    authentication: [],
    "geodata-mode": false,
    "geo-auto-update": false,
    "geox-url": Object.fromEntries(
      ["geoip", "geosite", "mmdb", "asn"].map((key) => [key, `http://127.0.0.1:${trapPort}/disabled-${key}`]),
    ),
    "find-process-mode": "off",
    tun: { enable: false },
    sniffer: { enable: false },
    ntp: { enable: false },
    profile: { "store-selected": false, "store-fake-ip": false },
    hosts: { [hostsName]: "::1" },
    proxies: namedIpv4 ? [{ name: policy, type: "direct", "ip-version": "ipv4" }] : [],
    "proxy-groups": [],
    "proxy-providers": {},
    "rule-providers": {},
    listeners: [],
    tunnels: [],
    rules: [
      ...["ipv4", "ipv6", "dual", "hosts"].map((name) => `DOMAIN,${name}-${id}.clipdock.test,${policy}`),
      `IP-CIDR,127.0.0.0/8,${policy},no-resolve`,
      `IP-CIDR6,::1/128,${policy},no-resolve`,
      "MATCH,REJECT",
    ],
    dns: {
      enable: true,
      listen: `127.0.0.1:${dnsPort}`,
      ipv6: true,
      "use-hosts": true,
      "use-system-hosts": false,
      "respect-rules": false,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter-mode": "blacklist",
      "fake-ip-filter": [],
      nameserver: [`udp://127.0.0.1:${upstreamPort}`],
      "default-nameserver": [`udp://127.0.0.1:${upstreamPort}`],
      "proxy-server-nameserver": [`udp://127.0.0.1:${upstreamPort}`],
      "direct-nameserver": [`udp://127.0.0.1:${upstreamPort}`],
      "nameserver-policy": {},
      "proxy-server-nameserver-policy": {},
      fallback: [],
      "fallback-filter": { geoip: false, geosite: [], ipcidr: [], domain: [] },
    },
  };
}
async function run() {
  fact(process.platform === "win32", "WINDOWS_REQUIRED");
  result.binaryHashBefore = hash(fs.readFileSync(binary));
  fact(result.binaryHashBefore === expectedHash, "BINARY_CHANGED");
  fs.mkdirSync(parent, { recursive: true });
  temporary = fs.mkdtempSync(path.join(parent, "mihomo-direct-family-"));
  watchdog = setTimeout(() => interrupt("EXPERIMENT_DEADLINE"), 100000);
  save();
  const v6Server = receiver();
  let v6Port;
  try {
    v6Port = await bind(v6Server, "::1");
  } catch (error) {
    result.ipv6Capability = { available: false, reason: error.code ?? "IPV6_BIND_FAILED" };
    throw new Error("IPV6_LOOPBACK_NOT_TESTABLE");
  }
  result.ipv6Capability = await directControl("::1", v6Port, "ipv6-capability");
  fact(result.ipv6Capability.available, "IPV6_LOOPBACK_NOT_TESTABLE");
  const v4Server = receiver();
  const v4Port = await bind(v4Server);
  fact(v4Port !== v6Port, "V4_CONTROL_PORT_COLLISION");
  // No IPv4 receiver listens on v6Port; verify real refusal rather than assume it.
  let refused;
  try {
    const connection = await connectSocket("127.0.0.1", v6Port, 1000);
    await socketClose(connection.socket);
    refused = { refused: false };
  } catch (error) {
    refused = { refused: error.code === "ECONNREFUSED", code: error.code ?? "UNKNOWN" };
  }
  result.ipv4RefusalControl = { ...refused, address: "127.0.0.1", port: v6Port };
  fact(refused.refused, "IPV4_REFUSAL_CONTROL_FAILED");
  const udp = dgram.createSocket("udp4");
  udp.on("message", (buffer, remote) => {
    try {
      fact(remote.address === "127.0.0.1", "UPSTREAM_NONLOCAL");
      udp.send(dnsResponse(buffer, "udp"), remote.port, remote.address);
    } catch {
      interrupt("UPSTREAM_PACKET_INVALID");
    }
  });
  const upstreamPort = await bind(udp);
  const tcp = net.createServer((socket) => {
    tracked(socket);
    let pending = Buffer.alloc(0);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("data", (chunk) => {
      try {
        pending = Buffer.concat([pending, chunk]);
        fact(pending.length < 32768, "DNS_TCP_LIMIT");
        while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
          const length = pending.readUInt16BE(0),
            answer = dnsResponse(pending.subarray(2, length + 2), "tcp");
          pending = pending.subarray(length + 2);
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(answer.length);
          socket.write(Buffer.concat([prefix, answer]));
        }
      } catch {
        interrupt("UPSTREAM_TCP_INVALID");
      }
    });
  });
  await bind(tcp, "127.0.0.1", upstreamPort);
  const trap = http.createServer((_req, res) => {
    result.counters.downloadRequests++;
    res.writeHead(503);
    res.end();
    interrupt("DOWNLOAD_ATTEMPT");
  });
  trap.on("connection", tracked);
  const trapPort = await bind(trap);
  result.endpoints = {
    upstreamUdp: `127.0.0.1:${upstreamPort}`,
    upstreamTcp: `127.0.0.1:${upstreamPort}`,
    downloadTrap: `127.0.0.1:${trapPort}`,
    ipv4Receiver: `127.0.0.1:${v4Port}`,
    ipv6Receiver: `[::1]:${v6Port}`,
  };
  const version = launch(["-v"], 3000);
  const versionExit = await version.ended;
  result.processes.push({ purpose: "version", ...versionExit });
  result.cliVersion = version.text().trim().slice(0, 1024);
  fact(
    versionExit.exitCode === 0 && !versionExit.timedOut && !fatal && /424c2ef/.test(result.cliVersion),
    "CLI_VERSION_FAILED",
  );
  for (const profile of [
    { id: "builtin-g0", globalIpv6: false, namedIpv4: false },
    { id: "builtin-g1", globalIpv6: true, namedIpv4: false },
    { id: "named4-g1", globalIpv6: true, namedIpv4: true },
  ]) {
    fact(!fatal && hash(fs.readFileSync(binary)) === expectedHash, fatal ?? "BINARY_CHANGED");
    dnsRecords.clear();
    for (const [name, a, aaaa] of [
      ["ipv4", "127.0.0.1", null],
      ["ipv6", null, "::1"],
      ["dual", "127.0.0.1", "::1"],
      ["hosts", null, null],
    ]) {
      dnsRecords.set(`${name}-${profile.id}.clipdock.test`, { a, aaaa });
    }
    const dnsPort = await allocatePort(),
      controllerPort = await allocatePort(),
      socksPort = await allocatePort();
    fact(
      new Set([dnsPort, controllerPort, socksPort, v4Port, v6Port, upstreamPort, trapPort]).size === 7,
      "PORT_REUSE",
    );
    const config = configuration({
      ...profile,
      dnsPort,
      controllerPort,
      socksPort,
      upstreamPort,
      trapPort,
      hostsName: `hosts-${profile.id}.clipdock.test`,
    });
    const directory = path.join(temporary, profile.id);
    fs.mkdirSync(directory);
    const configFile = path.join(directory, "config.yaml");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: "wx" });
    const configurationResult = {
      ...profile,
      syntheticConfiguration: config,
      configHash: hash(fs.readFileSync(configFile)),
      completed: false,
    };
    result.configurations.push(configurationResult);
    const dry = launch(["-t", "-d", directory, "-f", configFile], 3000);
    const dryExit = await dry.ended;
    result.processes.push({ purpose: `${profile.id}-test`, ...dryExit });
    fact(dryExit.exitCode === 0 && !dryExit.timedOut && !fatal, "CONFIG_TEST_FAILED");
    const active = launch(["-d", directory, "-f", configFile], 35000);
    try {
      let ready;
      const until = performance.now() + 2500;
      while (performance.now() < until && !fatal && active.child.exitCode === null) {
        try {
          ready = await localVersion(controllerPort);
          break;
        } catch {
          await sleep(75);
        }
      }
      fact(ready?.version === "424c2ef" && !fatal, "CONTROLLER_NOT_READY");
      configurationResult.controllerVersion = ready.version;
      configurationResult.childPid = active.child.pid;
      for (const scenario of ["ipv4", "ipv6", "dual", "hosts", "literal"]) {
        fact(!fatal && active.child.exitCode === null, fatal ?? "KERNEL_EXITED");
        const input =
          scenario === "literal"
            ? { kind: "ipv6-literal", host: "::1", port: v6Port }
            : {
                kind: "domain",
                host: `${scenario}-${profile.id}.clipdock.test`,
                port: scenario === "ipv4" ? v4Port : v6Port,
              };
        currentCase = {
          id: `${profile.id}:${scenario}`,
          profile: profile.id,
          scenario,
          input,
          dns: [],
          outcome: null,
        };
        result.cases.push(currentCase);
        await socksAttempt(socksPort, input, currentCase);
        fact(!fatal, fatal ?? "CASE_INTERRUPTED");
      }
      configurationResult.completed = true;
    } finally {
      if (active.child.exitCode === null) active.child.kill();
      const ended = await active.ended;
      result.processes.push({ purpose: profile.id, ...ended });
      configurationResult.childExit = ended;
      currentCase = null;
      save();
    }
  }
  check(
    "IPv6 loopback positive control reached IPv6 receiver",
    result.ipv6Capability.available && result.ipv6Capability.events.some((e) => e.localFamily === "IPv6"),
  );
  check("dual-stack IPv4 receiver actually refused", result.ipv4RefusalControl.refused);
  check(
    "all three synthetic configurations completed",
    result.configurations.length === 3 && result.configurations.every((c) => c.completed),
  );
  check(
    "one SOCKS attempt for each of 15 branches",
    result.cases.length === 15 && result.counters.socksConnects === 15,
  );
  check(
    "IPv4 control connected in each policy",
    result.cases
      .filter((c) => c.scenario === "ipv4")
      .every((c) => c.outcome === "connected" && c.actualFamilies.join() === "IPv4"),
  );
  check(
    "global true IPv6-only positive control reached IPv6",
    result.cases.find((c) => c.id === "builtin-g1:ipv6")?.actualFamilies.join() === "IPv6",
  );
  check(
    "no unexpected DNS or download request",
    result.counters.unexpectedDns === 0 && result.counters.downloadRequests === 0,
  );
  result.completed = result.checks.every((c) => c.passed);
  fact(result.completed, "CONTROL_CHECK_FAILED");
}
try {
  await run();
} catch (error) {
  result.failure =
    fatal ?? (/^[A-Z0-9_]{1,100}$/.test(error.message ?? "") ? error.message : "EXPERIMENT_FAILED");
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try {
    const endings = [...children.values()];
    for (const child of children.keys()) if (child.exitCode === null) child.kill();
    await Promise.all(endings);
    result.cleanup.childrenExited = children.size === 0;
    result.cleanup.residualOwnedPids = [...children.keys()].map((child) => child.pid);
  } catch {
    result.cleanup.errors.push("CHILD_CLEANUP_FAILED");
  }
  try {
    await Promise.all([...sockets].map(socketClose));
    result.cleanup.localSocketsClosed = sockets.size === 0;
  } catch {
    result.cleanup.errors.push("SOCKET_CLEANUP_FAILED");
  }
  for (const server of [...servers].reverse()) {
    try {
      await closeServer(server);
    } catch {
      result.cleanup.errors.push("SERVER_CLEANUP_FAILED");
    }
  }
  result.cleanup.localServersClosed = servers.size === 0;
  try {
    result.binaryHashAfter = hash(fs.readFileSync(binary));
    result.binaryStable =
      result.binaryHashAfter === result.binaryHashBefore && result.binaryHashAfter === expectedHash;
  } catch {
    result.cleanup.errors.push("BINARY_RECHECK_FAILED");
  }
  if (temporary) {
    try {
      const actualParent = fs.realpathSync(parent),
        resolved = fs.realpathSync(temporary);
      fact(
        !fs.lstatSync(temporary).isSymbolicLink() &&
          path.dirname(resolved) === actualParent &&
          path.basename(resolved).startsWith("mihomo-direct-family-") &&
          result.cleanup.childrenExited &&
          result.cleanup.localSocketsClosed,
        "CLEANUP_PATH_REJECTED",
      );
      fs.rmSync(resolved, { recursive: true });
      result.cleanup.temporaryRemoved = !fs.existsSync(resolved);
    } catch {
      result.cleanup.errors.push("TEMPORARY_CLEANUP_FAILED");
    }
  }
  result.endedAt = new Date().toISOString();
  save();
  if (result.cleanup.errors.length || !result.binaryStable) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        output: path.relative(root, output),
        completed: result.completed,
        cases: result.cases.map((c) => ({
          id: c.id,
          outcome: c.outcome,
          socksReply: c.socksReply,
          actualFamilies: c.actualFamilies,
          dns: c.dns,
          reason: c.reason,
        })),
        checks: result.checks,
        counters: result.counters,
        binaryStable: result.binaryStable,
        cleanup: result.cleanup,
        failure: result.failure,
      },
      null,
      2,
    ),
  );
}
