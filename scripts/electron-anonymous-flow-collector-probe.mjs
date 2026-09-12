/** One explicit production AnonymousFlowCollector observation; default invocation only builds. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), '..');
const host = 'api.bilibili.com', publicUrl = `https://${host}/robots.txt`;
const controllerUrl = 'http://127.0.0.1:9790';
const resources = 'C:/Users/Administrator/AppData/Local/Programs/MAOMAOYUNAPP/resources';
const resultPath = path.join(root, 'docs/network-anonymous-flow-collector-probe.results.json');
const explicitRun = process.argv.includes('--single-public-run');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (value, code) => { if (!value) throw Error(code); };
const safeError = error => /^[A-Z_]{1,100}$/.test(error?.message ?? '') ? error.message : 'OBSERVATION_UNAVAILABLE';
const hashAddress = value => typeof value === 'string' ? sha(value.toLowerCase()) : null;
const projectSocket = row => ({ sourceAddressHash: hashAddress(row.sourceAddress), sourcePort: row.sourcePort,
  remoteAddressHash: hashAddress(row.remoteAddress), remotePort: row.remotePort, ownerPid: row.ownerPid ?? null, state: row.state ?? null });
async function bounded(work, ms) { let timer; try { return await Promise.race([work,
  new Promise((_, reject) => { timer = setTimeout(() => reject(Error('BOUNDED_TIMEOUT')), ms); })]);
} finally { clearTimeout(timer); } }
let lastResort = () => {};
if (!process.versions.electron) await parent();
else void child().catch(error => { lastResort(error); process.exit(1); });

async function parent() {
  const buildOnly = !explicitRun || process.argv.includes('--build-only');
  assert(!(explicitRun && process.argv.includes('--build-only')), 'CONFLICTING_RUN_MODES');
  if (!buildOnly) assert(!fs.existsSync(resultPath), 'SINGLE_RUN_RESULT_ALREADY_EXISTS');
  const { build } = await import('esbuild'), { default: electron } = await import('electron');
  const temporaryParent = path.join(root, 'docs/.compare'); fs.mkdirSync(temporaryParent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(temporaryParent, 'anonymous-flow-collector-')); let result;
  try {
    const built = await build({ stdin: { contents: [
      "export {AnonymousFlowCollector} from './src/main/network/anonymous-flow-collector.ts';",
      "export {AnonymousNetLogCapture} from './src/main/network/anonymous-netlog-capture.ts';",
      "export {SelectedClientConfig} from './src/main/network/selected-client-config.ts';",
      "export {ClashReader} from './src/main/network/clash-reader.ts';",
      "export {PathInputReader} from './src/main/network/path-input-reader.ts';",
      "export {KernelDnsReader} from './src/main/network/kernel-dns.ts';",
      "export {WindowsControllerOwnerReader} from './src/main/network/windows-controller-owner.ts';",
      "export {WindowsNetworkFingerprintReader} from './src/main/network/windows-network-fingerprint.ts';",
      "export {WindowsSystemHostsReader} from './src/main/network/windows-system-hosts.ts';",
      "export {WindowsTcpSocketReader} from './src/main/network/windows-tcp-sockets.ts';",
      "export {parseScopedConnections,connectionHostScope} from './src/main/network/connection-evidence.ts';",
      "export {classifyCurrentKernelDnsAddress} from './src/main/network/kernel-dns-address-policy.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './src/main/network/chromium-transport.ts';",
      "export {parseAnonymousRequestSocket} from './src/main/network/anonymous-request-socket.ts';",
    ].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm',
      external: ['electron', 'node:*'], tsconfig: path.join(root, 'tsconfig.electron.json'),
      outfile: path.join(temporary, 'production.mjs'), metafile: true, logLevel: 'silent' });
    const hashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(file => file.startsWith('src/'))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    if (buildOnly) { console.log(JSON.stringify({ buildOnly: true, sourceFiles: Object.keys(hashes),
      sourceHashes: hashes, accountSessions: 0, controllerRequests: 0, publicRequestsIssued: 0 }, null, 2)); return; }
    const env = { ...process.env, CLIPDOCK_FLOW_COLLECTOR_ROOT: temporary }; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, '--single-public-run'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
    let watchdog = false;
    const timer = setTimeout(() => { watchdog = true; worker.kill(); }, 50000);
    const code = await new Promise(resolve => { worker.once('error', () => resolve(1)); worker.once('exit', value => resolve(value ?? 1)); }); clearTimeout(timer);
    result = fs.existsSync(path.join(temporary, 'result.json')) ? JSON.parse(fs.readFileSync(path.join(temporary, 'result.json'), 'utf8'))
      : { failure: 'CHILD_RESULT_MISSING', requestCountUnavailable: true, qualificationGranted: false };
    result.childExitCode = code; result.parentWatchdogFired = watchdog; result.sourceHashes = hashes;
    result.scriptHash = sha(fs.readFileSync(script)); result.bundleHash = sha(fs.readFileSync(path.join(temporary, 'production.mjs')));
    result.sourceHashesStable = Object.entries(hashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
    if (!result.sourceHashesStable) result.observationRetained = false;
  } finally {
    const exact = path.resolve(temporary);
    assert(path.dirname(exact) === path.resolve(temporaryParent) && path.basename(exact).startsWith('anonymous-flow-collector-'), 'UNSAFE_TEMPORARY_PATH');
    assert(fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), 'TEMPORARY_PATH_CHANGED');
    await new Promise(resolve => setTimeout(resolve, 200));
    try { fs.rmSync(exact, { recursive: true }); } catch { /* Retain exact cleanup failure; never try a different target. */ }
    if (result) result.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (result) {
    assert(!fs.existsSync(resultPath), 'SINGLE_RUN_RESULT_ALREADY_EXISTS');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ executedAt: result.executedAt, counts: result.counts, checks: result.checks,
      collectorResult: result.collectorResult, observationRetained: result.observationRetained,
      sourceHashesStable: result.sourceHashesStable, rawTemporaryDataRemoved: result.rawTemporaryDataRemoved,
      cleanup: result.cleanup, failure: result.failure ?? null }, null, 2));
    process.exitCode = result.failure || result.childExitCode || !result.sourceHashesStable || !result.rawTemporaryDataRemoved ? 1 : 0;
  }
}

