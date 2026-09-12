import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { globalAccountIdSchema, globalPlatformIdSchema } from "@shared/global-accounts";
import type { GlobalPlatformId } from "@shared/platforms";
import {
  browserOwnerSchema,
  inspectBrowserProfileProcesses,
  type BrowserProfileOwner,
  type BrowserProfileProcessState,
} from "./global-browser-process-state";

const markerSchema = z
  .object({ version: z.literal(1), accountId: globalAccountIdSchema, platformId: globalPlatformIdSchema })
  .strict();
const lockSchema = z.object({ owner: browserOwnerSchema, nonce: z.string().uuid() }).strict();
const claimed = new Set<string>();
const fail = (code = "UNAVAILABLE") => new Error(`GLOBAL_BROWSER_PROFILE_${code}`);
interface Input {
  dataDirectory: string;
  accountId: string;
  platformId: GlobalPlatformId;
}
interface Dependencies {
  inspect?(directory: string, owner: BrowserProfileOwner | null): Promise<BrowserProfileProcessState>;
}
export interface GlobalBrowserProfile {
  readonly directory: string;
  /** Caller must stop/observe the actual browser before releasing this claim. */
  release(): Promise<void>;
  assertCurrent(): Promise<void>;
}

/** Remove an owned profile after the browser has been closed and its lock released. */
export async function wipeGlobalBrowserProfile(dataDirectory: string, accountId: string, platformId?: GlobalPlatformId): Promise<void> {
  const id = globalAccountIdSchema.parse(accountId).toLowerCase();
  const data = await fs.realpath(dataDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!data) return;
  const parent = path.join(data, "global-browser-profiles");
  const directory = path.join(parent, id);
  const parentInfo = await fs.lstat(parent).catch(() => null);
  if (!parentInfo || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return;
  const info = await fs.lstat(directory).catch(() => null);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(directory)) !== directory)
    throw fail("WIPE_FAILED");
  const marker = path.join(directory, "clipdock-profile.json");
  const parsed = markerSchema.parse(JSON.parse(await readPlain(marker, 1024)));
  if (parsed.accountId !== id || (platformId && parsed.platformId !== platformId)) throw fail("WIPE_FAILED");
  await fs.rm(directory, { recursive: true, force: false });
}
async function directoryAt(directory: string): Promise<void> {
  await fs.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await fs.lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    path.resolve(await fs.realpath(directory)) !== path.resolve(directory)
  )
    throw fail();
}
async function readPlain(file: string, limit: number): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw fail();
  return fs.readFile(file, "utf8");
}

/** Own directories only. Never adopt a personal browser profile, follow junctions,
 * remove cookies, or treat a stale lock as proof that an old browser is gone.
 */
