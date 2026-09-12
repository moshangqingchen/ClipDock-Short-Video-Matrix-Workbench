/** Build/local checks by default; --run-once permits 4 Chromium + 2 kernel DNS calls only. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
const script = fileURLToPath(import.meta.url), root = path.resolve(path.dirname(script), '..');
const run = process.argv.includes('--run-once'), hosts = ['api6.ipify.org', 'api.bilibili.com'];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assert = (value, reason) => { if (!value) throw Error(reason); };
const safeError = error => /^(?:net::)?[A-Z_]{1,100}$/.test(error?.message ?? '') ? error.message : 'READ_UNAVAILABLE';
const ip = value => typeof value === 'string' && !value.includes('%') ? net.isIP(value) === 4 ? value
  : net.isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : null : null;
const af = value => net.isIP(value) === 4 ? 'ipv4' : net.isIP(value) === 6 ? 'ipv6' : null;
function endpoints(value) {
  assert(Array.isArray(value?.endpoints) && value.endpoints.length <= 128, 'DNS_SHAPE_INVALID');
  return value.endpoints.map(entry => {
    const address = ip(entry.address);
    assert(address && entry.family === af(address), 'DNS_FAMILY_INVALID');
    return {address, family: entry.family};
  });
}
const project = entries => entries.map(entry => ({family: entry.family, addressHash: sha(entry.address)}));
function compare(first, second) {
  if (!first || !second) return null;
  const a = new Set(first.map(entry => entry.address)), b = new Set(second.map(entry => entry.address));
  return {firstCount: a.size, secondCount: b.size, firstSubsetOfSecond: [...a].every(v => b.has(v)),
    equal: a.size === b.size && [...a].every(v => b.has(v)), emptyFirst: !a.size};
}
async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('READ_TIMEOUT')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function localChecks() {
  const values = endpoints({endpoints: [{address: '2001:db8:0:0::2', family: 'ipv6'}, {address: '192.0.2.1', family: 'ipv4'}]});
  assert(!JSON.stringify(project(values)).includes('2001:db8'), 'LOCAL_PRIVACY_CHECK');
  assert(compare(values, structuredClone(values)).equal, 'LOCAL_EQUALITY_CHECK');
  assert(compare([], values).firstSubsetOfSecond && compare([], values).emptyFirst, 'LOCAL_EMPTY_CHECK');
  let rejected = false;
  try { endpoints({endpoints: [{address: '192.0.2.1', family: 'ipv6'}]}); } catch { rejected = true; }
  assert(rejected, 'LOCAL_FAMILY_CHECK');
  let settle, settled = false;
  const original = new Promise(resolve => { settle = resolve; }).then(() => { settled = true; });
  let timeout = false;
  try { await bounded(original, 1); } catch { timeout = true; }
  assert(timeout && !settled, 'LOCAL_TIMEOUT_IS_NOT_DRAIN');
  settle(); await original;
  assert(settled, 'LOCAL_REAL_DRAIN_CHECK');
  return 6;
}
if (!process.versions.electron) await parent();
else {
  const startup = await prepareChild(); // Only imports/startup configuration; never waits for ready.
  void child(startup).catch(() => process.exit(1));
}

async function parent() {
  assert(process.argv.slice(2).every(arg => ['--run-once', '--build-only'].includes(arg)) &&
    !(run && process.argv.includes('--build-only')), 'INVALID_ARGUMENTS');
  const {build} = await import('esbuild'), {default: electron} = await import('electron');
  const base = path.resolve(root, 'docs/.compare');
  fs.mkdirSync(base, {recursive: true});
  const temporary = fs.mkdtempSync(path.join(base, 'resolve-host-family-'));
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const destination = path.join(root, `docs/network-resolve-host-family-comparison.${stamp}.results.json`);
  let report;
  try {
    const built = await build({stdin: {contents: [
      "export {ensureDirectSession} from './direct-session.ts';",
      "export {configureAnonymousCredentials} from './anonymous-session-privacy.ts';",
      "export {ClashReader} from './clash-reader.ts';",
      "export {configureChromiumTransport,readChromiumTransportState} from './chromium-transport.ts';"
    ].join('\n'), resolveDir: path.join(root, 'src/main/network'), loader: 'ts'}, bundle: true,
    platform: 'node', format: 'esm', external: ['electron', 'node:*'], metafile: true,
    tsconfig: path.join(root, 'tsconfig.electron.json'), outfile: path.join(temporary, 'production.mjs'), logLevel: 'silent'});
    const sourceHashes = Object.fromEntries(Object.keys(built.metafile.inputs).filter(name => name.startsWith('src/'))
      .map(name => [name, sha(fs.readFileSync(path.join(root, name)))]));
    const checked = await localChecks();
    if (!run) { console.log(JSON.stringify({buildOnly: true, localChecks: checked, sourceCount: Object.keys(sourceHashes).length,
      chromiumDnsCalls: 0, kernelDnsCalls: 0, httpBusinessCalls: 0})); return; }
    const env = {...process.env, CLIPDOCK_RESOLVER_COMPARISON_ROOT: temporary}; delete env.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script, '--run-once'], {cwd: root, env, windowsHide: true, stdio: 'ignore'});
    let killed = false;
    const timer = setTimeout(() => { killed = true; worker.kill(); }, 55_000);
    const code = await new Promise(resolve => { worker.once('error', () => resolve(1)); worker.once('exit', n => resolve(n ?? 1)); });
    clearTimeout(timer);
    const filename = path.join(temporary, 'result.json');
    report = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8'))
      : {failure: 'CHILD_RESULT_MISSING', cleanup: {drained: false}, countsUnavailable: true};
    Object.assign(report, {sourceHashes, sourceHashesStable: Object.entries(sourceHashes).every(([name, digest]) =>
      sha(fs.readFileSync(path.join(root, name))) === digest), scriptHash: sha(fs.readFileSync(script)),
      bundleHash: sha(fs.readFileSync(path.join(temporary, 'production.mjs'))), localChecks: checked,
      childExitCode: code, parentWatchdogFired: killed});
  } finally {
    const exact = path.resolve(temporary);
    assert(path.dirname(exact) === base && path.basename(exact).startsWith('resolve-host-family-') &&
      fs.realpathSync.native(exact).toLowerCase() === exact.toLowerCase(), 'UNSAFE_TEMPORARY_PATH');
    await new Promise(resolve => setTimeout(resolve, 150));
    try { fs.rmSync(exact, {recursive: true}); } catch { /* No broader deletion or retry. */ }
    if (report) report.rawTemporaryDataRemoved = !fs.existsSync(exact);
  }
  if (report) {
    report.observationRetained = !report.failure && report.cleanup?.drained === true && report.sourceHashesStable &&
      report.rawTemporaryDataRemoved && !report.parentWatchdogFired && report.childExitCode === 0;
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
    console.log(JSON.stringify({report: path.relative(root, destination), observationRetained: report.observationRetained,
      counts: report.counts, hosts: report.hosts, failure: report.failure ?? null, cleanup: report.cleanup}, null, 2));
    process.exitCode = report.observationRetained ? 0 : 1;
  }
}

