import { it, expect, vi } from "vitest";
import { createStore } from "@main/db";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
import { GlobalWebObservationRepository } from "@main/data/global-web-observation-repository";
import { GlobalWorkspaceService } from "./global-workspace-service";
import type { GlobalWebService } from "./global-web-service";
import type { GlobalPageRead } from "@main/data/global-web-page";
function fixture() {
  const store = createStore(":memory:");
  store.settings.patch({ collectEnabled: false });
  const accounts = new GlobalAccountRepository(store.db),
    account = accounts.create({ platformId: "x" });
  const identity = {
    status: "online" as const,
    subjectId: "owner",
    displayName: "Owner",
    checkedAt: new Date().toISOString(),
  };
  const browser = {
    engine: "chrome",
    readIdentity: vi.fn(async () => identity),
    getPageState: () => ({ url: "https://x.com/home" }),
    readBackground: vi.fn(async (url: string): Promise<GlobalPageRead> => ({
      url,
      text: "Last 7 days\nImpressions\n0",
      identity,
      works: [
        {
          remoteId: "123",
          title: "Post",
          url: "https://x.com/owner/status/123",
          publishedAt: null,
          metrics: { likes: "0" },
        },
      ],
    })),
    go: vi.fn(),
  };
  let generation = 0,
    network = true;
  const web = {
    state: () => ({ phase: network ? "open" : "dormant" }),
    ensureOpen: vi.fn(async () => ({ phase: network ? "open" : "dormant" })),
    withBrowser: async (_id: string, run: (b: typeof browser, check: () => void) => unknown) => {
      const current = generation;
      const check = () => {
        if (current !== generation) throw Error("cancelled");
      };
      check();
      const result = await run(browser, check);
      check();
      return result;
    },
    close: vi.fn(async () => {
      generation++;
    }),
    resetEnvironment: vi.fn(async () => {
      generation++;
    }),
  };
  const service = new GlobalWorkspaceService({
    store,
    accounts,
    web: web as unknown as GlobalWebService,
    openExternal: vi.fn(),
    changed: vi.fn(),
  });
  service.start();
  return {
    store,
    accounts,
    account,
    browser,
    service,
    web,
    identity,
    setNetwork: (value: boolean) => {
      network = value;
      generation++;
    },
    close: () => {
      service.stop();
      store.close();
    },
  };
}
it("deduplicates manual collection and uses hidden pages without moving the active page", async () => {
  const f = fixture();
  try {
    const job = f.service.collect(f.account.id);
    expect(f.service.collect(f.account.id).id).toBe(job.id);
    await vi.waitFor(() => expect(f.service.jobs()[0].state).toBe("done"));
    expect(f.browser.go).not.toHaveBeenCalled();
    expect(f.browser.readBackground).toHaveBeenCalled();
    expect(new GlobalWebObservationRepository(f.store.db).get(f.account.id)?.metrics[0].value).toBe("0");
    expect(f.service.works(f.account.id)[0].metrics.likes).toBe("0");
  } finally {
    f.close();
  }
});
it("waits for the network without discarding old history", async () => {
  const f = fixture();
  try {
    f.setNetwork(false);
    f.service.collect(f.account.id);
    await vi.waitFor(() => expect(f.service.jobs()[0].state).toBe("waiting-network"));
    expect(f.browser.readBackground).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("rejects late results after cancellation and reset while preserving previous works", async () => {
  const f = fixture();
  let resolve!: (value: GlobalPageRead) => void;
  try {
    f.browser.readBackground.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const job = f.service.collect(f.account.id);
    await vi.waitFor(() => expect(f.browser.readBackground).toHaveBeenCalled());
    f.service.cancelJob(job.id);
    await f.service.resetEnvironment(f.account.id);
    resolve({
      url: "https://x.com/i/account_analytics",
      text: "Last 7 days\nImpressions\n999",
      identity: f.identity,
      works: [],
    });
    await new Promise((done) => setTimeout(done, 40));
    expect(f.service.jobs()[0].state).toBe("cancelled");
    expect(new GlobalWebObservationRepository(f.store.db).get(f.account.id)).toBeNull();
    expect(f.service.identity(f.account.id)?.status).toBe("unknown");
  } finally {
    f.close();
  }
});
it("persists drafts per global account and rejects reuse of another account's plan id", () => {
  const f = fixture();
  try {
    const b = f.accounts.create({ platformId: "youtube" });
    const draft = f.service.publishSave({ accountId: f.account.id, title: "First", assetIds: [] });
    expect(() =>
      f.service.publishSave({ id: draft.id, accountId: b.id, title: "Wrong owner", assetIds: [] }),
    ).toThrow();
    expect(f.service.publishList(f.account.id)[0].title).toBe("First");
    expect(f.service.publishList(b.id)).toEqual([]);
  } finally {
    f.close();
  }
});
