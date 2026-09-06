/**
 * Tiny CDP driver for smoke tests: `node scripts/cdp.mjs "<js expression>" [urlFilter]`
 * Requires the app to be started with --remote-debugging-port=9222.
 */
const [, , expression, filter = "index.html"] = process.argv;
if (!expression) {
  console.error("usage: node scripts/cdp.mjs <expression> [urlFilter]");
  process.exit(1);
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const target = targets.find((t) => t.type === "page" && t.url.includes(filter));
if (!target) {
  console.error("no target matching", filter, "\navailable:", targets.map((t) => `${t.type} ${t.url}`).join("\n"));
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let id = 0;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const messageId = ++id;
    const onMessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id !== messageId) return;
      ws.removeEventListener("message", onMessage);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (result.exceptionDetails) {
  console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails, null, 2));
  process.exitCode = 3;
} else {
  console.log(JSON.stringify(result.result.value ?? result.result, null, 2));
}
ws.close();
