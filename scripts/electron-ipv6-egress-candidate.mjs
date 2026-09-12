/** One IPv6-only echo, then at most one geo lookup. Normal DNS only; raw IPs remain in main memory. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '..');
const target = new URL('https://api6.ipify.org/');
const output = path.join(repository, 'docs/network-stage2-ipv6-egress-candidate.results.json');
const canonical = (value) => {
  if (typeof value !== 'string' || value.includes('%')) return null;
  if (net.isIP(value) === 4) return value;
  return net.isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : null;
};
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hash = (value) => digest(JSON.stringify(value));
const ipv6PrefixDigests = (value) => {
  const ip = canonical(value);
  if (net.isIP(ip) !== 6 || ip.includes('.')) return [];
  const [left, right] = ip.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  const number = BigInt(`0x${words.map((word) => word.padStart(4, '0')).join('')}`);
  return [0, 8, 64, 128].map((length) => {
    const shift = BigInt(128 - length), masked = (number >> shift) << shift;
    const expanded = masked.toString(16).padStart(32, '0').match(/.{4}/g).join(':');
    return { prefixLength: length, networkAddressDigest: digest(canonical(expanded)) };
  });
};
const code = (error) => /\bERR_[A-Z_]+\b/.exec(String(error))?.[0] ?? 'EXPERIMENT_FAILED';
const control = async (endpoint) => {
  const r = await fetch(`http://127.0.0.1:9790/${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error('CONTROLLER_UNAVAILABLE');
  return r.json();
};
if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ipv6-echo-'));
  const env = { ...process.env, SV_IPV6_ECHO_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_ENABLE_LOGGING; delete env.ELECTRON_LOG_FILE;
  const child = spawn(electron, [script], { cwd: repository, env, windowsHide: true, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill(), 35_000);
  const exit = await new Promise((resolve) => { child.once('error', () => resolve(-1)); child.once('exit', (c) => resolve(c)); });
  clearTimeout(timer);
  const file = path.join(root, 'result.json');
  const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { error: 'NO_CHILD_RESULT' };
  result.childExitCode = exit;
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...result }, null, 2));
  const absolute = fs.realpathSync(root);
  if (path.dirname(absolute) !== fs.realpathSync(os.tmpdir()) || !path.basename(absolute).startsWith('sv-ipv6-echo-'))
    throw new Error('UNSAFE_EXPERIMENT_CLEANUP');
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} else run().catch(async (error) => {
  fs.writeFileSync(path.join(process.env.SV_IPV6_ECHO_ROOT, 'result.json'), JSON.stringify({ error: code(error) }));
  const { app } = await import('electron'); app.exit(1);
});

async function run() {
  const { app, session, BrowserWindow } = await import('electron');
  const root = process.env.SV_IPV6_ECHO_ROOT;
  if (!root || !path.basename(root).startsWith('sv-ipv6-echo-')) throw new Error('ISOLATED_PROFILE_REQUIRED');
  app.setPath('userData', path.join(root, 'userData')); app.setPath('sessionData', path.join(root, 'sessionData'));
  for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-http-cache', 'disable-quic'])
    app.commandLine.appendSwitch(flag);
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  let certificateError = false;
  app.on('certificate-error', (_event, _wc, _url, _err, _cert, callback) => { certificateError = true; callback(false); });
  app.on('login', (event, _wc, _details, _auth, callback) => { event.preventDefault(); callback(); });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  const isolated = session.fromPartition(`ipv6-echo-${crypto.randomUUID()}`);
  let admittedEchoRequests = 0, blockedRequests = 0, credentialHeaderSeen = false;
  isolated.webRequest.onBeforeRequest((details, callback) => {
    if (details.url === 'about:blank') return callback({ cancel: false });
    const allowed = admittedEchoRequests === 0 && details.url === target.href && details.method === 'GET';
    if (allowed) admittedEchoRequests++; else blockedRequests++;
    callback({ cancel: !allowed });
  });
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) if (/^(cookie|authorization|proxy-authorization)$/i.test(name)) {
      credentialHeaderSeen = true; delete headers[name];
    }
    callback({ requestHeaders: headers });
  });
  isolated.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const name of Object.keys(headers)) if (/^set-cookie$/i.test(name)) delete headers[name];
    callback({ responseHeaders: headers });
  });
  await isolated.setProxy({ mode: 'direct' }); await isolated.closeAllConnections();
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('about:blank'); window.webContents.debugger.attach('1.3');
  let cdpResponse = null;
  window.webContents.debugger.on('message', (_event, method, p) => {
    if (method === 'Network.responseReceived' && p.response.url === target.href) cdpResponse = p.response;
  });
  await window.webContents.debugger.sendCommand('Network.enable');
  const [config, rules, dns, version] = await Promise.all([control('configs'), control('rules'),
    control(`dns/query?name=${target.hostname}&type=AAAA`), control('version')]);
  if (config.mode !== 'rule' || config.tun?.enable !== true || config.ipv6 !== false) throw new Error('UNEXPECTED_CONTROLLER_STATE');
  const aaaa = new Set((dns.Answer ?? []).filter((r) => r.type === 28).map((r) => canonical(r.data)).filter(Boolean));
  const sockets = async () => {
    const pids = app.getAppMetrics().filter((m) => m.serviceName === 'network.mojom.NetworkService').map((m) => m.pid);
    if (!pids.length || pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) return { pids: [], rows: [] };
    const cmd = `$echoPids = @(${pids.join(',')}); @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $echoPids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess) | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 6000 });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return { pids, rows: Array.isArray(parsed) ? parsed : [parsed] };
  };
  const beforeSockets = await sockets();
  const beforeConnections = await control('connections');
  const key = (r) => `${r.OwningProcess}:${canonical(r.LocalAddress)}:${r.LocalPort}:${canonical(r.RemoteAddress)}:${r.RemotePort}`;
  const oldTuples = new Set(beforeSockets.rows.map(key));
  const oldIds = new Set((beforeConnections.connections ?? []).map((c) => c.id));
  const requestStarted = Date.now();
  let echoedIp = null, status = null, echoError = null;
  try {
    const response = await isolated.fetch(target.href, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000) });
    status = response.status;
    const text = await response.text(); // Never enters a renderer, output, report, error message or log.
    if (response.ok && text.length < 100) echoedIp = canonical(text.trim());
    if (net.isIP(echoedIp) !== 6) { echoedIp = null; echoError = 'INVALID_IPV6_ECHO'; }
  } catch (error) { echoError = code(error); }
  const afterSockets = await sockets();
  const afterConnections = await control('connections');
  const candidates = afterSockets.rows.filter((r) => !oldTuples.has(key(r)) &&
    beforeSockets.pids.includes(r.OwningProcess) && afterSockets.pids.includes(r.OwningProcess) &&
    (cdpResponse ? canonical(r.RemoteAddress) === canonical(cdpResponse.remoteIPAddress) && r.RemotePort === cdpResponse.remotePort :
      aaaa.has(canonical(r.RemoteAddress))));
  // Controlled experiment only: no other session/target is allowed in this isolated process.
  // With missing CDP, retain the weaker DNS/unique-tuple source explicitly, never a production assertion.
  const socket = echoedIp && candidates.length === 1 ? candidates[0] : null;
  const matching = socket ? (afterConnections.connections ?? []).filter((c) => c.metadata?.host === target.hostname &&
    c.metadata.network === 'tcp' && Number(c.metadata.destinationPort) === 443 &&
    canonical(c.metadata.sourceIP) === canonical(socket.LocalAddress) && Number(c.metadata.sourcePort) === socket.LocalPort &&
    !oldIds.has(c.id) && Date.parse(c.start) >= requestStarted - 100) : [];
  const connection = matching.length === 1 ? matching[0] : null;
  let geo = { attempted: false, valid: false, ipMatchesEcho: false, country: null, asn: null, error: null };
  if (echoedIp) {
    geo.attempted = true;
    try {
      const response = await fetch(`https://ipwho.is/${encodeURIComponent(echoedIp)}`, {
        redirect: 'error', signal: AbortSignal.timeout(8000) });
      const data = await response.json();
      geo.ipMatchesEcho = canonical(data.ip) === echoedIp;
      geo.valid = response.ok && data.success === true && geo.ipMatchesEcho && /^[A-Z]{2}$/.test(data.country_code);
      if (geo.valid) { geo.country = data.country_code; geo.asn = Number.isSafeInteger(data.connection?.asn) ? data.connection.asn : null; }
      else geo.error = 'GEO_UNVERIFIED';
    } catch (error) { geo.error = code(error); }
  }
  const [afterConfig, afterRules] = await Promise.all([control('configs'), control('rules')]);
  const direct = connection?.chains?.length === 1 && connection.chains[0] === 'DIRECT';
  const source = socket ? canonical(socket.LocalAddress) : null;
  const result = { executedAt: new Date().toISOString(), domain: target.hostname, electron: process.versions.electron,
    kernelVersion: version.version, globalIpv6: config.ipv6, mode: config.mode, tun: config.tun.enable,
    resolverOverride: false, anonymousEchoBudget: 1, anonymousGeoBudget: 1, admittedEchoRequests, blockedRequests,
    echoResponseOnlyInMainMemory: true, originalIpPersisted: false, realAccountsUsed: false, netLogUsed: false,
    credentialHeaderSeen, storedCookieCount: (await isolated.cookies.get({})).length, certificateError,
    status, echoError, echoAddressFamily: net.isIP(echoedIp), echoSourceDigest: echoedIp ? digest(echoedIp) : null,
    cdpObservedForSessionFetch: !!cdpResponse,
    socket: { candidates: candidates.length, selected: !!socket,
      basis: socket ? (cdpResponse ? 'CDP_AND_UNIQUE_NEW_TUPLE' : 'CONTROLLED_SINGLE_REQUEST_DNS_AND_UNIQUE_NEW_TUPLE') : 'UNATTRIBUTED',
      sourcePort: socket?.LocalPort ?? null, sourceAddressFamily: net.isIP(source),
      sourceAddressDigest: source ? digest(source) : null,
      remoteAddressFamily: socket ? net.isIP(canonical(socket.RemoteAddress)) : 0,
      remoteAddressDigest: socket ? digest(canonical(socket.RemoteAddress)) : null,
      remotePrefixDigests: socket ? ipv6PrefixDigests(socket.RemoteAddress) : [],
      sourceEqualsEcho: source && echoedIp ? source === echoedIp : null },
    kernel: { matchingRecords: matching.length, chain: connection ? (direct ? 'DIRECT' : 'NON_DIRECT') : 'UNATTRIBUTED',
      nonDirectChainDigest: connection && !direct ? hash(connection.chains ?? null) : null },
    geo, priorBilibiliSourceComparison: 'UNAVAILABLE_ORIGINAL_SOURCE_OR_HASH_NOT_RETAINED',
    visibleConfigAndRulesUnchanged: hash([config, rules]) === hash([afterConfig, afterRules]),
    productionPathApplicabilityVerified: false };
  window.destroy(); await isolated.closeAllConnections();
  fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
}
