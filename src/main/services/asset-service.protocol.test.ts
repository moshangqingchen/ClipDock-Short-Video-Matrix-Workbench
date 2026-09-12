import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "@main/db";
import { AssetService } from "./asset-service";

const fixture = vi.hoisted(() => ({ handle: vi.fn(), fetch: vi.fn(), mkdir: vi.fn() }));
vi.mock("electron", () => ({
  protocol: { handle: fixture.handle },
  net: { fetch: fixture.fetch },
  dialog: {},
  nativeImage: {},
  shell: {},
}));
vi.mock("node:fs", () => ({ default: { mkdirSync: fixture.mkdir } }));
afterEach(() => {
  vi.clearAllMocks();
});

function setup() {
  const get = vi.fn(),
    remote = {
      responseFor: vi.fn(async () => new Response("PNG", { headers: { "content-type": "image/png" } })),
    };
  const assets = new AssetService({ assets: { get } } as unknown as Store, "fixture-directory");
  assets.registerProtocol(remote);
  const dispatch = fixture.handle.mock.calls[0][1] as (request: Request) => Promise<Response>;
  return { remote, get, request: (url: string, method = "GET") => dispatch(new Request(url, { method })) };
}
const id = "6ee7babe-7e1a-4f1b-a433-5f9e514120e7";

describe("local asset protocol dispatch", () => {
  it("serves remote-cache IDs locally without passing caller headers to any network transport", async () => {
    const f = setup();
    expect(await (await f.request(`sv-asset://remote/${id}`)).text()).toBe("PNG");
    expect(f.remote.responseFor).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.get).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("keeps HEAD local and returns no body", async () => {
    const f = setup();
    const result = await f.request(`sv-asset://remote/${id}`, "HEAD");
    expect(await result.text()).toBe("");
    expect(result.headers.get("content-type")).toBe("image/png");
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it.each([
    `sv-asset://other/${id}`,
    `sv-asset://remote/${id}?signed=private`,
    `sv-asset://remote/${id}/extra`,
    "sv-asset://remote/arbitrary",
    `sv-asset://remote:443/${id}`,
  ])("rejects invalid authority or cache reference %s before any file/network lookup", async (url) => {
    const f = setup();
    expect((await f.request(url)).status).toBeGreaterThanOrEqual(400);
    expect(f.remote.responseFor).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("does not turn a cache miss or rejected method into a file or network fallback", async () => {
    const f = setup();
    f.remote.responseFor.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await f.request(`sv-asset://remote/${id}`)).status).toBe(404);
    expect((await f.request(`sv-asset://remote/${id}`, "POST")).status).toBe(405);
    expect(f.remote.responseFor).toHaveBeenCalledTimes(1);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
});
