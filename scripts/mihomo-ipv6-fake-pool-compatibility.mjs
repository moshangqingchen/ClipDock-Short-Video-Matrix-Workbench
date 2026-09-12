/** Bounded loopback-only compatibility experiment. Never edits the selected client's config. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const binary = 'C:/Users/Administrator/AppData/Local/Programs/MAOMAOYUNAPP/resources/extra/mihomo-windows-386.exe';
const expectedHash = 'd354a6b31e89db289a46fffd8913c2da4ee1e2218882d75cacc49c41b425dde9';
const output = path.join(root, 'docs/network-mihomo-ipv6-fake-pool-compatibility.results.json');
const parent = path.join(root, 'docs/.compare');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = { startedAt: new Date().toISOString(), kind: 'isolated-mihomo-ipv6-pool-compatibility',
  binaryHashBefore: null, binaryHashAfter: null, binaryStable: false, scriptHash: hash(fs.readFileSync(script)),
  isolation: { tunEnabled: false, allowLan: false, modifiedSystemDns: false, modifiedSystemProxy: false,
    modifiedSelectedConfiguration: false, accountDataUsed: false, subscriptionsUsed: false,
    publicTestRequests: 0, physicalPacketCapture: false, onlyOwnedChildrenTerminated: true },
  endpoints: {}, counters: { upstreamUdp: 0, upstreamTcp: 0, unexpectedDns: 0, downloadRequests: 0,
    listenerQueries: 0, controllerQueries: 0, controllerReadiness: 0 }, cases: [], processes: [],
  cli: {}, failure: null, cleanup: { childrenExited: false, localServersClosed: false, temporaryRemoved: false } };
const children = new Set();
const servers = [];
const allowedNames = new Set();
let temporary;
let currentCase;
let fatal = null;
let queryId = 100;
let watchdog;
function save() {
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
function stopOnViolation(code) {
  fatal ??= code;
  for (const child of children) if (child.exitCode === null) child.kill();
}
function readName(buffer, start) {
  const labels = []; let offset = start; let end; const seen = new Set();
  for (let count = 0; count < 128; count++) {
    assert(offset < buffer.length && !seen.has(offset), 'DNS_NAME_INVALID'); seen.add(offset);
    const size = buffer[offset++];
    if (size === 0) return { name: labels.join('.').toLowerCase(), end: end ?? offset };
    if ((size & 0xc0) === 0xc0) {
      assert(offset < buffer.length, 'DNS_POINTER_INVALID');
      end ??= offset + 1; offset = ((size & 0x3f) << 8) | buffer[offset]; continue;
    }
    assert(size <= 63 && offset + size <= buffer.length, 'DNS_LABEL_INVALID');
    labels.push(buffer.subarray(offset, offset + size).toString('ascii')); offset += size;
  }
  throw new Error('DNS_NAME_LIMIT');
}
function question(buffer) {
  assert(buffer.length >= 12 && buffer.readUInt16BE(4) === 1, 'DNS_QUESTION_INVALID');
  const name = readName(buffer, 12); assert(name.end + 4 <= buffer.length, 'DNS_QUESTION_SHORT');
  return { name: name.name, type: buffer.readUInt16BE(name.end), end: name.end + 4 };
}
function query(name, type) {
  const header = Buffer.alloc(12); header.writeUInt16BE(++queryId, 0); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const labels = name.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]);
  const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(1, 3);
  return Buffer.concat([header, ...labels, tail]);
}
function parseAnswer(buffer) {
  const q = question(buffer); let cursor = q.end; const answers = [];
  for (let index = 0; index < buffer.readUInt16BE(6); index++) {
    const name = readName(buffer, cursor); cursor = name.end;
    assert(cursor + 10 <= buffer.length, 'DNS_ANSWER_SHORT');
    const type = buffer.readUInt16BE(cursor), ttl = buffer.readUInt32BE(cursor + 4), length = buffer.readUInt16BE(cursor + 8);
    cursor += 10; assert(cursor + length <= buffer.length, 'DNS_DATA_SHORT');
    const bytes = buffer.subarray(cursor, cursor + length); cursor += length;
    const address = type === 1 && length === 4 ? [...bytes].join('.') : type === 28 && length === 16
      ? Array.from({ length: 8 }, (_, offset) => bytes.readUInt16BE(offset * 2).toString(16)).join(':') : null;
    answers.push({ type, ttl, address });
  }
  return { name: q.name, type: q.type, rcode: buffer.readUInt16BE(2) & 15,
    truncated: Boolean(buffer.readUInt16BE(2) & 0x0200), answers };
}
function respond(buffer, transport) {
  const q = question(buffer); result.counters[transport === 'udp' ? 'upstreamUdp' : 'upstreamTcp']++;
  if (!allowedNames.has(q.name) || ![1, 28].includes(q.type)) {
    result.counters.unexpectedDns++; stopOnViolation('UNEXPECTED_DNS_REQUEST');
    const response = Buffer.from(buffer.subarray(0, q.end)); response.writeUInt16BE(0x8185, 2); return response;
  }
  const data = q.type === 1 ? Buffer.from([192, 0, 2, 123]) : Buffer.from('20010db8000000000000000000000123', 'hex');
  const header = Buffer.from(buffer.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6);
  header.writeUInt16BE(0, 8); header.writeUInt16BE(0, 10);
  const answer = Buffer.alloc(12); answer.writeUInt16BE(0xc00c, 0); answer.writeUInt16BE(q.type, 2);
  answer.writeUInt16BE(1, 4); answer.writeUInt32BE(30, 6); answer.writeUInt16BE(data.length, 10);
  currentCase?.upstream.push({ transport, name: q.name, type: q.type, syntheticAnswer: q.type === 1 ? '192.0.2.123' : '2001:db8::123' });
  return Buffer.concat([header, buffer.subarray(12, q.end), answer, data]);
}
async function bind(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject);
    if (server instanceof dgram.Socket) server.bind(port, '127.0.0.1', resolve);
    else server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server); return server.address().port;
}
async function allocatePort() {
  const socket = net.createServer(); const port = await bind(socket);
  await new Promise(resolve => socket.close(resolve)); servers.splice(servers.indexOf(socket), 1); return port;
}
async function dnsGet(port, name, type) {
  result.counters.listenerQueries++; const buffer = query(name, type); const socket = dgram.createSocket('udp4');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('LISTENER_DNS_TIMEOUT')), 1500); let settled = false;
    function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); }
    socket.on('error', () => finish(new Error('LISTENER_DNS_ERROR')));
    socket.on('message', (message, remote) => {
      try { assert(remote.address === '127.0.0.1' && remote.port === port && message.readUInt16BE(0) === buffer.readUInt16BE(0), 'DNS_PEER_MISMATCH');
        finish(null, parseAnswer(message)); } catch (error) { finish(error); }
    });
    socket.send(buffer, port, '127.0.0.1');
  });
}
async function localGet(port, route, readiness = false) {
  assert(route === '/version' || /^\/dns\/query\?name=[a-z0-9.-]+&type=AAAA$/.test(route), 'HTTP_ROUTE_REJECTED');
  result.counters[readiness ? 'controllerReadiness' : 'controllerQueries']++;
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: route, agent: false, timeout: 500 }, response => {
      const chunks = []; let count = 0;
      response.on('data', chunk => { count += chunk.length; if (count > 32768) req.destroy(new Error('HTTP_LIMIT')); else chunks.push(chunk); });
      response.on('end', () => { try { assert(response.statusCode === 200, 'HTTP_STATUS'); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('HTTP_BODY')); } });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT'))); req.on('error', () => reject(new Error('HTTP_UNAVAILABLE')));
  });
}
function launch(args, timeoutMs) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^(CLASH|MIHOMO)_|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key)) delete environment[key];
  const child = spawn(binary, args, { cwd: temporary, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let captured = ''; let byteCount = 0; let timedOut = false;
  const capture = chunk => { byteCount += chunk.length; if (byteCount > 128 * 1024) { stopOnViolation('CHILD_LOG_LIMIT'); return; }
    captured += chunk.toString(); if (/download(?:ing)?|can.t find.*(?:mmdb|geosite|geoip)/i.test(captured)) stopOnViolation('EXTERNAL_RESOURCE_REQUIRED'); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  const ended = new Promise(resolve => {
    child.once('error', () => { clearTimeout(timer); children.delete(child); resolve({ exitCode: null, spawnFailed: true, timedOut }); });
    child.once('close', (exitCode, signal) => { clearTimeout(timer); children.delete(child); resolve({ exitCode, signal, timedOut, logHash: hash(captured), logBytes: byteCount }); });
  });
  return { child, ended, text: () => captured };
}
function configuration({ dnsPort, controllerPort, upstreamPort, trapPort, explicit, globalIpv6, dnsIpv6, filteredName }) {
  return { 'port': 0, 'socks-port': 0, 'mixed-port': 0, 'redir-port': 0, 'tproxy-port': 0,
    'allow-lan': false, 'bind-address': '127.0.0.1', 'mode': 'rule', 'ipv6': globalIpv6, 'log-level': 'info',
    'external-controller': `127.0.0.1:${controllerPort}`, 'external-controller-tls': '', 'external-controller-unix': '',
    'external-controller-pipe': '', 'external-ui': '', 'external-ui-url': `http://127.0.0.1:${trapPort}/disabled-ui`,
    'external-doh-server': '', 'secret': '', 'authentication': [], 'geodata-mode': false, 'geo-auto-update': false,
    'geox-url': Object.fromEntries(['geoip', 'geosite', 'mmdb', 'asn'].map(key => [key, `http://127.0.0.1:${trapPort}/disabled-${key}`])),
    'find-process-mode': 'off', 'tun': { enable: false }, 'sniffer': { enable: false }, 'ntp': { enable: false },
    'profile': { 'store-selected': false, 'store-fake-ip': false }, 'hosts': {}, 'proxies': [], 'proxy-groups': [],
    'proxy-providers': {}, 'rule-providers': {}, 'listeners': [], 'tunnels': [], 'rules': ['MATCH,REJECT'],
    'dns': { enable: true, listen: `127.0.0.1:${dnsPort}`, ipv6: dnsIpv6, 'use-hosts': false, 'use-system-hosts': false,
      'respect-rules': false, 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16',
      ...(explicit ? { 'fake-ip-range6': 'fd66:1234:5678::1/64' } : {}),
      'fake-ip-filter-mode': 'blacklist', 'fake-ip-filter': [filteredName],
      'nameserver': [`udp://127.0.0.1:${upstreamPort}`], 'default-nameserver': [`udp://127.0.0.1:${upstreamPort}`],
      'proxy-server-nameserver': [`udp://127.0.0.1:${upstreamPort}`], 'direct-nameserver': [`udp://127.0.0.1:${upstreamPort}`],
      'nameserver-policy': {}, 'proxy-server-nameserver-policy': {}, fallback: [],
      'fallback-filter': { geoip: false, geosite: [], ipcidr: [], domain: [] } } };
}
async function run() {
  assert(process.platform === 'win32', 'WINDOWS_REQUIRED');
  result.binaryHashBefore = hash(fs.readFileSync(binary)); assert(result.binaryHashBefore === expectedHash, 'BINARY_CHANGED');
  if (fs.existsSync(output)) {
    const old = JSON.parse(fs.readFileSync(output, 'utf8'));
    fs.copyFileSync(output, output.replace('.results.json', `.${old.startedAt.replace(/[^0-9TZ]/g, '')}.results.json`));
  }
  fs.mkdirSync(parent, { recursive: true }); temporary = fs.mkdtempSync(path.join(parent, 'mihomo-ipv6-compat-')); save();
  watchdog = setTimeout(() => stopOnViolation('EXPERIMENT_DEADLINE'), 45000);
  const udp = dgram.createSocket('udp4'); udp.on('message', (buffer, remote) => {
    try { assert(remote.address === '127.0.0.1', 'UPSTREAM_NONLOCAL'); udp.send(respond(buffer, 'udp'), remote.port, remote.address); }
    catch { stopOnViolation('UPSTREAM_PACKET_INVALID'); }
  });
  const upstreamPort = await bind(udp);
  const tcp = net.createServer(socket => {
    let pending = Buffer.alloc(0); socket.setTimeout(2000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('data', chunk => { try { pending = Buffer.concat([pending, chunk]); assert(pending.length < 32768, 'UPSTREAM_TCP_LIMIT');
      while (pending.length >= 2 && pending.length >= pending.readUInt16BE(0) + 2) {
        const length = pending.readUInt16BE(0), answer = respond(pending.subarray(2, length + 2), 'tcp'); pending = pending.subarray(length + 2);
        const prefix = Buffer.alloc(2); prefix.writeUInt16BE(answer.length); socket.write(Buffer.concat([prefix, answer]));
      }
    } catch { socket.destroy(); stopOnViolation('UPSTREAM_TCP_INVALID'); } });
  }); await bind(tcp, upstreamPort);
  const trap = http.createServer((_request, response) => { result.counters.downloadRequests++; response.writeHead(503); response.end(); stopOnViolation('DOWNLOAD_ATTEMPT'); });
  const trapPort = await bind(trap); result.endpoints = { upstreamUdp: `127.0.0.1:${upstreamPort}`, upstreamTcp: `127.0.0.1:${upstreamPort}`, downloadTrap: `127.0.0.1:${trapPort}` };
  for (const [name, args] of [['help', ['-h']], ['version', ['-v']]]) {
    const cli = launch(args, 3000); const ending = await cli.ended; result.processes.push({ purpose: name, ...ending });
    assert(!ending.timedOut && !ending.spawnFailed && ending.exitCode === 0 && !fatal, 'CLI_FAILED');
    result.cli[name] = name === 'version' ? cli.text().trim().slice(0, 1024) : { directoryFlag: /-d\s/.test(cli.text()), configFlag: /-f\s/.test(cli.text()), testFlag: /-t\s/.test(cli.text()) };
  }
  assert(Object.values(result.cli.help).every(Boolean), 'CLI_FLAGS_UNSUPPORTED'); save();
  for (const explicit of [false, true]) for (const globalIpv6 of [true, false]) for (const dnsIpv6 of [true, false]) {
    assert(!fatal, fatal ?? 'EXPERIMENT_INTERRUPTED');
    const id = `${explicit ? 'explicit' : 'missing'}-g${+globalIpv6}-d${+dnsIpv6}`;
    currentCase = { id, startedAt: new Date().toISOString(), explicitRange6: explicit, globalIpv6, dnsIpv6, upstream: [], responses: {}, completed: false };
    result.cases.push(currentCase); allowedNames.clear();
    const plain = `plain-${id}.clipdock.test`, filtered = `pass-${id}.clipdock.test`, control = `control-${id}.clipdock.test`;
    [plain, filtered, control].forEach(name => allowedNames.add(name));
    const dnsPort = await allocatePort(), controllerPort = await allocatePort();
    assert(dnsPort !== controllerPort, 'PORT_REUSE');
    const config = configuration({ dnsPort, controllerPort, upstreamPort, trapPort, explicit, globalIpv6, dnsIpv6, filteredName: filtered });
    const directory = path.join(temporary, id); fs.mkdirSync(directory); const configFile = path.join(directory, 'config.yaml');
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' });
    currentCase.syntheticConfiguration = config;
    const dry = launch(['-t', '-d', directory, '-f', configFile], 3000); const dryEnding = await dry.ended;
    result.processes.push({ purpose: `${id}-test`, ...dryEnding }); currentCase.configTest = dryEnding;
    assert(dryEnding.exitCode === 0 && !dryEnding.timedOut && !fatal, 'CONFIG_TEST_FAILED');
    const active = launch(['-d', directory, '-f', configFile], 7000); currentCase.childPid = active.child.pid;
    try {
      let version; const until = performance.now() + 2500;
      while (performance.now() < until && !fatal && active.child.exitCode === null) {
        try { version = await localGet(controllerPort, '/version', true); break; } catch { await sleep(75); }
      }
      assert(version?.version === '424c2ef' && !fatal, 'CONTROLLER_NOT_READY'); currentCase.controllerVersion = version.version;
      currentCase.responses.plainAAAA = await dnsGet(dnsPort, plain, 28);
      currentCase.responses.filteredAAAA = await dnsGet(dnsPort, filtered, 28);
      currentCase.responses.plainA = await dnsGet(dnsPort, plain, 1);
      const controller = await localGet(controllerPort, `/dns/query?name=${control}&type=AAAA`);
      currentCase.responses.controllerAAAA = { status: controller.Status, question: controller.Question,
        answers: (controller.Answer ?? []).map(answer => ({ type: answer.type, ttl: answer.TTL, address: answer.data })) };
      assert(!fatal, fatal ?? 'CASE_INTERRUPTED'); currentCase.completed = true;
    } finally {
      if (active.child.exitCode === null) active.child.kill();
      currentCase.childExit = await active.ended; result.processes.push({ purpose: id, ...currentCase.childExit });
      currentCase.completedAt = new Date().toISOString(); save();
    }
  }
  result.completed = result.cases.every(item => item.completed) && result.cases.length === 8;
}
try { await run(); }
catch (error) { result.failure = fatal ?? (/^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'EXPERIMENT_FAILED'); process.exitCode = 1; }
finally {
  clearTimeout(watchdog);
  for (const child of [...children]) { if (child.exitCode === null) child.kill(); }
  for (let attempt = 0; children.size && attempt < 20; attempt++) await sleep(50);
  result.cleanup.childrenExited = children.size === 0;
  for (const server of servers.reverse()) {
    try { if (!(server instanceof dgram.Socket)) server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } catch { /* already closed */ }
  }
  result.cleanup.localServersClosed = true;
  result.binaryHashAfter = hash(fs.readFileSync(binary)); result.binaryStable = result.binaryHashAfter === result.binaryHashBefore;
  if (temporary) {
    const resolved = path.resolve(temporary); assert(path.dirname(resolved) === path.resolve(parent) && path.basename(resolved).startsWith('mihomo-ipv6-compat-'), 'CLEANUP_PATH_REJECTED');
    fs.rmSync(resolved, { recursive: true }); result.cleanup.temporaryRemoved = !fs.existsSync(resolved);
  }
  result.endedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ completed: result.completed ?? false, cases: result.cases.map(item => ({ id: item.id, completed: item.completed, responses: item.responses })),
    counters: result.counters, binaryStable: result.binaryStable, cleanup: result.cleanup, failure: result.failure }, null, 2));
}
