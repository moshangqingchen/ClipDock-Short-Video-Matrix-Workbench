import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { win32 } from "node:path";

interface Job {
  input: string;
  signal?: AbortSignal;
  resolve(value: string): void;
  reject(error: Error): void;
}
const unavailable = () => new Error("WINDOWS_READ_WORKER_UNAVAILABLE");

/** Runs one fixed read-only program in a hidden worker. Only bounded JSON data is
 * sent over stdin. Every job performs a fresh native read; no evidence is cached.
 * Responses are serialized, so cancellation cannot give another request its result. */
export class WindowsFixedReadWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private output = "";
  private timer?: ReturnType<typeof setTimeout>;
  private readonly closing = new Set<Promise<void>>();
  private disposed = false;
  constructor(
    private readonly program: string,
    private readonly maxBytes: number,
  ) {
    if (!program.includes("[Console]::In.ReadToEnd()")) throw unavailable();
  }
  read(input: string, signal?: AbortSignal): Promise<string> {
    if (
      this.disposed ||
      signal?.aborted ||
      this.queue.length >= 64 ||
      Buffer.byteLength(input) > 16_384 ||
      /[\r\n]/.test(input)
    )
      return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      this.queue.push({ input, signal, resolve, reject });
      this.pump();
    });
  }
  private pump(): void {
    if (this.disposed || this.active) return;
    let job = this.queue.shift();
    while (job?.signal?.aborted) {
      job.reject(unavailable());
      job = this.queue.shift();
    }
    if (!job) return;
    this.active = job;
    if (!this.child) this.start();
    const child = this.child;
    if (!child) {
      this.fail();
      return;
    }
    this.timer = setTimeout(() => this.fail(), 6_000);
    child.stdin.write(job.input + "\n", (error) => {
      if (error && this.child === child) this.fail();
    });
  }
  private start(): void {
    // The request stays a JSON value in PowerShell, never source code or command arguments.
    const body = this.program.replace("[Console]::In.ReadToEnd()", "$clipdockRequest");
    const program = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\nwhile ($null -ne ($clipdockRequest = [Console]::In.ReadLine())) {\ntry {\n$clipdockAnswer = & {\n${body}\n}\n[Console]::Out.WriteLine([string]$clipdockAnswer)\n} catch { [Console]::Out.WriteLine('{"readError":true}') }\n}`;
    const child = spawn(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", program],
      { windowsHide: true, shell: false, stdio: "pipe" },
    );
    this.child = child;
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        if (this.child === child) this.fail();
        resolve();
      }),
    );
    this.closing.add(closed);
    void closed.then(() => this.closing.delete(closed));
    child.on("error", () => {
      if (this.child === child) this.fail();
    });
    child.stdin.on("error", () => {
      if (this.child === child) this.fail();
    });
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      this.output += chunk;
      if (Buffer.byteLength(this.output) > this.maxBytes) {
        this.fail();
        return;
      }
      const end = this.output.indexOf("\n");
      if (end < 0) return;
      const line = this.output.slice(0, end).replace(/\r$/, ""),
        remainder = this.output.slice(end + 1);
      if (!this.active || remainder) {
        this.fail();
        return;
      }
      this.output = "";
      clearTimeout(this.timer);
      const job = this.active;
      this.active = null;
      if (job.signal?.aborted) job.reject(unavailable());
      else job.resolve(line);
      this.pump();
    });
  }
  private fail(): void {
    clearTimeout(this.timer);
    const child = this.child;
    this.child = null;
    child?.stdin.destroy();
    child?.kill();
    this.output = "";
    const jobs = [...(this.active ? [this.active] : []), ...this.queue.splice(0)];
    this.active = null;
    for (const job of jobs) job.reject(unavailable());
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.fail();
    await Promise.all([...this.closing]);
  }
}