async function prepareChild() {
  const electron = await import('electron'), {app} = electron;
  const temporary = process.env.CLIPDOCK_RESOLVER_COMPARISON_ROOT;
  assert(run && temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, 'docs/.compare') &&
    path.basename(temporary).startsWith('resolve-host-family-') && !app.isReady(), 'ISOLATION_REQUIRED');
  app.setPath('userData', path.join(temporary, 'userData')); app.setPath('sessionData', path.join(temporary, 'sessionData'));
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update'); app.on('window-all-closed', () => {});
  const production = await import(pathToFileURL(path.join(temporary, 'production.mjs')).href);
  production.configureChromiumTransport(app);
  assert(!app.isReady(), 'STARTUP_CONFIGURATION_TOO_LATE');
  return {electron, temporary, production};
}
async function child({electron: {app, session, BrowserWindow, webContents}, temporary, production}) {
  const result = {kind: 'isolated-resolve-host-family-comparison', executedAt: new Date().toISOString(),
    runtime: {electron: process.versions.electron, chromium: process.versions.chrome,
      transport: production.readChromiumTransportState(app)},
    counts: {chromiumDnsCalls: 0, kernelDnsCalls: 0, controllerReads: 0, httpAttemptsBlocked: 0},
    scope: {realAccounts: false, persistentSession: false, forcedMap: false, resolverReconfigured: false,
      configurationChanged: false, netLogUsed: false, httpBusinessCalls: 0},
    hosts: [], controller: [], qualificationGranted: false, permitIssued: false,
    limits: ['Independent resolveHost results are not actual HTTPS transport or address-family constraints.',
      'Chromium results have no exposed TTL; none is invented. Kernel timestamps/TTLs stay original.',
      'Equal/subset refers only to this round and may compare different sampling times.',
      'DNS timeout cannot cancel resolveHost. Real pending work must settle before cleanup is called drained.']};
  const checkpoint = phase => { result.phase = phase; fs.writeFileSync(path.join(temporary, 'result.json'), JSON.stringify(result)); };
  const pending = new Set(); let stopped = false, ses, reader;
  const track = promise => { pending.add(promise); void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  const quiet = () => !stopped && BrowserWindow.getAllWindows().length === 0 && webContents.getAllWebContents().length === 0;
  const guard = () => assert(quiet(), 'EXPERIMENT_CANCELLED');
  const stop = () => { stopped = true; };
  app.on('browser-window-created', stop); app.on('web-contents-created', stop);
  const timer = setTimeout(() => { result.failure = 'EXPERIMENT_TIMEOUT'; stopped = true; checkpoint('deadline'); }, 45_000);
  const block = (_details, callback) => { result.counts.httpAttemptsBlocked++; stopped = true; callback({cancel: true}); };
  checkpoint('startup');
  try {
    await app.whenReady();
    assert(process.platform === 'win32' && process.versions.electron === '43.3.0', 'WRONG_RUNTIME');
    session.defaultSession.webRequest.onBeforeRequest(block); guard();
    ses = session.fromPartition(`sv-resolver-comparison-${crypto.randomUUID()}`, {cache: false});
    assert(ses.storagePath === null, 'PERSISTENT_SESSION_REFUSED');
    ses.webRequest.onBeforeRequest(block); production.configureAnonymousCredentials(ses);
    await track(production.ensureDirectSession(ses)); await track(ses.clearAuthCache());
    assert((await track(ses.cookies.get({}))).length === 0, 'ANONYMOUS_SESSION_NOT_EMPTY');
    reader = new production.ClashReader({controllerUrl: 'http://127.0.0.1:9790', getSecret: () => null});
    const readController = async phase => {
      guard(); result.counts.controllerReads++;
      const value = await track(reader.read()); guard();
      result.controller.push({phase, fingerprint: value.fingerprint, mode: value.mode, tun: value.tun,
        kernelVersion: value.version, startedAtMono: value.startedAtMono, completedAtMono: value.completedAtMono});
      checkpoint('controller'); return value;
    };
    const before = await readController('before');
    assert(before.mode === 'rule' && before.tun === true, 'CURRENT_RULE_TUN_REQUIRED');
    for (const host of hosts) {
      guard(); const row = {host, kernel: null, chromium: [], comparisons: null}; result.hosts.push(row);
      let kernel = null, normal = null, explicit = null;
      result.counts.kernelDnsCalls++; checkpoint('kernel-query-start');
      try {
        const dns = await track(reader.readDnsQuery(host, 'AAAA')); guard();
        kernel = dns.status === 0 && !dns.truncated ? dns.answers.filter(v => v.type === 28 && ip(v.data))
          .map(v => ({address: ip(v.data), family: af(v.data)})) : null;
        row.kernel = {queryType: 'AAAA', status: dns.status, truncated: dns.truncated,
          startedAtMono: dns.startedAtMono, completedAtMono: dns.completedAtMono,
          answers: dns.answers.map(v => ({type: v.type, ttl: v.ttl, expiresAtMono: dns.startedAtMono + v.ttl * 1000,
            addressHash: ip(v.data) ? sha(ip(v.data)) : null, family: af(v.data)}))};
      } catch (error) { row.kernel = {available: false, reason: safeError(error)}; }
      for (const mode of ['default', 'explicit-aaaa']) {
        guard(); await track(ses.clearHostResolverCache()); guard();
        const options = mode === 'default' ? undefined : {queryType: 'AAAA', cacheUsage: 'disallowed'};
        const query = {mode, options: options ?? null, queuedAtMono: performance.now(), startedAtMono: null, settledAtMono: null,
          state: 'pending', timedOut: false, ttl: null};
        row.chromium.push(query); result.counts.chromiumDnsCalls++; checkpoint('chromium-query-start');
        const original = track(Promise.resolve().then(() => {
          query.startedAtMono = performance.now();
          return options ? ses.resolveHost(host, options) : ses.resolveHost(host);
        })
          .then(value => { const entries = endpoints(value); query.settledAtMono = performance.now();
            query.state = query.timedOut ? 'resolved-after-timeout' : 'resolved'; query.endpoints = project(entries);
            checkpoint('chromium-query-settled'); return entries;
          }).catch(error => { query.settledAtMono = performance.now(); query.state = 'rejected';
            query.reason = safeError(error); checkpoint('chromium-query-settled'); return null; }));
        let entries;
        try { entries = await bounded(original, 8_000); }
        catch (error) { query.timedOut = true; stopped = true; checkpoint('chromium-query-timeout'); throw error; }
        guard(); if (mode === 'default') normal = entries; else explicit = entries;
      }
      row.comparisons = {defaultToExplicitAllAddresses: compare(normal, explicit),
        defaultIpv6ToKernelAaaa: compare(normal?.filter(v => v.family === 'ipv6'), kernel),
        explicitIpv6ToKernelAaaa: compare(explicit?.filter(v => v.family === 'ipv6'), kernel),
        kernelAnswersWithinOriginalTtlAtLastChromeSettlement: row.kernel?.answers?.length > 0
          ? row.kernel.answers.every(answer => answer.expiresAtMono > row.chromium.at(-1).settledAtMono) : null};
      checkpoint('host-completed');
    }
    const after = await readController('after');
    result.controllerStable = before.fingerprint === after.fingerprint;
    assert(result.controllerStable, 'CONTROLLER_CHANGED');
    assert(result.counts.chromiumDnsCalls === 4 && result.counts.kernelDnsCalls === 2 &&
      result.counts.httpAttemptsBlocked === 0, 'QUERY_BUDGET_INVALID');
  } catch (error) { result.failure ??= safeError(error); checkpoint('failure'); }
  finally {
    clearTimeout(timer); stopped = true;
    const originalDrain = Promise.allSettled([...pending, reader?.whenIdle()]);
    const done = await bounded(originalDrain, 5_000).then(() => true, () => false);
    let cleaned = false;
    if (done && ses) {
      const cleanup = track(Promise.allSettled([ses.closeAllConnections(), ses.clearHostResolverCache(),
        ses.clearAuthCache(), ses.clearStorageData({storages: ['cookies', 'serviceworkers', 'cachestorage']})]));
      cleaned = await bounded(cleanup, 4_000).then(rows => rows.every(v => v.status === 'fulfilled'), () => false);
    }
    result.cleanup = {originalDnsAndControllerWorkSettled: done, sessionCleaned: cleaned,
      drainScope: 'actual resolveHost promises, public controller reads and Session cleanup',
      controllerReadTransportCloseObserved: false,
      drained: done && (!ses || cleaned) && pending.size === 0, pendingCount: pending.size,
      windows: BrowserWindow.getAllWindows().length, webContents: webContents.getAllWebContents().length};
    checkpoint('finished'); app.exit(result.failure || !result.cleanup.drained ? 1 : 0);
  }
}