export async function claimGlobalBrowserProfile(
  raw: Input,
  dependencies: Dependencies = {},
): Promise<GlobalBrowserProfile> {
  const accountId = globalAccountIdSchema.parse(raw.accountId).toLowerCase();
  const platformId = globalPlatformIdSchema.parse(raw.platformId);
  if (!path.isAbsolute(raw.dataDirectory)) throw fail();
  const data = await fs.realpath(raw.dataDirectory),
    parent = path.join(data, "global-browser-profiles"),
    directory = path.join(parent, accountId);
  if (claimed.has(directory)) throw fail("BUSY");
  claimed.add(directory);
  const inspect = dependencies.inspect ?? inspectBrowserProfileProcesses;
  let handle: FileHandle | undefined,
    lockText: string | undefined,
    released = false;
  const markerFile = path.join(directory, "clipdock-profile.json"),
    lockFile = path.join(directory, "clipdock-owner.lock");
  const checkPath = async () => {
    for (const folder of [parent, directory]) {
      const info = await fs.lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink() || (await fs.realpath(folder)) !== folder)
        throw fail();
    }
    const marker = markerSchema.parse(JSON.parse(await readPlain(markerFile, 1024)));
    if (marker.accountId !== accountId || marker.platformId !== platformId) throw fail();
  };
  try {
    await directoryAt(parent);
    await directoryAt(directory);
    try {
      await fs.lstat(markerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await fs.readdir(directory)).length) throw fail("FOREIGN_DIRECTORY");
      await fs.writeFile(markerFile, JSON.stringify({ version: 1, accountId, platformId }), {
        flag: "wx",
        mode: 0o600,
      });
    }
    await checkPath();
    let saved: z.infer<typeof lockSchema> | null = null,
      savedText: string | null = null;
    try {
      savedText = await readPlain(lockFile, 1024);
      saved = lockSchema.parse(JSON.parse(savedText));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail("BUSY");
    }
    const state = await inspect(directory, saved?.owner ?? null);
    browserOwnerSchema.parse(state.currentOwner);
    if (state.currentOwner.pid !== process.pid || state.profileRunning || (saved && state.ownerRunning))
      throw fail("BUSY");
    await checkPath();
    if (savedText !== null) {
      if ((await readPlain(lockFile, 1024)) !== savedText) throw fail("BUSY");
      await fs.unlink(lockFile);
    }
    handle = await fs.open(lockFile, "wx", 0o600);
    lockText = JSON.stringify({ owner: state.currentOwner, nonce: randomUUID() });
    await handle.writeFile(lockText);
    await handle.sync();
    const assertCurrent = async () => {
      if (released) throw fail("BUSY");
      await checkPath();
      if ((await readPlain(lockFile, 1024)) !== lockText) throw fail("BUSY");
    };
    return Object.freeze({
      directory,
      assertCurrent,
      release: async () => {
        if (released) return;
        try {
          await assertCurrent();
          if ((await inspect(directory, null)).profileRunning) throw fail("BUSY");
          await assertCurrent();
          await handle?.close();
          handle = undefined;
          await fs.unlink(lockFile);
          released = true;
          claimed.delete(directory);
        } catch {
          throw fail("BUSY");
        }
      },
    });
  } catch (error) {
    if (handle) {
      // Recover only the lock file this call created, even if its write failed.
      try {
        const owned = await handle.stat();
        await checkPath();
        const current = await fs.lstat(lockFile);
        await handle.close();
        handle = undefined;
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          owned.ino !== 0 &&
          current.ino === owned.ino &&
          current.dev === owned.dev
        )
          await fs.unlink(lockFile);
      } catch {
        await handle?.close().catch(() => undefined);
      }
    }
    claimed.delete(directory);
    if (error instanceof Error && /^GLOBAL_BROWSER_(?:PROFILE|PROCESS)_[A-Z_]+$/.test(error.message))
      throw error;
    throw fail();
  }
}

/** Called only while the claimed profile has no browser process. Preserve existing
 * preferences and login data; write the exact profile-level policy Chrome reads.
 */
export async function configureGlobalBrowserProfile(profile: GlobalBrowserProfile): Promise<void> {
  await profile.assertCurrent();
  const folder = path.join(profile.directory, "Default");
  await directoryAt(folder);
  const file = path.join(folder, "Preferences");
  let preferences: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readPlain(file, 4 * 1024 * 1024));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail();
    preferences = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fail();
  }
  const original = preferences.webrtc;
  if (original !== undefined && (!original || typeof original !== "object" || Array.isArray(original)))
    throw fail();
  preferences.webrtc = {
    ...(original as Record<string, unknown> | undefined),
    ip_handling_policy: "disable_non_proxied_udp",
    ip_handling_url: [],
    local_ips_allowed_urls: [],
  };
  await profile.assertCurrent();
  const temporary = path.join(folder, `clipdock-preferences-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(preferences), { flag: "wx", mode: 0o600 });
    await profile.assertCurrent();
    if ((await fs.lstat(folder)).isSymbolicLink() || (await fs.realpath(folder)) !== folder) throw fail();
    await fs.rename(temporary, file);
  } catch {
    throw fail();
  }
}
