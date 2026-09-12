import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimGlobalBrowserProfile,
  configureGlobalBrowserProfile,
} from "./global-browser-profile";
import type { BrowserProfileProcessState } from "./global-browser-process-state";

const a = "123e4567-e89b-42d3-a456-426614174001",
  b = "123e4567-e89b-42d3-a456-426614174002";
const roots: string[] = [],
  releases: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
  for (const root of roots.splice(0).reverse()) {
    const resolved = await fs.realpath(root),
      intendedParent = await fs.realpath(os.tmpdir());
    if (
      path.dirname(resolved) !== intendedParent ||
      !path.basename(resolved).startsWith("clipdock-web-profile-")
    )
      throw new Error("UNSAFE_TEST_CLEANUP_PATH");
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "clipdock-web-profile-"));
  roots.push(dataDirectory);
  const state: BrowserProfileProcessState = {
    currentOwner: { pid: process.pid, startedAtTicks: "639243600000000000" },
    ownerRunning: false,
    profileRunning: false,
  };
  const inspect = vi.fn(async () => ({ ...state }));
  const claim = async (accountId = a) => {
    const profile = await claimGlobalBrowserProfile(
      { dataDirectory, accountId, platformId: "youtube" },
      { inspect },
    );
    releases.push(async () => {
      state.profileRunning = false;
      await profile.release();
    });
    return profile;
  };
  return { dataDirectory, state, inspect, claim };
}
describe("owned international browser profiles", () => {
  it("keeps two accounts in separate owned directories and excludes simultaneous claims", async () => {
    const f = await fixture(),
      first = await f.claim(),
      second = await f.claim(b);
    expect(first.directory).not.toBe(second.directory);
    await expect(f.claim()).rejects.toThrow("GLOBAL_BROWSER_PROFILE_BUSY");
    await first.assertCurrent();
    await first.release();
    await expect(first.assertCurrent()).rejects.toThrow();
    await expect(f.claim()).resolves.toHaveProperty("directory", first.directory);
  });
  it("preserves profile data while applying the exact Chrome WebRTC preference", async () => {
    const f = await fixture(),
      profile = await f.claim();
    const folder = path.join(profile.directory, "Default");
    await fs.mkdir(folder);
    const cookieFile = path.join(folder, "synthetic-cookie-data");
    await fs.writeFile(cookieFile, "controlled persistent bytes");
    await fs.writeFile(
      path.join(folder, "Preferences"),
      JSON.stringify({
        bookmark_bar: { show_on_all_tabs: true },
        webrtc: {
          other_preference: true,
          ip_handling_policy: "default",
          ip_handling_url: [{ url: "*", handling: "default" }],
        },
      }),
    );
    await configureGlobalBrowserProfile(profile);
    const preferences = JSON.parse(await fs.readFile(path.join(folder, "Preferences"), "utf8"));
    expect(preferences.bookmark_bar.show_on_all_tabs).toBe(true);
    expect(preferences.webrtc).toMatchObject({
      other_preference: true,
      ip_handling_policy: "disable_non_proxied_udp",
      ip_handling_url: [],
      local_ips_allowed_urls: [],
    });
    expect(await fs.readFile(cookieFile, "utf8")).toBe("controlled persistent bytes");
  });
  it("does not adopt an unmarked directory containing existing browser data", async () => {
    const f = await fixture(),
      directory = path.join(f.dataDirectory, "global-browser-profiles", a);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "existing-cookie-data"), "keep");
    await expect(f.claim()).rejects.toThrow("GLOBAL_BROWSER_PROFILE_FOREIGN_DIRECTORY");
    expect(await fs.readFile(path.join(directory, "existing-cookie-data"), "utf8")).toBe("keep");
  });
  it("refuses a junction to another directory before reading or writing its contents", async () => {
    const f = await fixture(),
      outside = await fixture(),
      parent = path.join(f.dataDirectory, "global-browser-profiles");
    await fs.mkdir(parent);
    await fs.symlink(
      outside.dataDirectory,
      path.join(parent, a),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(f.claim()).rejects.toThrow();
    expect(await fs.readdir(outside.dataDirectory)).toEqual([]);
  });
  it("refuses mismatched account ownership without discarding the profile", async () => {
    const f = await fixture(),
      profile = await f.claim();
    await profile.release();
    await fs.writeFile(
      path.join(profile.directory, "clipdock-profile.json"),
      JSON.stringify({ version: 1, accountId: b, platformId: "youtube" }),
    );
    await expect(f.claim()).rejects.toThrow();
    expect(await fs.readdir(profile.directory)).toContain("clipdock-profile.json");
  });
  it("requires both the saved owner and actual profile browser to be gone before stale recovery", async () => {
    const f = await fixture(),
      first = await f.claim();
    await first.release();
    const lockFile = path.join(first.directory, "clipdock-owner.lock");
    await fs.writeFile(
      lockFile,
      JSON.stringify({ owner: { pid: 12345, startedAtTicks: "639200000000000000" }, nonce: b }),
    );
    f.state.ownerRunning = true;
    await expect(f.claim()).rejects.toThrow("GLOBAL_BROWSER_PROFILE_BUSY");
    f.state.ownerRunning = false;
    f.state.profileRunning = true;
    await expect(f.claim()).rejects.toThrow("GLOBAL_BROWSER_PROFILE_BUSY");
    f.state.profileRunning = false;
    const recovered = await f.claim();
    expect(recovered.directory).toBe(first.directory);
    expect(f.inspect).toHaveBeenCalledWith(first.directory, {
      pid: 12345,
      startedAtTicks: "639200000000000000",
    });
  });
  it("does not release a directory still used by a browser", async () => {
    const f = await fixture(),
      profile = await f.claim();
    f.state.profileRunning = true;
    await expect(profile.release()).rejects.toThrow("GLOBAL_BROWSER_PROFILE_BUSY");
    await expect(fs.stat(path.join(profile.directory, "clipdock-owner.lock"))).resolves.toBeDefined();
    f.state.profileRunning = false;
    await profile.release();
  });
  it("preserves malformed Preferences instead of silently replacing them", async () => {
    const f = await fixture(),
      profile = await f.claim(),
      folder = path.join(profile.directory, "Default");
    await fs.mkdir(folder);
    const file = path.join(folder, "Preferences");
    await fs.writeFile(file, "{invalid user preferences");
    await expect(configureGlobalBrowserProfile(profile)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("{invalid user preferences");
  });
  it.each(["../personal", "", "C:\\Users\\someone\\Chrome", "youtube"])(
    "rejects a non-UUID account path: %s",
    async (accountId) => {
      const f = await fixture();
      await expect(f.claim(accountId)).rejects.toThrow();
      expect(f.inspect).not.toHaveBeenCalled();
    },
  );
});
