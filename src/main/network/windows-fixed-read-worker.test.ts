import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsFixedReadWorker } from "./windows-fixed-read-worker";
const fake = vi.hoisted(() => ({ children: [] as any[], spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => fake.spawn(...args) }));
const workers: WindowsFixedReadWorker[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose();
  fake.children.length = 0;
  vi.useRealTimers();
});
function fixture() {
  fake.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      inputs: [] as string[],
    });
    child.stdin.on("data", (chunk) => child.inputs.push(chunk.toString()));
    child.kill.mockImplementation(() => {
      child.emit("close", 0);
      return true;
    });
    fake.children.push(child);
    return child;
  });
  const worker = new WindowsFixedReadWorker(
    "$clipdockScope = [Console]::In.ReadToEnd() | ConvertFrom-Json",
    1024,
  );
  workers.push(worker);
  return worker;
}
describe("fixed Windows evidence worker", () => {
  it("reuses a hidden process but serializes distinct fresh reads and never interpolates input into code", async () => {
    const worker = fixture(),
      a = worker.read('{"scope":"first"}'),
      b = worker.read('{"scope":"second"}');
    const child = fake.children[0];
    expect(child.inputs).toEqual(['{"scope":"first"}\n']);
    child.stdout.write('{"first":true}\n');
    expect(await a).toBe('{"first":true}');
    expect(child.inputs).toHaveLength(2);
    child.stdout.write('{"second":true}\n');
    expect(await b).toBe('{"second":true}');
    expect(fake.children).toHaveLength(1);
    const args = fake.spawn.mock.calls.at(-1)!;
    expect(args[2]).toMatchObject({ windowsHide: true, shell: false });
    expect(JSON.stringify(args[1])).not.toContain("first");
    expect(JSON.stringify(args[1])).toContain("ReadLine");
  });
  it("drains a cancelled active response before issuing the next scope", async () => {
    const worker = fixture(),
      abort = new AbortController();
    const a = worker.read("{}", abort.signal).catch(() => "cancelled"),
      b = worker.read('{"next":true}');
    abort.abort();
    const child = fake.children[0];
    expect(child.inputs).toHaveLength(1);
    child.stdout.write('{"old":true}\n');
    expect(await a).toBe("cancelled");
    child.stdout.write('{"new":true}\n');
    expect(await b).toBe('{"new":true}');
  });
  it("rejects all pending reads on unexpected output and closes its native process", async () => {
    const worker = fixture(),
      a = worker.read("{}").catch(() => "closed"),
      b = worker.read("{}").catch(() => "closed");
    fake.children[0].stdout.write("x".repeat(1025));
    expect(await a).toBe("closed");
    expect(await b).toBe("closed");
    expect(fake.children[0].kill).toHaveBeenCalled();
    await expect(worker.read("{}\n{}")).rejects.toThrow();
  });
  it("bounds a hung native read and drains on disposal", async () => {
    vi.useFakeTimers();
    const worker = fixture(),
      pending = worker.read("{}").catch(() => "timeout");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe("timeout");
    await worker.dispose();
    await expect(worker.read("{}")).rejects.toThrow();
  });
});
