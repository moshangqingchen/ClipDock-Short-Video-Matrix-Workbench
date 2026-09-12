// Isolated loopback verification. Outputs aggregates only, never system socket rows or paths.
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

assert.equal(process.platform, 'win32', 'Windows only');
const compiled = await build({
  stdin: {
    contents: `export { WindowsControllerOwnerReader, createControllerOwnerWorker } from './src/main/network/windows-controller-owner';
      export { WindowsTcpSocketReader, createTcpSocketWorker } from './src/main/network/windows-tcp-sockets';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
);
const { WindowsControllerOwnerReader, createControllerOwnerWorker, WindowsTcpSocketReader, createTcpSocketWorker } = module.exports;
const controllerWorker = createControllerOwnerWorker();
const socketWorker = createTcpSocketWorker();
const servers = [];
const sockets = new Set();
const readers = [];
const checks = [];
try {
  for (const host of ['127.0.0.1', '::1']) {
    const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port: 0, ipv6Only: host === '::1' }, resolve);
    });
    const port = server.address().port;
    const client = net.connect({ host, port });
    sockets.add(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    checks.push({ host, port, sourcePort: client.localPort });
  }
  const createOwnerReader = ({ host, port }) => {
    const reader = new WindowsControllerOwnerReader({ controllerUrl: `http://${host === '::1' ? '[::1]' : host}:${port}` }, {
      runner: (input, signal) => controllerWorker.read(input, signal),
    });
    readers.push(reader);
    return reader;
  };
  const owners = [];
  for (const check of checks) {
    const start = performance.now();
    const result = await createOwnerReader(check).read();
    assert.equal(result.available, true, 'native listener read unavailable');
    assert.equal(result.owner.pid, process.pid, 'listener ownership mismatch');
    assert.equal(result.listeners.length, 1, 'listener ambiguity');
    assert.equal(result.listeners[0].coverage, 'exact');
    assert.equal(result.listeners[0].address, check.host);
    owners.push(Math.round(performance.now() - start));
  }
  const socketReader = new WindowsTcpSocketReader({
    ownerPids: [process.pid], remotes: checks.map(({ host: address, port }) => ({ address, port })),
  }, { runner: input => socketWorker.read(input) });
  const socketStart = performance.now();
  const snapshot = await socketReader.read();
  assert.equal(snapshot.available, true, 'native socket read unavailable');
  assert.equal(snapshot.sockets.length, 2, 'exact socket count mismatch');
  for (const check of checks) {
    assert.equal(snapshot.sockets.filter(row => row.ownerPid === process.pid && row.sourceAddress === check.host &&
      row.sourcePort === check.sourcePort && row.remoteAddress === check.host && row.remotePort === check.port &&
      row.state === 'Established').length, 1, 'exact socket tuple mismatch');
  }
  const socketMs = Math.round(performance.now() - socketStart);
  const burstStart = performance.now();
  const burst = await Promise.all(Array.from({ length: 32 }, (_, i) => createOwnerReader(checks[i % 2]).read()));
  const burstMs = Math.round(performance.now() - burstStart);
  assert.equal(burst.filter(result => result.available).length, 32, 'fresh queued owner reads failed');
  for (const socket of sockets) socket.destroy();
  const after = await socketReader.read();
  assert.equal(after.available, true, 'post-close read unavailable');
  assert.equal(after.sockets.some(row => row.state === 'Established'), false, 'closed sockets were cached');
  console.log(JSON.stringify({
    ipv4Listener: true, ipv6Listener: true, exactSocketTuples: 2, freshAfterClose: true,
    ownerReadMs: owners, socketReadMs: socketMs, concurrentOwnerReads: 32, concurrentOwnerSuccess: 32, burstMs,
  }));
} finally {
  readers.forEach(reader => reader.dispose());
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(() => resolve()))));
  await Promise.all([controllerWorker.dispose(), socketWorker.dispose()]);
  await Promise.all(readers.map(reader => reader.whenIdle()));
}
