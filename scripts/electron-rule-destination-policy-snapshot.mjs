/** Isolated, read-only current selected-client loader test. No old report is an input. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const resultPath = path.join(root, "docs/network-rule-destination-policy-live.results.json");
const resources = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\MAOMAOYUNAPP\\resources";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const assert = (value, code) => { if (!value) throw Error(code); };
if (!process.versions.electron) await parent();
else void child().catch(() => process.exit(1));

async function parent() {
  const { build } = await import("esbuild");
  const { spawn } = await import("node:child_process");
  const { default: electron } = await import("electron");
  const parentDirectory = path.join(root, "docs/.compare");
  fs.mkdirSync(parentDirectory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parentDirectory, "destination-policy-"));
  try {
    const built = await build({ stdin: { contents: [
      "export { SelectedClientConfig } from './src/main/network/selected-client-config.ts';",
      "export { SELECTED_CLIENT_PROFILE, selectedClientDecoder } from './src/main/network/selected-client-protocol.ts';",
      "export { ClashReader } from './src/main/network/clash-reader.ts';",
      "export {load,CORE_SCHEMA} from 'js-yaml';",
      "export {evaluateRules} from './src/main/network/rules.ts';",
    ].join("\n"), resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm",
      external: ["electron", "node:*"], tsconfig: path.join(root, "tsconfig.electron.json"),
      outfile: path.join(temporary, "production.mjs"), metafile: true, logLevel: "silent" });
    const inputs = Object.keys(built.metafile.inputs);
    assert(!inputs.some(value => /(?:babel|@electron\/asar|typescript|node:vm)/.test(value)), "UNEXPECTED_RUNTIME_DEPENDENCY");
    const hashes = Object.fromEntries(inputs.filter(file => file.startsWith("src/"))
      .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
    const environment = { ...process.env, CLIPDOCK_DESTINATION_POLICY_ROOT: temporary };
    delete environment.ELECTRON_RUN_AS_NODE;
    const worker = spawn(electron, [script], { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    worker.stdout.resume(); worker.stderr.resume();
    const timer = setTimeout(() => worker.kill(), 25000);
    const code = await new Promise(resolve => { worker.once("exit", value => resolve(value ?? 1)); worker.once("error", () => resolve(1)); });
    clearTimeout(timer);
    assert(fs.existsSync(path.join(temporary, "result.json")), "CHILD_RESULT_UNAVAILABLE");
    const result = JSON.parse(fs.readFileSync(path.join(temporary, "result.json"), "utf8"));
    result.sourceHashes = hashes;
    result.sourceHashesStable = Object.entries(hashes).every(([file, value]) => sha(fs.readFileSync(path.join(root, file))) === value);
    result.scriptHash = sha(fs.readFileSync(script));
    result.bundleHasExplorationRuntimeDependencies = false;
    if (fs.existsSync(resultPath)) {
      const previous = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const suffix = previous.executedAt.replace(/[^0-9TZ]/g, "");
      fs.copyFileSync(resultPath, resultPath.replace(".results.json", `.${suffix}.results.json`));
    }
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ selection: result.selection, source: result.source, checks: result.checks,
      counts: result.counts, sourceHashesStable: result.sourceHashesStable, failure: result.failure ?? null }, null, 2));
    process.exitCode = code || (result.sourceHashesStable ? 0 : 1);
  } catch (error) { console.error(/^[A-Z_]{1,100}$/.test(error.message) ? error.message : "SELECTED_CLIENT_SMOKE_FAILED"); process.exitCode = 1; }
  finally {
    const resolved = path.resolve(temporary);
    assert(path.dirname(resolved) === path.resolve(parentDirectory) && path.basename(resolved).startsWith("destination-policy-"), "UNSAFE_TEMPORARY_PATH");
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Isolated data is never reused. */ }
  }
}
async function child() {
  const { app, net, session } = await import("electron");
  const temporary = process.env.CLIPDOCK_DESTINATION_POLICY_ROOT;
  assert(temporary && path.dirname(path.resolve(temporary)) === path.resolve(root, "docs/.compare") &&
    path.basename(temporary).startsWith("destination-policy-"), "ISOLATION_REQUIRED");
  app.setPath("userData", path.join(temporary, "userData")); app.setPath("sessionData", path.join(temporary, "sessionData"));
  app.commandLine.appendSwitch("disable-background-networking"); app.commandLine.appendSwitch("disable-component-update");
  app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND"); app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const result = { executedAt: new Date().toISOString(), runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    isolation: { temporaryUserData: true, accountCreated: false, configurationChanged: false, publicHttpRequests: false,
      previousReportUsedAsInput: false, vendorCodeExecuted: false, decoderMaterialPersisted: false, productionBootstrapChanged: false },
    counts: { controllerRequests: 0, controllerReads: 0, sessionCreations: 0, electronRequests: 0 }, checks: [],
    selectedClientVersion: null, selection: null, source: null, permissionIssued: false, pathQualificationCreated: false };
  const check = (name, value) => { result.checks.push({ name, passed: Boolean(value) }); assert(value, name); };
  let factory;
  try {
    await app.whenReady();
    const { default: http } = await import("node:http");
    const { syncBuiltinESMExports } = await import("node:module");
    const request = http.request;
    http.request = function(options, callback) {
      assert(options.hostname === "127.0.0.1" && Number(options.port) === 9790 && options.method === "GET", "NON_CONTROLLER_REQUEST");
      assert(!Object.keys(options.headers ?? {}).some(key => /cookie|authorization/i.test(key)), "UNEXPECTED_AUTH_HEADER");
      result.counts.controllerRequests++; return request.call(this, options, callback);
    };
    syncBuiltinESMExports();
    session.fromPartition = () => { result.counts.sessionCreations++; throw Error("SESSION_FORBIDDEN"); };
    net.request = () => { result.counts.electronRequests++; throw Error("ELECTRON_REQUEST_FORBIDDEN"); };
    const production = await import(pathToFileURL(path.join(temporary, "production.mjs")).href);
    result.selectedClientVersion = production.SELECTED_CLIENT_PROFILE.version;
    result.artifactPreflight = [];
    for (const [kind, file] of [["resources", resources], ["archive", path.join(resources, "app.asar")],
      ["extra", path.join(resources, "extra")], ["config", path.join(resources, "extra/config.yaml")]]) {
      try {
        const resolved = await fs.promises.realpath(file), stat = await fs.promises.lstat(file);
        result.artifactPreflight.push({ kind, pathUnchanged: path.normalize(file).toLowerCase() === path.normalize(resolved).toLowerCase(),
          file: stat.isFile(), directory: stat.isDirectory(), symbolicLink: stat.isSymbolicLink() });
      } catch { result.artifactPreflight.push({ kind, available: false }); }
    }
    for (const [kind, file, expected] of [["package", path.join(resources, "app.asar/package.json"), production.SELECTED_CLIENT_PROFILE.packageSha256],
      ["main", path.join(resources, "app.asar/src/main/main.js"), production.SELECTED_CLIENT_PROFILE.mainSha256]]) {
      let handle;
      try {
        handle = await fs.promises.open(file, "r"); const info = await handle.stat();
        assert(info.size > 0 && info.size < 1024 * 1024, "ARTIFACT_LIMIT");
        const bytes = Buffer.alloc(info.size); const read = await handle.read(bytes, 0, bytes.length, 0);
        const record = { kind, available: true, bytes: read.bytesRead, digestMatches: sha(bytes) === expected };
        if (kind === "main") { try { production.selectedClientDecoder(bytes).dispose(); record.decoderConstructed = true; } catch { record.decoderConstructed = false; } }
        bytes.fill(0); result.artifactPreflight.push(record);
      } catch(error) { result.artifactPreflight.push({ kind, available: false, code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "ARTIFACT_UNAVAILABLE" }); }
      finally { await handle?.close(); }
    }
    const configFile = path.join(resources, "extra/config.yaml");
    const configHash = () => { const info = fs.statSync(configFile); assert(info.isFile() && info.size < 8 * 1024 * 1024, "CONFIG_SIZE_INVALID"); return sha(fs.readFileSync(configFile)); };
    const beforeHash = configHash();
    const reader = new production.ClashReader({ controllerUrl: "http://127.0.0.1:9790", getSecret: () => null });
    let observed;
    factory = new production.SelectedClientConfig({ resourcesPath: resources, readController: async signal => {
      result.counts.controllerReads++; return observed = await reader.read(signal);
    } });
    check("STARTS_WITHOUT_SELECTION", factory.getSelectedLoader() === null && factory.getSnapshot().state === "checking");
    const loader = await factory.select();
    result.selection = loader ? { selected: true, profile: loader.loaderProfileId, selectedAtMono: loader.selectedAtMono,
      sourcePathIdentity: loader.sourcePathIdentity, decoderIdentity: loader.decoderIdentity, currentQualificationReferences: loader.qualificationEvidenceIds.length } :
      { selected: false, state: factory.getSnapshot().state, reason: factory.getSnapshot().reason ?? null };
    check("CURRENT_NATIVE_ASAR_PINNED_SELECTION", loader !== null);
    check("SELECTION_DOES_NOT_READ_CONTROLLER", result.counts.controllerRequests === 0);
    const candidate = await factory.read();
    result.source = candidate.state === "candidate" ? { state: "candidate", kind: candidate.candidate.kind,
      runtimeConfigurationProven: candidate.candidate.runtimeConfigurationProven, ruleCount: candidate.candidate.comparedRuleCount,
      startedAtMono: candidate.candidate.startedAtMono, completedAtMono: candidate.candidate.completedAtMono,
      expiresAtMono: candidate.candidate.expiresAtMono, controllerFingerprint: candidate.candidate.controllerFingerprint,
      mode: observed?.mode, tun: observed?.tun, kernelVersion: observed?.version,
      selectedPathMatches: candidate.candidate.sourcePathIdentity === loader.sourcePathIdentity } :
      { state: candidate.state, reason: candidate.reason ?? null };
    check("CURRENT_DECODE_AND_CONTROLLER_COMPARISON", candidate.state === "candidate");
    check("SELECTED_BEFORE_OBSERVATION", loader.selectedAtMono <= candidate.candidate.startedAtMono);
    check("SOURCE_PATH_MATCHES_SELECTION", candidate.candidate.sourcePathIdentity === loader.sourcePathIdentity);
    check("CANDIDATE_IS_NOT_RUNTIME_ATTESTATION", candidate.candidate.runtimeConfigurationProven === false);
    const rawMain = fs.readFileSync(path.join(resources, 'app.asar/src/main/main.js'));
    const rawPayload = fs.readFileSync(configFile);
    check('RAW_SOURCE_SAME_CURRENT_CANDIDATE', sha(rawPayload) === candidate.candidate.fileFingerprint);
    const decoder = production.selectedClientDecoder(rawMain);
    let decoded;
    try { decoded = production.load(decoder.decode(rawPayload, new AbortController().signal), {schema:production.CORE_SCHEMA}); }
    finally { decoder.dispose(); rawMain.fill(0); rawPayload.fill(0); }
    const canonical = v => Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : v && typeof v==='object' ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);
    check('PROJECTED_POLICY_SAME_CANDIDATE', ['hosts','dns','sniffer','tun'].every(k=>!candidate.candidate.policy[k].present ? !Object.hasOwn(decoded,k) : sha(canonical(decoded[k]))===candidate.candidate.policy[k].fingerprint));
    const targets=['api.bilibili.com','myip.ipip.net','api6.ipify.org'];
    const scalar=(o,k)=>!Object.hasOwn(o,k)?{present:false}:{present:true,value:typeof o[k]==='boolean'||typeof o[k]==='number'||typeof o[k]==='string'&&/^[A-Za-z0-9:./_*+-]{0,256}$/.test(o[k])?o[k]:'unsupported-value'};
    const domainMatch=(pattern,host)=>pattern===host || pattern.startsWith('+.')&&(host===pattern.slice(2)||host.endsWith(pattern.slice(1))) || pattern.startsWith('*.')&&host.endsWith(pattern.slice(1));
    const patterns = v => ({present:v!==undefined, count:Array.isArray(v)?v.length:null, supportedSimpleDomainCount:Array.isArray(v)?v.filter(p=>typeof p==='string'&&/^(?:\+\.|\*\.)?[a-z0-9._*-]+$/.test(p)).length:null,
      targets:targets.map(host=>({host,simpleDomainMatches:Array.isArray(v)?v.filter(p=>typeof p==='string'&&domainMatch(p,host)):[]}))});
    const dns=decoded.dns??{}, sniff=decoded.sniffer??{}, tun=decoded.tun??{}, hosts=decoded.hosts??{};
    const fields=(o,keys)=>Object.fromEntries(keys.map(k=>[k,scalar(o,k)]));
    const shape=v=>({present:v!==undefined,kind:Array.isArray(v)?'array':v===null?'null':typeof v,count:v&&typeof v==='object'?Object.keys(v).length:null});
    result.destinationPolicy={
      mainOnlyObservation:true,ruleEntryStageProven:false,policyFingerprint:candidate.candidate.policy.fingerprint,
      top:fields(decoded,['ipv6','find-process-mode','tcp-concurrent','interface-name','routing-mark']),
      hosts:{...shape(decoded.hosts),targets:targets.map(host=>({host,matches:Object.entries(hosts).filter(([key])=>domainMatch(key,host)).map(([key,value])=>({pattern:key,valueKind:Array.isArray(value)?'array':typeof value,count:Array.isArray(value)?value.length:null}))}))},
      dns:{...fields(dns,['enable','ipv6','use-hosts','use-system-hosts','respect-rules','enhanced-mode','fake-ip-range','fake-ip-filter-mode']),fakeIpFilter:patterns(dns['fake-ip-filter']),nameserverShape:shape(dns.nameserver),nameserverPolicyShape:shape(dns['nameserver-policy']),fallbackShape:shape(dns.fallback),defaultNameserverShape:shape(dns['default-nameserver'])},
      sniffer:{...fields(sniff,['enable','force-dns-mapping','override-destination','parse-pure-ip']),sniff:sniff.sniff?Object.fromEntries(['HTTP','TLS','QUIC'].filter(k=>Object.hasOwn(sniff.sniff,k)).map(k=>[k,{...fields(sniff.sniff[k],['override-destination']),ports:Array.isArray(sniff.sniff[k].ports)?sniff.sniff[k].ports.filter(v=>typeof v==='number'||typeof v==='string'&&/^[0-9-]+$/.test(v)):null}])):null,forceDomain:patterns(sniff['force-domain']),skipDomain:patterns(sniff['skip-domain']),skipSrcAddressShape:shape(sniff['skip-src-address']),skipDstAddressShape:shape(sniff['skip-dst-address'])},
      tun:{...fields(tun,['enable','stack','auto-route','auto-detect-interface','strict-route']),dnsHijackShape:shape(tun['dns-hijack'])},
      rules:targets.map(host=>{const index=candidate.candidate.rules.findIndex(r=>{const t=r.type.toLowerCase().replaceAll('-','');return t==='domain'&&r.payload===host || t==='domainsuffix'&&(host===r.payload||host.endsWith('.'+r.payload)) || t==='domainkeyword'&&host.includes(r.payload)});return{host,domainIndex:index,domainType:index<0?null:candidate.candidate.rules[index].type,domainDirect:index>=0&&candidate.candidate.rules[index].proxy==='DIRECT',precedingTypes:index<0?null:candidate.candidate.rules.slice(0,index).reduce((all,r)=>(all[r.type]=(all[r.type]??0)+1,all),{}),prefixIPRules:index<0?[]:candidate.candidate.rules.slice(0,index).flatMap((r,i)=>r.type.toLowerCase().replaceAll('-','').startsWith('ipcidr')?[{index:i,prefix:r.payload,route:r.proxy==='DIRECT'?'direct':'other',parameters:candidate.candidate.ruleParameters?.[i]??null}]:[])}}),
    };
    for(const target of result.destinationPolicy.rules){const all=target.prefixIPRules;target.precedingIPSummary={count:all.length,direct:all.filter(x=>x.route==='direct').length,other:all.filter(x=>x.route!=='direct').length,noResolve:all.filter(x=>x.parameters?.length===1&&x.parameters[0]==='no-resolve').length,firstOther:all.find(x=>x.route!=='direct')??null};target.prefixIPRules=all.slice(0,12);}
    const params={rules:candidate.candidate.rules,parameters:candidate.candidate.ruleParameters,parametersFingerprint:candidate.candidate.sourceRuleOptionsFingerprint};
    result.conditionalRuleEvaluation=[{name:'unknown-entry',destination:{stage:'unknown'}},{name:'unresolved-missing-process',destination:{stage:'unresolved'}},{name:'unresolved-synthetic-nonmatching-process',destination:{stage:'unresolved'},processName:'clipdock-not-a-real-process'},{name:'resolved-synthetic-other-rule-counterexample',destination:{stage:'resolved',address:'101.227.200.11'},processName:'clipdock-not-a-real-process'}].map(v=>({case:v.name,syntheticNotPacketObservation:true,decision:production.evaluateRules(observed.mode,candidate.candidate.rules,{host:'myip.ipip.net',port:443,network:'tcp',destination:v.destination,...(v.processName?{processName:v.processName}:{})},params)}));
    result.upstreamReview={commit:'ac017cdd246ce8bd547653d927e7bf77d7ee73d5',observedLocalKernel:'424c2ef',binarySourceIdentityProven:false,files:['tunnel/tunnel.go','component/sniffer/dispatcher.go','rules/common/ipcidr.go','config/config.go']};
    check('POLICY_READ_DID_NOT_MODIFY_CONFIG', beforeHash===configHash());

    check("CURRENT_CONFIG_NOT_MODIFIED", beforeHash === configHash());
    check("NO_SESSION_OR_ELECTRON_NETWORK", result.counts.sessionCreations === 0 && result.counts.electronRequests === 0);
    factory.invalidate(); check("INVALIDATE_WITHDRAWS_SELECTION", factory.getSelectedLoader() === null);
    factory.dispose(); const afterCount = result.counts.controllerRequests;
    check("DISPOSE_CANNOT_RESELECT", await factory.select() === null && (await factory.read()).state === "unavailable");
    check("DISPOSE_DOES_NOT_READ_CONTROLLER", afterCount === result.counts.controllerRequests);
  } catch (error) { result.failure = /^[A-Z_]{1,100}$/.test(error.message) ? error.message : "READ_ONLY_SMOKE_UNAVAILABLE"; }
  finally {
    factory?.dispose(); result.completedAt = new Date().toISOString();
    fs.writeFileSync(path.join(temporary, "result.json"), JSON.stringify(result)); app.exit(result.failure ? 1 : 0);
  }
}
