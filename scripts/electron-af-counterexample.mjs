/** Two anonymous robots.txt GETs, isolated profiles, no NetLog/account/config changes. Negative AF experiment. */
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
const target = new URL('https://www.bilibili.com/robots.txt');
const resultPath = path.join(repository, 'docs/network-stage2-af-counterexample.results.json');
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const control = async (endpoint) => {
  const r = await fetch(`http://127.0.0.1:9790/${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`CONTROLLER_HTTP_${r.status}`);
  return r.json();
};
const errorCode = (error) => /\b(?:ERR_[A-Z_]+|CONTROLLER_HTTP_\d+)\b/.exec(String(error))?.[0] ?? 'BOUNDED_EXPERIMENT_FAILED';
const address = (value) => {
  if (typeof value !== 'string') return null;
  const ip = value.replace(/^\[|\]$/g, '');
  if (net.isIP(ip) === 4) return ip;
  if (net.isIP(ip) === 6) return new URL(`http://[${ip}]`).hostname.slice(1, -1);
  return null;
};

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-af-counterexample-'));
  const results = [];
  try {
    for (const mode of ['normal-dns', 'forced-aaaa']) {
      const [config, version, rules, direct, dns] = await Promise.all([
        control('configs'), control('version'), control('rules'), control('proxies/DIRECT'),
        control(`dns/query?name=${target.hostname}&type=AAAA`),
      ]);
      if (config.mode !== 'rule' || config.tun?.enable !== true || config.ipv6 !== false)
        throw new Error('EXPECTED_RULE_TUN_IPV6_FALSE');
      if (direct.type !== 'Direct' || direct['dialer-proxy'] !== '') throw new Error('DIRECT_POLICY_UNVERIFIED');
      const first = rules.rules.find((r) => String(r.type).replace(/[-_]/g, '').toLowerCase() === 'domain' && r.payload === target.hostname);
      if (!first || first.proxy !== 'DIRECT') throw new Error('TARGET_DOMAIN_RULE_REQUIRED');
      const answers = (dns.Answer ?? []).filter((r) => r.type === 28 && net.isIP(r.data) === 6);
      if (dns.Status !== 0 || !answers.length) throw new Error('NO_CURRENT_PUBLIC_AAAA');
      const mapping = mode === 'forced-aaaa' ? answers[0].data : '';
      const childRoot = path.join(parentRoot, mode); fs.mkdirSync(childRoot);
      const env = { ...process.env, SV_AF_EXPERIMENT_ROOT: childRoot, SV_AF_EXPERIMENT_MODE: mode,
        SV_AF_EXPERIMENT_MAPPING: mapping };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_ENABLE_LOGGING;
      delete env.ELECTRON_LOG_FILE;
      const child = spawn(electron, [script], { cwd: repository, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      const timer = setTimeout(() => child.kill(), 35_000);
      const code = await new Promise((resolve) => { child.once('error', () => resolve(-1)); child.once('exit', (c) => resolve(c)); });
      clearTimeout(timer);
      const file = path.join(childRoot, 'result.json');
      const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { error: 'NO_CHILD_RESULT' };
      const [after, afterRules] = await Promise.all([control('configs'), control('rules')]);
      results.push({ mode, domain: target.hostname, resourceClass: 'public-robots-light-get', childExitCode: code,
        kernelVersion: version.version, observedMode: config.mode, tun: config.tun.enable, globalIpv6: config.ipv6,
        aaaaCount: answers.length, selectedAaaaDigest: mapping ? hash(mapping) : null,
        selectedDnsTtlSeconds: mode === 'forced-aaaa' ? answers[0].TTL : null,
        visibleConfigAndRulesUnchanged: hash([config, rules]) === hash([after, afterRules]), ...local });
    }
  } catch (error) { results.push({ error: errorCode(error) }); }
  finally {
    const absolute = fs.realpathSync(parentRoot);
    if (path.dirname(absolute) !== fs.realpathSync(os.tmpdir()) || !path.basename(absolute).startsWith('sv-af-counterexample-'))
      throw new Error('UNSAFE_EXPERIMENT_CLEANUP');
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const forced = results.find((entry) => entry.mode === 'forced-aaaa');
  const counterexample = forced?.cdp?.remoteAddressFamily === 6 && forced.socketAttribution.uniqueFreshSocket === true &&
    forced.socketAttribution.remoteAddressFamily === 6 && forced.certificateError === false;
  const result = { executedAt: new Date().toISOString(), anonymousRequestBudget: 2, netLogUsed: false,
    productionModified: false, userConfigModified: false, realAccountsUsed: false,
    forcedMappingIsNegativeExperimentOnly: true, failureDoesNotProveIpv6Disabled: true,
    conclusion: counterexample ? 'CHROMIUM_IPV6_WORKED_WITH_GLOBAL_IPV6_FALSE' : 'NOT_ESTABLISHED_NO_IPV4_ONLY_PROOF', results };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ resultPath, ...result }, null, 2));
} else {
  run().catch(async (error) => {
    fs.writeFileSync(path.join(process.env.SV_AF_EXPERIMENT_ROOT, 'result.json'), JSON.stringify({ error: errorCode(error) }));
    const { app } = await import('electron'); app.exit(1);
  });
}

