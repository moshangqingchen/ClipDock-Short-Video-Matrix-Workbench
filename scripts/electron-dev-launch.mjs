import { spawn } from "node:child_process";
import electronPath from "electron";

const child = spawn(electronPath, ["."], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173",
  },
  stdio: "inherit",
  windowsHide: false,
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
child.once("error", (error) => {
  console.error(`Unable to launch Electron: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 0;
});