async function child() {
  const { app, session, net, BrowserWindow, webContents } = await import('electron');
  const temporary = process.env.CLIPDOCK_FLOW_COLLECTOR_ROOT;
  assert(explicitRun && temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, 'docs/.compare') &&
    path.basename(temporary).startsWith('anonymous-flow-collector-'), 'ISOLATION_REQUIRED');
  app.setPath('userData', path.join(temporary, 'userData')); app.setPath('sessionData', path.join(temporary, 'sessionData'));
  app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('host-resolver-rules', `MAP * ~NOTFOUND, EXCLUDE ${host}`);
  app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
  const production = await import(pathToFileURL(path.join(temporary, 'production.mjs')).href);
  production.configureChromiumTransport(app);
  const result = { executedAt: new Date().toISOString(), kind: 'production-anonymous-flow-collector-probe', target: { host, port: 443, protocol: 'https:', addressFamily: 'ipv4' },
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, transport: production.readChromiumTransportState(app) },
    isolation: { temporaryUserData: true, applicationBootstrapImported: false, sessionApiReplaced: false, sessionFetchReplaced: false,
      accountDataUsed: false, configurationChanged: false, osConfigurationChanged: false, historicalReportInput: false,
      physicalPacketCapture: false, netLog: 'production-private-capability-in-isolated-zero-window-process' },
    counts: { collectorCalls: 0, controllerReads: 0, controllerRequests: 0, connectionsReads: 0, kernelQueries: 0,
      inputsReads: 0, windowsTcpReads: 0, captureStarts: 0, captureFinishes: 0, publicNativeRequests: 0,
      nativeTransportEntries: 0, blockedUnexpectedTransports: 0, anonymousSessions: 0, accountSessions: 0,
      windowsCreated: 0, webContentsCreated: 0, quietChecks: 0 }, checks: [], inputs: [], dns: [], connections: [],
    collectorResult: null, observationRetained: false, qualificationGranted: false, permitIssued: false };
  const checkpoint = phase => { result.phase = phase; result.checkpointAtMono = performance.now(); fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(result)); };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  lastResort = error => { result.failure = safeError(error); try { checkpoint('top-level-failure'); } catch { /* Parent records missing checkpoint. */ } };
  const deadline = new AbortController(); let collector, selection, owner, hostsReader, dns, inputs, currentController, version;
  let capturedSession = null, originalSessionFetch = null, quietRevoked = false, collecting = false;
  let controllerTail = Promise.resolve(); const work = new Set(); const captures = [];
  const track = promise => { work.add(promise); void promise.then(() => work.delete(promise), () => work.delete(promise)); return promise; };
  const guard = signal => { assert(!deadline.signal.aborted && !signal?.aborted, 'EXPERIMENT_CANCELLED'); };
  const isQuiescent = () => { result.counts.quietChecks++; return !quietRevoked && !deadline.signal.aborted &&
    result.counts.accountSessions === 0 && result.counts.windowsCreated === 0 && result.counts.webContentsCreated === 0 &&
    BrowserWindow.getAllWindows().length === 0 && webContents.getAllWebContents().length === 0 &&
    path.resolve(app.getPath('userData')) === path.resolve(temporary, 'userData'); };
  for (const event of ['browser-window-created', 'web-contents-created']) app.on(event, () => {
    result.counts[event === 'browser-window-created' ? 'windowsCreated' : 'webContentsCreated']++; quietRevoked = true;
    deadline.abort(); checkpoint('quiet-window-revoked');
  });
  for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
    result.failure = safeError(error); result.fatalEvent = event; checkpoint('fatal-event'); deadline.abort(); app.exit(1);
  });
  const timer = setTimeout(() => { result.failure = 'EXPERIMENT_TIMEOUT'; deadline.abort(); checkpoint('deadline'); app.exit(1); }, 45000);
  checkpoint('startup');
  try {
    await app.whenReady(); check('ACTUAL_APPLICATION_QUIET', isQuiescent());
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
    const { default: http } = await import('node:http'), { default: https } = await import('node:https');
    const { syncBuiltinESMExports } = await import('node:module'); const originalHttp = http.request;
    http.request = function(options, callback) {
      const url = new URL(options.path, controllerUrl);
      const fixed = ['/configs', '/rules', '/version', '/proxies/DIRECT', '/connections'].includes(url.pathname) && !url.search;
      const dnsQuery = url.pathname === '/dns/query' && url.searchParams.get('name') === host &&
        ['A', 'AAAA'].includes(url.searchParams.get('type')) && [...url.searchParams.keys()].length === 2;
      assert(options.hostname === '127.0.0.1' && Number(options.port) === 9790 && options.method === 'GET' && (fixed || dnsQuery), 'HTTP_SCOPE_INVALID');
      assert(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)), 'HTTP_CREDENTIALS_FORBIDDEN');
      assert(++result.counts.controllerRequests <= 160, 'CONTROLLER_REQUEST_BUDGET'); return originalHttp.call(this, options, callback);
    };
    const forbid = () => { throw Error('UNEXPECTED_NETWORK_ENTRY'); };
    http.get = forbid; https.request = forbid; https.get = forbid; globalThis.fetch = forbid; net.fetch = forbid; syncBuiltinESMExports();
    app.on('session-created', created => {
      if (!collecting || created.storagePath !== null || capturedSession) {
        result.counts.accountSessions++; quietRevoked = true; deadline.abort(); checkpoint('unexpected-session'); return;
      }
      capturedSession = created; originalSessionFetch = capturedSession.fetch; result.counts.anonymousSessions++;
      checkpoint('anonymous-session-created');
    });
    const nativeRequest = net.request;
    net.request = options => {
      result.counts.nativeTransportEntries++; const url = options?.url instanceof URL ? options.url.href : options?.url;
      const allowed = capturedSession && options.session === capturedSession && url === publicUrl && options.method === 'GET' &&
        options.credentials === 'omit' && options.redirect === 'manual' &&
        (!Object.hasOwn(options, 'autoSessionCookies') || options.autoSessionCookies === false) &&
        (!Object.hasOwn(options, 'useSessionCookies') || options.useSessionCookies === false) &&
        result.counts.publicNativeRequests === 0 && isQuiescent();
      if (!allowed) {
        result.counts.blockedUnexpectedTransports++; checkpoint('unexpected-transport-blocked');
        // Reject asynchronously after Electron net-fetch has installed its error listener.
        const closed = new Writable({ autoDestroy: false, write(_chunk, _encoding, callback) { callback(); },
          final(callback) { callback(); queueMicrotask(() => closed.destroy(Error('UNEXPECTED_TRANSPORT'))); } });
        closed._urlLoaderOptions = {}; closed.setHeader = () => {}; closed.abort = () => closed.destroy(); return closed;
      }
      result.counts.publicNativeRequests++; checkpoint('single-native-request-forwarded'); return nativeRequest.call(net, options);
    };
    const reader = new production.ClashReader({ controllerUrl, getSecret: () => null });
    const readController = (signal = deadline.signal) => {
      const pending = track(controllerTail.catch(() => undefined).then(async () => {
        guard(signal); result.counts.controllerReads++; const value = await reader.read(); guard(signal);
        if (version && value.fingerprint !== version.rulesVersion) { deadline.abort(); throw Error('CONTROLLER_CHANGED'); }
        currentController = value; return value;
      })); controllerTail = pending; return pending;
    };
    const readConnections = (hosts, signal) => track((async () => {
      guard(signal); assert(hosts.length === 1 && hosts[0] === host, 'CONNECTION_SCOPE_INVALID');
      const startedAtMono = performance.now(); result.counts.connectionsReads++;
      const raw = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: 9790, path: '/connections', method: 'GET' }, response => {
          const chunks = []; let bytes = 0; response.on('data', chunk => { bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) req.destroy(Error('CONNECTIONS_LIMIT')); else chunks.push(chunk); });
          response.on('end', () => { try { assert(response.statusCode === 200, 'CONNECTIONS_STATUS'); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Error('CONNECTIONS_INVALID')); } });
          response.on('error', () => reject(Error('CONNECTIONS_UNAVAILABLE')));
        });
        const abort = () => req.destroy(Error('EXPERIMENT_CANCELLED')); signal.addEventListener('abort', abort, { once: true });
        req.once('close', () => signal.removeEventListener('abort', abort)); req.setTimeout(2500, () => req.destroy(Error('CONNECTIONS_TIMEOUT')));
        req.on('error', () => reject(Error('CONNECTIONS_UNAVAILABLE'))); req.end(); if (signal.aborted) abort();
      });
      guard(signal); const snapshot = { startedAtMono, completedAtMono: performance.now(), connections: production.parseScopedConnections(raw, production.connectionHostScope(hosts)) };
      result.connections.push({ startedAtMono, completedAtMono: snapshot.completedAtMono, count: snapshot.connections.length,
        rows: snapshot.connections.slice(0, 64).map(row => ({ idHash: sha(row.id), host: row.host, route: row.route,
          inboundType: row.inboundType, sourceAddressHash: hashAddress(row.sourceAddress), sourcePort: row.sourcePort,
          destinationIpHash: hashAddress(row.destinationIp), remoteDestinationIpHash: hashAddress(row.remoteDestinationIp), startedAtMs: row.startedAtMs })) });
      checkpoint('connections-read'); return snapshot;
    })());
    selection = new production.SelectedClientConfig({ resourcesPath: resources, readController });
    owner = new production.WindowsControllerOwnerReader({ controllerUrl }); hostsReader = new production.WindowsSystemHostsReader();
    const network = new production.WindowsNetworkFingerprintReader();
    const initialLoader = await selection.select(); check('CURRENT_LOADER_SELECTED', initialLoader !== null);
    const source = await selection.read(); check('CURRENT_SELECTED_SOURCE_AVAILABLE', source.state === 'candidate' && currentController);
    const loader = selection.getSelectedLoader(); check('CURRENT_READ_LOADER_RETAINED', loader !== null);
    version = { generation: 1, rulesVersion: currentController.fingerprint };
    result.initialSource = { loaderProfileId: loader.loaderProfileId, decoderIdentity: loader.decoderIdentity, sourcePathIdentity: loader.sourcePathIdentity,
      fileFingerprint: source.candidate.fileFingerprint, policyFingerprint: source.candidate.policy.fingerprint,
      controllerFingerprint: currentController.fingerprint, kernelVersion: currentController.version, mode: currentController.mode, tun: currentController.tun };
    dns = new production.KernelDnsReader({ reader: { readDnsQuery: (name, type, signal) => {
      assert(name === host && ++result.counts.kernelQueries <= 12, 'DNS_REQUEST_BUDGET'); return track(reader.readDnsQuery(name, type, signal)); } },
      readControllerVersion: async signal => { const value = await readController(signal); return { controllerVersion: value.fingerprint,
        startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono }; },
      classifyAddress: (address, controllerVersion) => { const selected = selection.getSnapshot();
        return production.classifyCurrentKernelDnsAddress(address, controllerVersion,
          { candidate: selected.state === 'candidate' ? selected.candidate : null, loader: selection.getSelectedLoader() }, performance.now()); } });
    const dnsReader = { read: async (...args) => {
      const value = await dns.read(...args); result.dns.push(value.available ? { available: true, status: value.status,
        startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono, expiresAtMono: value.expiresAtMono,
        hosts: value.hosts.map(row => ({ host: row.host, status: row.status, reasons: row.reasons,
          addresses: row.addresses.map(item => ({ addressHash: hashAddress(item.address), addressFamily: item.addressFamily, addressClass: item.addressClass })),
          answers: row.answers.map(item => ({ type: item.type, queryType: item.queryType, ttl: item.ttl, expiresAtMono: item.expiresAtMono })) })) } : value);
      checkpoint('dns-read'); return value;
    } };
    inputs = new production.PathInputReader({ configuration: selection, owner, network: { readObservation: () => track(network.readObservation()) },
      systemHosts: hostsReader, dns: dnsReader, readVersion: () => version });
    const inputReader = { read: async (...args) => {
      result.counts.inputsReads++; const value = await inputs.read(...args);
      result.inputs.push(value.state === 'observed' ? { state: value.state, sampleId: value.sampleId,
        startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono, expiresAtMono: value.expiresAtMono,
        targets: value.targets, sourceFingerprint: value.configurationAfter.fileFingerprint,
        controllerFingerprint: value.configurationAfter.controllerFingerprint, policyFingerprint: value.configurationAfter.policy.fingerprint,
        ownerEpoch: value.ownerAfter.kernelEpoch, networkHash: value.networkAfter.hash,
        systemHostsHash: value.systemHostsAfter?.fileHash, routeBatchCount: value.routeBatches.length } : value);
      checkpoint('path-input-read'); return value;
    }, whenIdle: () => inputs.whenIdle() };
    const readersWhenIdle = async () => {
      const settled = await Promise.allSettled([selection.whenIdle(), owner.whenIdle(), hostsReader.whenIdle()]);
      let rejected = settled.some(item => item.status === 'rejected');
      while (work.size) { const pending = await Promise.allSettled([...work]); rejected ||= pending.some(item => item.status === 'rejected'); }
      assert(!rejected, 'READERS_CLEANUP_UNAVAILABLE');
    };
    collector = new production.AnonymousFlowCollector({ inputs: inputReader, dns: dnsReader, readController, readConnections,
      readVersion: () => version, isQuiescent, readersWhenIdle, timeoutMs: 30000,
      createCapture: () => {
        const capture = new production.AnonymousNetLogCapture({ isQuiescent, temporaryRoot: temporary }); captures.push(capture);
        return { start: async (...args) => { result.counts.captureStarts++; checkpoint('capture-starting'); await capture.start(...args); checkpoint('capture-started'); },
          finish: async (...args) => { const text = await capture.finish(...args); result.counts.captureFinishes++;
            const parsed = production.parseAnonymousRequestSocket(text, { host, port: 443 });
            result.socketParser = parsed.available ? { available: true, evidenceId: parsed.observation.evidenceId,
              tuple: projectSocket(parsed.observation.tuple), relatedSourceIds: parsed.observation.relatedSourceIds } : parsed;
            result.capture = { rawBytes: Buffer.byteLength(text), rawHash: sha(text), rawPersistedToReport: false };
            checkpoint('capture-finished'); return text; }, dispose: () => capture.dispose(), whenIdle: () => capture.whenIdle() };
      },
      createTcpReader: scope => { const tcp = new production.WindowsTcpSocketReader(scope); return { read: async () => {
        result.counts.windowsTcpReads++; const value = await track(tcp.read()); result.windowsTcp = value.available ? {
          available: true, startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono,
          sockets: value.sockets.map(projectSocket), owners: value.owners } : value; checkpoint('windows-tcp-read'); return value;
      } }; },
    });
    checkpoint('collector-created'); result.counts.collectorCalls++; collecting = true;
    const found = await collector.collect(result.target, loader, 'isolated-anonymous-bilibili-ipv4-v1', deadline.signal);
    collecting = false;
    result.collectorResult = found.available ? { available: true, kind: found.observation.kind, completedAtMono: found.observation.completedAtMono,
      qualificationGranted: found.observation.qualificationGranted } : found;
    if (found.available) {
      const observation = found.observation; result.tls = observation.tls;
      result.mapping = { target: observation.mapping.target, transportContextId: observation.mapping.transportContextId,
        completedAtMono: observation.mapping.completedAtMono, incoming: { host: observation.mapping.incoming.host,
          route: observation.mapping.incoming.route, inboundType: observation.mapping.incoming.inboundType,
          sourceAddressHash: hashAddress(observation.mapping.incoming.sourceAddress), sourcePort: observation.mapping.incoming.sourcePort,
          destinationIpHash: hashAddress(observation.mapping.incoming.destinationIp), remoteDestinationIpHash: hashAddress(observation.mapping.incoming.remoteDestinationIp) },
        qualificationGranted: false };
      result.observationRetained = true;
    }
    check('PRODUCTION_COLLECTOR_AVAILABLE', found.available);
    check('SINGLE_ANONYMOUS_NATIVE_REQUEST', result.counts.publicNativeRequests === 1 && result.counts.nativeTransportEntries === 1);
    check('ORIGINAL_SESSION_FETCH_UNCHANGED', capturedSession?.fetch === originalSessionFetch);
    check('ONE_PRIVATE_CAPTURE', result.counts.captureStarts === 1 && result.counts.captureFinishes === 1);
    check('ACTUAL_INPUTS_BEFORE_AND_AFTER', result.inputs.length === 2 && result.inputs.every(item => item.state === 'observed'));
    check('REAL_WINDOWS_SOCKET_READ', result.counts.windowsTcpReads === 1 && result.windowsTcp?.available);
    check('NO_BUSINESS_OR_PERSISTENT_SESSION', result.counts.anonymousSessions === 1 && result.counts.accountSessions === 0 && isQuiescent());
    check('NO_QUALIFICATION_OR_PERMIT', result.qualificationGranted === false && result.permitIssued === false && found.observation.qualificationGranted === false);
    checkpoint('observation-complete');
  } catch (error) { result.failure = safeError(error); result.observationRetained = false; checkpoint('observation-failed'); }
  finally {
    deadline.abort(); collector?.invalidate(); inputs?.dispose(); dns?.dispose(); owner?.dispose(); hostsReader?.dispose(); selection?.dispose();
    const settled = await bounded(Promise.allSettled([collector?.dispose(), inputs?.whenIdle(), owner?.whenIdle(), hostsReader?.whenIdle(), selection?.whenIdle(),
      ...captures.map(capture => capture.dispose()), ...captures.map(capture => capture.whenIdle()), ...work]), 6000).catch(() => null);
    result.cleanup = { settled: settled !== null, rejected: settled?.filter(item => item.status === 'rejected').length ?? null,
      privateCaptureFilesRemain: fs.readdirSync(temporary).some(name => name.startsWith('clipdock-proof-netlog-')),
      noWindows: BrowserWindow.getAllWindows().length === 0, noWebContents: webContents.getAllWebContents().length === 0 };
    if (!result.cleanup.settled || result.cleanup.rejected || result.cleanup.privateCaptureFilesRemain) { result.failure ??= 'CLEANUP_UNAVAILABLE'; result.observationRetained = false; }
    clearTimeout(timer); result.completedAt = new Date().toISOString(); checkpoint('cleanup-completed'); app.exit(result.failure ? 1 : 0);
  }
}
