/** Read-only phase-2 evidence: DNS candidates and isolated, loopback-only NetLog scope. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '..');
const output = path.join(repository, 'docs/network-stage2-proof-issuer-evidence.results.json');
const control = async (endpoint) => {
  const response = await fetch(`http://127.0.0.1:9790/${endpoint}`, {
    signal: AbortSignal.timeout(4000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
};
const fingerprint = (data) => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');

async function controllerEvidence() {
  const startedAt = new Date().toISOString();
  const [version, config, direct, rules] = await Promise.all([
    control('version'), control('configs'), control('proxies/DIRECT'), control('rules'),
  ]);
  if (config.mode !== 'rule' || config.tun?.enable !== true) throw new Error('Rule + TUN required; no configuration is changed');
  const hosts = [...fs.readFileSync(path.join(repository, 'docs/network-stage2-direct-candidates.yaml'), 'utf8')
    .matchAll(/^\s*- DOMAIN,([^,\s]+),DIRECT\s*$/gm)].map((match) => match[1]);
  const results = [];
  // Two DNS queries in flight at most; never send HTTP traffic to account endpoints.
  for (const host of hosts) {
    const answers = await Promise.all(['A', 'AAAA'].map(async (type) => {
      try {
        const answer = await control(`dns/query?name=${encodeURIComponent(host)}&type=${type}`);
        return { type, status: answer.Status, answers: (answer.Answer ?? []).map((rr) => ({
          name: rr.name, type: rr.type, ttl: rr.TTL, data: rr.data,
        })) };
      } catch (error) { return { type, error: error.message }; }
    }));
    results.push({ host, answers });
  }
  const [after, rulesAfter] = await Promise.all([control('configs'), control('rules')]);
  const selected = (c) => ({ mode: c.mode, ipv6: c.ipv6, interfaceName: c['interface-name'],
    routingMark: c['routing-mark'], processMode: c['find-process-mode'], tcpConcurrent: c['tcp-concurrent'],
    tun: { enabled: c.tun?.enable, stack: c.tun?.stack, autoRoute: c.tun?.['auto-route'],
      autoDetectInterface: c.tun?.['auto-detect-interface'], strictRoute: c.tun?.['strict-route'] ?? null } });
  return { startedAt, completedAt: new Date().toISOString(), version, before: selected(config), after: selected(after),
    selectedConfigUnchanged: fingerprint(selected(config)) === fingerprint(selected(after)),
    rulesUnchanged: fingerprint(rules) === fingerprint(rulesAfter), rulesDigest: fingerprint(rules),
    ruleCount: rules.rules?.length ?? null,
    direct: { type: direct.type, interface: direct.interface, routingMark: direct['routing-mark'],
      dialerProxy: direct['dialer-proxy'], publicFieldNames: Object.keys(direct).sort() },
    dns: results };
}

if (!process.versions.electron) {
  const { default: electron } = await import('electron');
  const { spawn } = await import('node:child_process');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-proof-evidence-'));
  const env = { ...process.env, SV_PROOF_EVIDENCE_ROOT: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [script], { cwd: repository, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let childDiagnostic = '';
  child.stderr.on('data', (chunk) => { childDiagnostic = `${childDiagnostic}${chunk}`.slice(-2000); });
  const timer = setTimeout(() => child.kill(), 45_000);
  const exit = new Promise((resolve) => { child.once('error', () => resolve(1)); child.once('exit', (code) => resolve(code)); });
  let result;
  try {
    const [controller, code] = await Promise.all([
      process.argv.includes('--reuse-dns') ? Promise.resolve(JSON.parse(fs.readFileSync(output, 'utf8')).controller) : controllerEvidence(), exit,
    ]);
    const localPath = path.join(temporary, 'result.json');
    const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {
      error: 'NO_FIXTURE_RESULT', childExitCode: code,
      lastStage: fs.existsSync(path.join(temporary, 'stage.txt')) ? fs.readFileSync(path.join(temporary, 'stage.txt'), 'utf8') : 'MODULE_NOT_STARTED',
    };
    result = { executedAt: new Date().toISOString(), controllerReadOnly: true, anyAccountOpened: false,
      dnsSampleReused: process.argv.includes('--reuse-dns'),
      controller, loopbackNetLogExperiment: local, childExitCode: code };
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ output, childExitCode: code, loopback: local,
      dnsHosts: controller.dns.length, unchanged: controller.rulesUnchanged && controller.selectedConfigUnchanged }, null, 2));
    if (local.error) console.error(childDiagnostic);
    if (local.error || code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    if (!result) child.kill();
    const resolved = path.resolve(temporary);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('sv-proof-evidence-')) throw new Error('Unsafe cleanup target');
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
} else {
  void runLoopback().catch(async () => {
    fs.writeFileSync(path.join(process.env.SV_PROOF_EVIDENCE_ROOT, 'result.json'), JSON.stringify({ error: 'LOOPBACK_FIXTURE_FAILED' }));
    const { app } = await import('electron');
    app.exit(1);
  });
}

async function runLoopback() {
  const stage = (name) => fs.writeFileSync(path.join(process.env.SV_PROOF_EVIDENCE_ROOT, 'stage.txt'), name);
  stage('IMPORT_ELECTRON');
  const { app, session, BrowserWindow } = await import('electron');
  const temporary = process.env.SV_PROOF_EVIDENCE_ROOT;
  if (!temporary || !path.basename(temporary).startsWith('sv-proof-evidence-')) throw new Error('Isolated profile required');
  app.setPath('userData', path.join(temporary, 'userData'));
  app.setPath('sessionData', path.join(temporary, 'sessionData'));
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  stage('APP_READY');
  await app.whenReady();
  stage('LOCAL_SERVER');
  const serverPorts = [];
  const server = http.createServer((request, response) => {
    serverPorts.push(request.socket.remotePort);
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Local synthetic scope fixture</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = session.fromPartition(`proof-a-${crypto.randomUUID()}`);
  const b = session.fromPartition(`proof-b-${crypto.randomUUID()}`);
  for (const isolated of [a, b]) {
    stage('DIRECT_SESSION');
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(`${base}/`) && details.url !== 'about:blank' });
    });
    await isolated.setProxy({ mode: 'direct' });
    await isolated.closeAllConnections();
  }
  const window = new BrowserWindow({ show: false, webPreferences: { session: b, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('about:blank');
  stage('DEBUGGER');
  const cdpResponses = [];
  window.webContents.debugger.attach('1.3');
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Network.responseReceived' || !params.response.url.startsWith(`${base}/`)) return;
    const response = params.response;
    cdpResponses.push({ fieldNames: Object.keys(response).sort(), remoteIPAddress: response.remoteIPAddress,
      remotePort: response.remotePort, connectionId: response.connectionId,
      connectionReused: response.connectionReused, protocol: response.protocol,
      localPortPresent: Object.hasOwn(response, 'localPort') || Object.hasOwn(response, 'sourcePort') });
  });
  await window.webContents.debugger.sendCommand('Network.enable');
  const log = path.join(temporary, 'a-only-requested.netlog.json');
  stage('START_LOG');
  await a.netLog.startLogging(log, { captureMode: 'default', maxFileSize: 2 * 1024 * 1024 });
  stage('LOAD_B');
  await window.loadURL(`${base}/session-b?synthetic_secret=B_ONLY_NON_SECRET_MARKER`);
  stage('FETCH_A');
  const response = await a.fetch(`${base}/session-a?synthetic_secret=A_ONLY_NON_SECRET_MARKER`, { credentials: 'omit' });
  await response.text();
  const localMetrics = app.getAppMetrics().filter((m) => m.serviceName === 'network.mojom.NetworkService');
  const localPids = localMetrics.map((m) => m.pid).filter((p) => Number.isInteger(p) && p > 0);
  const localCommand = `$proofPids = @(${localPids.join(',')}); @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $proofPids -contains $_.OwningProcess -and $_.RemoteAddress -eq '127.0.0.1' -and $_.RemotePort -eq ${server.address().port} } | Select-Object LocalPort,OwningProcess) | ConvertTo-Json -Compress`;
  const localSocketOutput = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', localCommand], { windowsHide: true, timeout: 6000 });
  const localSocketParsed = localSocketOutput.stdout.trim() ? JSON.parse(localSocketOutput.stdout) : [];
  const localSocketCandidates = Array.isArray(localSocketParsed) ? localSocketParsed : [localSocketParsed];
  stage('STOP_LOG');
  await a.netLog.stopLogging();
  const raw = fs.readFileSync(log, 'utf8');
  const result = { electron: process.versions.electron, chromium: process.versions.chrome,
    temporaryUserData: true, anyCookieSet: false, realAccountOpened: false, requestDestination: 'loopback only',
    loggingStartedOn: 'Session A', loggingCaptureMode: 'default',
    recordedAQueryMarker: raw.includes('A_ONLY_NON_SECRET_MARKER'),
    recordedOtherSessionBQueryMarker: raw.includes('B_ONLY_NON_SECRET_MARKER'),
    cdpResponses, controlledServerObservedLocalSourcePorts: [...new Set(serverPorts)],
    sameDestinationOtherSessionExperiment: { matchingSocketCandidates: localSocketCandidates,
      ambiguityRejected: localSocketCandidates.length !== 1, anyCandidateAssignedToSession: false } };
  window.destroy();
  await Promise.all([a.closeAllConnections(), b.closeAllConnections()]);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  stage('ANONYMOUS_TRANSPORT_WITHOUT_NETLOG');
  result.anonymousTransport = await runAnonymousTransport({ app, session, BrowserWindow });
  fs.writeFileSync(path.join(temporary, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  app.exit(0);
}

async function runAnonymousTransport({ app, session, BrowserWindow }) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const config = await control('configs');
  const rulesBefore = await control('rules');
  if (config.mode !== 'rule' || !config.tun?.enable) return { error: 'RULE_TUN_REQUIRED' };
  const target = new URL('https://www.bilibili.com/robots.txt');
  const isolated = session.fromPartition(`proof-transport-${crypto.randomUUID()}`);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: details.url !== 'about:blank' && details.url !== target.href,
  }));
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) if (/^(cookie|authorization|proxy-authorization)$/i.test(key)) delete headers[key];
    callback({ requestHeaders: headers });
  });
  isolated.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) if (/^set-cookie$/i.test(key)) delete headers[key];
    callback({ responseHeaders: headers });
  });
  await isolated.setProxy({ mode: 'direct' });
  await isolated.closeAllConnections();
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('about:blank');
  window.webContents.debugger.attach('1.3');
  let cdpResponse;
  window.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Network.responseReceived' && params.response.url === target.href) {
      const r = params.response;
      cdpResponse = { remoteIPAddress: r.remoteIPAddress, remotePort: r.remotePort,
        connectionId: r.connectionId, connectionReused: r.connectionReused, protocol: r.protocol,
        status: r.status, fromDiskCache: r.fromDiskCache, fromServiceWorker: r.fromServiceWorker };
    }
  });
  await window.webContents.debugger.sendCommand('Network.enable');
  const readSockets = async () => {
    const metrics = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? null, serviceName: m.serviceName ?? null }));
    const pids = metrics.map((m) => m.pid).filter((p) => Number.isInteger(p) && p > 0);
    const command = `$proofPids = @(${pids.join(',')}); @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $proofPids -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,State,OwningProcess,CreationTime) | ConvertTo-Json -Compress`;
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 6000 });
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    return { metrics, rows: Array.isArray(parsed) ? parsed : [parsed] };
  };
  const before = await readSockets();
  const baseline = new Set(before.rows.map((r) => `${r.OwningProcess}:${r.LocalAddress}:${r.LocalPort}:${r.RemoteAddress}:${r.RemotePort}`));
  let navigationOutcome = 'completed';
  try {
    await Promise.race([window.loadURL(target.href), delay(8000).then(() => { throw new Error('BOUNDED_TIMEOUT'); })]);
  } catch { navigationOutcome = 'failed_or_timed_out'; }
  const after = await readSockets();
  const matchingRows = after.rows.filter((r) => cdpResponse && r.RemoteAddress === cdpResponse.remoteIPAddress && r.RemotePort === cdpResponse.remotePort)
    .map((r) => ({ localAddress: r.LocalAddress, sourcePort: r.LocalPort, remoteAddress: r.RemoteAddress,
      remotePort: r.RemotePort, owningProcess: r.OwningProcess, state: r.State,
      newTuple: !baseline.has(`${r.OwningProcess}:${r.LocalAddress}:${r.LocalPort}:${r.RemoteAddress}:${r.RemotePort}`) }));
  const connectionSnapshot = await control('connections');
  const projectConnection = (c) => ({ connectionId: c.id, host: c.metadata.host,
    sourcePort: Number(c.metadata.sourcePort), destinationIP: c.metadata.destinationIP,
    remoteDestination: c.metadata.remoteDestination ?? null,
    remoteDestinationFamily: net.isIP(c.metadata.remoteDestination ?? '') || null,
    destinationPort: Number(c.metadata.destinationPort), dnsMode: c.metadata.dnsMode,
    network: c.metadata.network, inboundType: c.metadata.type, process: c.metadata.process,
    processPath: c.metadata.processPath,
    chainClass: c.chains?.length === 1 && c.chains[0] === 'DIRECT' ? 'DIRECT' : 'NON_DIRECT_OR_UNKNOWN',
    rule: c.rule, rulePayloadMatchesHost: c.rulePayload === c.metadata.host });
  const chromiumConnections = (connectionSnapshot.connections ?? []).filter((c) => c.metadata.host === target.hostname
    && matchingRows.some((r) => r.sourcePort === Number(c.metadata.sourcePort))).map(projectConnection);
  window.destroy();
  await isolated.closeAllConnections();
  const nodeTarget = 'myip.ipip.net';
  const nodeSocket = tls.connect({ host: nodeTarget, port: 443, servername: nodeTarget });
  nodeSocket.on('error', () => {});
  const tlsReady = await Promise.race([
    new Promise((resolve) => { nodeSocket.once('secureConnect', () => resolve(true)); nodeSocket.once('error', () => resolve(false)); }),
    delay(6000).then(() => false),
  ]);
  const nodeEvidence = { host: nodeTarget, handshakeVerified: tlsReady && nodeSocket.authorized,
    sourcePort: nodeSocket.localPort, socketRemoteAddress: nodeSocket.remoteAddress, socketRemoteFamily: nodeSocket.remoteFamily,
    httpRequestSent: false, metadata: [] };
  const until = Date.now() + 1600;
  while (Date.now() < until && !nodeEvidence.metadata.length) {
    const snapshot = await control('connections');
    nodeEvidence.metadata = (snapshot.connections ?? []).filter((c) => c.metadata.host === nodeTarget
      && Number(c.metadata.sourcePort) === nodeSocket.localPort && Number(c.metadata.destinationPort) === 443).map(projectConnection);
    if (!nodeEvidence.metadata.length) await delay(120);
  }
  nodeSocket.destroy();
  const [configAfter, rulesAfter] = await Promise.all([control('configs'), control('rules')]);
  return { netLogUsed: false, anonymousOnly: true, chromium: { host: target.hostname, navigationOutcome,
    cdpResponse, processMetrics: after.metrics, socketCandidates: matchingRows, matchingConnections: chromiumConnections,
    ambiguityRejected: matchingRows.length !== 1, productionSessionAttributionVerified: false }, nodeTls: nodeEvidence,
    controllerSnapshotUnchanged: fingerprint([config, rulesBefore]) === fingerprint([configAfter, rulesAfter]) };
}
