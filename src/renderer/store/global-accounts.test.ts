import { beforeEach, expect, it, vi } from "vitest";
import type { GlobalAccount } from "@shared/global-accounts";
import type { WebIdentity } from "@shared/global-workspace";

const transport = vi.hoisted(() => ({ list: vi.fn(), state: vi.fn(), identity: vi.fn() }));
vi.mock("@renderer/lib/api", () => ({
  api: {
    globalAccounts: { list: transport.list },
    globalWeb: { state: transport.state },
    globalWorkspace: { identity: transport.identity },
  },
}));
import { useGlobalAccounts } from "./global-accounts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function account(id: string, displayName = id): GlobalAccount {
  return {
    id, platformId: "youtube", displayName, remoteId: null, authStatus: "unauthorized",
    createdAt: "2026-10-22T12:00:00.000Z", updatedAt: "2026-10-22T12:00:00.000Z",
  };
}

function identity(status: WebIdentity["status"]): WebIdentity {
  return { status, subjectId: null, displayName: null, checkedAt: "2026-10-22T12:00:00.000Z" };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.state.mockResolvedValue(null);
  transport.identity.mockResolvedValue(null);
  useGlobalAccounts.setState({ accounts: [], states: {}, identities: {}, loaded: false, error: null });
});

it("keeps a concurrent account update without dropping the rest of the loaded list", async () => {
  const read = deferred<GlobalAccount[]>();
  transport.list.mockReturnValue(read.promise);
  const pending = useGlobalAccounts.getState().load();
  useGlobalAccounts.getState().upsert(account("first", "Renamed"));
  useGlobalAccounts.getState().upsert(account("created"));
  read.resolve([account("first", "Old name"), account("second")]);
  await pending;
  expect(useGlobalAccounts.getState().accounts).toEqual([
    account("first", "Renamed"), account("second"), account("created"),
  ]);
  expect(useGlobalAccounts.getState()).toMatchObject({ loaded: true, error: null });
});

it("does not replace a newer login result with an older list hydration response", async () => {
  const older = deferred<WebIdentity | null>();
  transport.list.mockResolvedValue([account("first")]);
  transport.identity.mockReturnValueOnce(older.promise).mockResolvedValueOnce(identity("online"));
  const pending = useGlobalAccounts.getState().load();
  await Promise.resolve();
  await useGlobalAccounts.getState().refreshIdentity("first");
  older.resolve(identity("offline"));
  await pending;
  expect(useGlobalAccounts.getState().identities.first?.status).toBe("online");
});

it("keeps the latest of two overlapping identity refreshes", async () => {
  useGlobalAccounts.setState({ accounts: [account("first")] });
  const older = deferred<WebIdentity | null>();
  transport.identity.mockReturnValueOnce(older.promise).mockResolvedValueOnce(identity("needs_verification"));
  const first = useGlobalAccounts.getState().refreshIdentity("first");
  await useGlobalAccounts.getState().refreshIdentity("first");
  older.resolve(identity("online"));
  await first;
  expect(useGlobalAccounts.getState().identities.first?.status).toBe("needs_verification");
});

it("does not restore identity or browser data after an account was removed by a newer load", async () => {
  const older = deferred<WebIdentity | null>();
  transport.list.mockResolvedValueOnce([account("first")]).mockResolvedValueOnce([]);
  transport.identity.mockReturnValueOnce(older.promise);
  const first = useGlobalAccounts.getState().load();
  await Promise.resolve();
  await useGlobalAccounts.getState().load();
  older.resolve(identity("online"));
  await first;
  expect(useGlobalAccounts.getState()).toMatchObject({ accounts: [], identities: {}, states: {} });
});