async function run() {
  const { app, session, BrowserWindow } = await import('electron');
  const root = process.env.SV_AF_EXPERIMENT_ROOT;
  const mode = process.env.SV_AF_EXPERIMENT_MODE;
  const mapping = address(process.env.SV_AF_EXPERIMENT_MAPPING);
  if (!root || !path.basename(path.dirname(root)).startsWith('sv-af-counterexample-') ||
    !['normal-dns', 'forced-aaaa'].includes(mode) || (mode === 'forced-aaaa' && net.isIP(mapping) !== 6))
    throw new Error('ISOLATED_EXPERIMENT_REQUIRED');
  app.setPath('userData', path.join(root, 'userData'));
  app.setPath('sessionData', path.join(root, 'sessionData'));
  for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-http-cache', 'disable-quic'])
    app.commandLine.appendSwitch(flag);
  if (mapping) app.commandLine.appendSwitch('host-resolver-rules', `MAP ${target.hostname} [${mapping}]`);
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  let certificateError = false;
  app.on('certificate-error', (_event, _wc, _url, _error, _certificate, callback) => { certificateError = true; callback(false); });
  app.on('login', (event, _wc, _details, _auth, callback) => { event.preventDefault(); callback(); });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  const isolated = session.fromPartition(`anonymous-af-${crypto.randomUUID()}`);
  let admittedRequests = 0, blockedRequests = 0, credentialHeaderSeen = false;
  isolated.webRequest.onBeforeRequest((details, callback) => {
    if (details.url === 'about:blank') return callback({ cancel: false });
    const allowed = details.url === target.href && details.method === 'GET' && admittedRequests === 0;
    if (allowed) admittedRequests++; else blockedRequests++;
    callback({ cancel: !allowed });
  });
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (/^(cookie|authorization|proxy-authorization)$/i.test(key)) {
      credentialHeaderSeen = true; delete headers[key];
    }
    callback({ requestHeaders: headers });
  });
  isolated.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (/^set-cookie$/i.test(key)) delete headers[key];
    callback({ responseHeaders: headers });
  });
  await isolated.setProxy({ mode: 'direct' });
  await isolated.closeAllConnections();
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('about:blank');
  window.webContents.debugger.attach('1.3');
  let response = null, loadingError = null;
  const requestIds = new Set();
  window.webContents.debugger.on('message', (_event, method, p) => {
    if (method === 'Network.requestWillBeSent' && p.request.url === target.href) requestIds.add(p.requestId);
    if (method === 'Network.responseReceived' && p.response.url === target.href) response = p.response;
    if (method === 'Network.loadingFailed' && requestIds.has(p.requestId)) loadingError = errorCode(p.errorText);
  });
  await window.webContents.debugger.sendCommand('Network.enable');
  await window.webContents.debugger.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
  const readSockets = async () => {
    const metrics = app.getAppMetrics().filter((m) => m.serviceName === 'network.mojom.NetworkService');
    const pids = metrics.map((m) => m.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
    if (!pids.length) return { pids, rows: [] };
    const command = `$afPids = @(${pids.join(',')}); @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $afPids -contains $_.OwningProcess -and $_.RemotePort -eq 443 } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess,State) | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 6000 });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return { pids, rows: Array.isArray(parsed) ? parsed : [parsed] };
  };
  const beforeSockets = await readSockets();
  const beforeConnections = await control('connections');
  const oldConnections = new Set((beforeConnections.connections ?? []).map((c) => c.id));
  const tupleKey = (r) => `${r.OwningProcess}:${address(r.LocalAddress)}:${r.LocalPort}:${address(r.RemoteAddress)}:${r.RemotePort}`;
  const oldTuples = new Set(beforeSockets.rows.map(tupleKey));
  const startedAtMs = Date.now();
  let fetchOutcome;
  let requestTimer;
  try {
    await Promise.race([window.loadURL(target.href), new Promise((_, reject) => {
      requestTimer = setTimeout(() => { window.webContents.stop(); reject(new Error('REQUEST_TIMEOUT')); }, 8000);
    })]);
    fetchOutcome = 'completed';
  } catch { fetchOutcome = 'failed_or_timed_out'; }
  finally { clearTimeout(requestTimer); }
  const afterSockets = await readSockets();
  const afterConnections = await control('connections');
  const actualRemote = address(response?.remoteIPAddress);
  const candidates = afterSockets.rows.filter((r) => !oldTuples.has(tupleKey(r)) &&
    afterSockets.pids.includes(r.OwningProcess) && beforeSockets.pids.includes(r.OwningProcess) &&
    actualRemote && address(r.RemoteAddress) === actualRemote && r.RemotePort === response.remotePort);
  const source = candidates.length === 1 && response?.connectionReused === false ? candidates[0] : null;
  const matching = source ? (afterConnections.connections ?? []).filter((c) => {
    const m = c.metadata ?? {};
    return !oldConnections.has(c.id) && m.host === target.hostname && m.network === 'tcp' &&
      Number(m.sourcePort) === source.LocalPort && address(m.sourceIP) === address(source.LocalAddress) &&
      Number(m.destinationPort) === 443 && Date.parse(c.start) >= startedAtMs - 100;
  }) : [];
  const connection = matching.length === 1 ? matching[0] : null;
  const direct = connection?.chains?.length === 1 && connection.chains[0] === 'DIRECT';
  const cookieCount = (await isolated.cookies.get({})).length;
  const result = { electron: process.versions.electron, chromium: process.versions.chrome,
    temporaryProfile: true, defaultSessionBlocked: true, setDirectThenClosedConnections: true,
    quicDisabledForExperiment: true, resolverMappingApplied: !!mapping, admittedRequests, blockedRequests,
    fetchOutcome, loadingError, credentialHeaderSeen, storedCookieCount: cookieCount, certificateError,
    cdp: response ? { remoteAddressFamily: net.isIP(actualRemote), remotePort: response.remotePort,
      connectionReused: response.connectionReused, protocol: response.protocol, status: response.status,
      fromDiskCache: response.fromDiskCache, fromServiceWorker: response.fromServiceWorker,
      tlsProtocol: response.securityDetails?.protocol ?? null } : null,
    socketAttribution: { candidates: candidates.length, uniqueFreshSocket: !!source,
      sourcePort: source?.LocalPort ?? null, sourceAddressFamily: source ? net.isIP(address(source.LocalAddress)) : null,
      remoteAddressFamily: source ? net.isIP(address(source.RemoteAddress)) : null,
      networkServicePidStable: beforeSockets.pids.length === 1 && beforeSockets.pids[0] === afterSockets.pids[0] },
    kernelAttribution: { matches: matching.length, correlated: !!connection,
      sourceTupleRequiredForMatch: !!source, chain: connection ? (direct ? 'DIRECT' : 'NON_DIRECT') : 'UNATTRIBUTED',
      nonDirectChainDigest: connection && !direct ? hash(connection.chains ?? null) : null,
      inboundType: connection?.metadata?.type ?? null,
      destinationAddressFamily: net.isIP(address(connection?.metadata?.destinationIP)),
      dialedRemoteAddressFamily: net.isIP(address(connection?.metadata?.remoteDestination)),
      processFieldPresent: !!connection?.metadata?.process,
      ruleType: connection?.rule ?? null },
    productionPathApplicabilityVerified: false };
  window.destroy(); await isolated.closeAllConnections();
  fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
}
