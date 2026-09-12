import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC } from "@shared/ipc-channels";
import { openDatabase, type Database } from "@main/db/database";
import { GlobalAccountRepository } from "@main/api/global-account-repository";
import { GlobalAuthorizationStore } from "@main/api/global-authorization-store";
import type { IpcRegistrar } from "../register";
import { registerGlobalAccountHandlers } from "./global-accounts";

const databases: Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
    handleValidated: (
      channel: string,
      schema: { parse(input: unknown): unknown },
      fn: (...args: unknown[]) => unknown,
    ) => handlers.set(channel, (_event, input) => fn(null, schema.parse(input))),
  };
  const beforeMutation = vi.fn();
  registerGlobalAccountHandlers(
    ipc as unknown as IpcRegistrar,
    new GlobalAccountRepository(db),
    new GlobalAuthorizationStore(db),
    beforeMutation,
  );
  return {
    db,
    handlers,
    beforeMutation,
    run: (channel: string, input?: unknown) => handlers.get(channel)!(null, input),
  };
}
describe("global account IPC boundaries", () => {
  it.each(["douyin", "bilibili", "weixin_channels", "https://youtube.com"])(
    "rejects non-global platform input %s",
    (platformId) => {
      const f = fixture();
      expect(() => f.run(IPC.globalAccountCreate, { platformId })).toThrow();
      expect(f.run(IPC.globalAccountList)).toEqual([]);
    },
  );
  it.each([{ partition: "persist:injected" }, { authStatus: "authorized" }, { token: "secret" }])(
    "rejects renderer-only privilege injection %j",
    (extra) => {
      const f = fixture();
      expect(() => f.run(IPC.globalAccountCreate, { platformId: "youtube", ...extra })).toThrow();
      expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts")?.n).toBe(0);
    },
  );
  it("registers metadata and local disconnect only, creating no domestic account or partition", async () => {
    const f = fixture();
    const account = f.run(IPC.globalAccountCreate, { platformId: "youtube" }) as {
      id: string;
      authStatus: string;
    };
    expect(account.authStatus).toBe("unauthorized");
    expect(account).not.toHaveProperty("partition");
    expect([...f.handlers.keys()]).toEqual([
      IPC.globalAccountUpdate,
      IPC.globalAccountList,
      IPC.globalAccountCreate,
      IPC.globalAccountDelete,
      IPC.globalAccountDisconnect,
    ]);
    expect(f.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts")?.n).toBe(0);
    expect(() => f.run(IPC.globalAccountDelete, "youtube")).toThrow();
    await f.run(IPC.globalAccountDelete, account.id);
    expect(f.run(IPC.globalAccountList)).toEqual([]);
  });
  it("validates the UUID and revokes runtime work before local grant removal", () => {
    const f = fixture();
    const account = f.run(IPC.globalAccountCreate, { platformId: "youtube" }) as { id: string };
    f.db.run(
      "UPDATE global_accounts SET remote_id = 'synthetic-channel', auth_status = 'authorized' WHERE id = ?",
      [account.id],
    );
    expect(() => f.run(IPC.globalAccountDisconnect, "youtube")).toThrow();
    expect(f.beforeMutation).not.toHaveBeenCalled();
    f.beforeMutation.mockImplementation(() => {
      expect(
        f.db.get("SELECT auth_status FROM global_accounts WHERE id = ?", [account.id])?.auth_status,
      ).toBe("authorized");
    });
    expect(f.run(IPC.globalAccountDisconnect, account.id)).toMatchObject({
      id: account.id,
      remoteId: null,
      authStatus: "unauthorized",
    });
    expect(f.beforeMutation).toHaveBeenCalledWith(account.id);
    expect(f.run(IPC.globalAccountList)).toHaveLength(1);
  });
  it("does not remove a local grant when runtime cancellation fails", () => {
    const f = fixture();
    const account = f.run(IPC.globalAccountCreate, { platformId: "youtube" }) as { id: string };
    f.beforeMutation.mockImplementation(() => {
      throw new Error("cancel unavailable");
    });
    expect(() => f.run(IPC.globalAccountDisconnect, account.id)).toThrow("cancel unavailable");
    expect(f.db.all("SELECT * FROM audit_events")).toEqual([]);
  });
});
