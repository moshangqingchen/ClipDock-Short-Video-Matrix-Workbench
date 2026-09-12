import { execFile } from "node:child_process";
import { win32 } from "node:path";

type Request = {
  script: string;
  signal?: AbortSignal;
  resolve: (raw: string) => void;
  reject: (error: Error) => void;
};
type Runner = (script: string, signal: AbortSignal) => Promise<string>;

/** Coalesce only not-yet-started read-only programs. Never reuse a completed OS observation. */
export class WindowsReadBatch {
  private pending: Request[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly runner: Runner = run) {}

  read(script: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error("WINDOWS_READ_CANCELLED"));
    return new Promise((resolve, reject) => {
      this.pending.push({ script, signal, resolve, reject });
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, 20);
    });
  }

  private async flush(): Promise<void> {
    const batch = this.pending.splice(0);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const item of batch) {
      item.signal?.addEventListener("abort", abort, { once: true });
      if (item.signal?.aborted) abort();
    }
    // Scripts are compile-time constants from the two Windows readers, never IPC or user input.
    const script =
      "$clipdockBatch = [ordered]@{}\n" +
      batch
        .map(
          (item, index) =>
            `try { $clipdockBatch['${index}'] = [string](& {\n${item.script}\n}) } catch { $clipdockBatch['${index}'] = $null }`,
        )
        .join("\n") +
      "\n$clipdockBatch | ConvertTo-Json -Depth 3 -Compress";
    try {
      const raw = await this.runner(script, controller.signal);
      if (controller.signal.aborted || Buffer.byteLength(raw) > 768 * 1024) throw new Error();
      const result = JSON.parse(raw) as Record<string, unknown>;
      batch.forEach((item, i) => {
        const value = result[String(i)];
        if (typeof value === "string") item.resolve(value);
        else item.reject(new Error("WINDOWS_READ_UNAVAILABLE"));
      });
    } catch {
      for (const item of batch) item.reject(new Error("WINDOWS_READ_UNAVAILABLE"));
    } finally {
      for (const item of batch) item.signal?.removeEventListener("abort", abort);
    }
  }
}

function run(script: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let output: string | null = null;
    let failed = false;
    const child = execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, shell: false, encoding: "utf8", timeout: 8000, maxBuffer: 768 * 1024, signal },
      (error, stdout) => {
        failed ||= !!error;
        output = stdout;
      },
    );
    child.once("error", () => {
      failed = true;
    });
    // Aborting execFile calls the callback before the process has closed. Preserve the real slot.
    child.once("close", () => {
      if (failed || output === null) reject(new Error("WINDOWS_READ_UNAVAILABLE"));
      else resolve(output);
    });
  });
}

export const windowsReadBatch = new WindowsReadBatch();
