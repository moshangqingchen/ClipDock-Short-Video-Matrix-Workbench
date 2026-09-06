/**
 * Read-only inspection of one account partition's cookie store.
 * usage: node scripts/inspect-cookies.mjs <userDataDir> [accountNameFilter]
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const [, , userData, filter = ""] = process.argv;
if (!userData) {
  console.error("usage: node scripts/inspect-cookies.mjs <userDataDir> [accountNameFilter]");
  process.exit(1);
}
const db = new DatabaseSync(path.join(userData, "workbench.db"), { readOnly: true });
const accounts = db.prepare("SELECT id, display_name, platform_id, status FROM accounts").all();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-inspect-"));

for (const account of accounts) {
  if (filter && !String(account.display_name).includes(filter)) continue;
  const file = path.join(userData, "profiles", "Partitions", `sv-account-${account.id}`, "Network", "Cookies");
  console.log(`\n== ${account.display_name} (${account.platform_id}, ${account.status})`);
  if (!fs.existsSync(file)) {
    console.log("   no cookie store yet");
    continue;
  }
  // Copy so a live (locked) store can still be read; fall back to an
  // immutable URI open when Windows refuses the copy.
  let cookies;
  try {
    const copy = path.join(tmp, `${account.id}.db`);
    fs.copyFileSync(file, copy);
    cookies = new DatabaseSync(copy, { readOnly: true, readBigInts: true });
  } catch {
    cookies = new DatabaseSync(`file:${file.replace(/\\/g, "/")}?immutable=1`, { readOnly: true, readBigInts: true });
  }
  const showAll = process.argv.includes("--all");
  const rows = cookies
    .prepare("SELECT host_key, name, is_persistent, CAST(expires_utc/1000000 AS INTEGER) AS exp_s FROM cookies ORDER BY host_key, name")
    .all();
  const total = rows.length;
  const session = rows.filter((r) => Number(r.is_persistent) === 0).length;
  console.log(`   ${total} cookies, ${session} still session-only`);
  const interesting = /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|ttwid|passToken|kuaishou\.web\.cp\.api_ph|web_session|SESSDATA|bili_jct|BDUSS|wxuin)$/;
  for (const r of rows) {
    if (!showAll && !interesting.test(String(r.name))) continue;
    const exp = Number(r.exp_s) > 0 ? new Date((Number(r.exp_s) - 11644473600) * 1000).toISOString().slice(0, 10) : "session";
    console.log(`   ${String(r.host_key).padEnd(28)} ${String(r.name).padEnd(24)} persistent=${Number(r.is_persistent)} expires=${exp}`);
  }
  cookies.close();
}
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
