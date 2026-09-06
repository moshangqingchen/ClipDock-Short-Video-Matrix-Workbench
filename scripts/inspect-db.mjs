/**
 * Read-only dump of workbench state for diagnostics.
 * usage: node scripts/inspect-db.mjs <userDataDir>
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const [, , userData] = process.argv;
if (!userData) {
  console.error("usage: node scripts/inspect-db.mjs <userDataDir>");
  process.exit(1);
}
const db = new DatabaseSync(path.join(userData, "workbench.db"), { readOnly: true });
const show = (title, sql) => {
  console.log(`\n== ${title}`);
  for (const row of db.prepare(sql).all()) console.log("  " + JSON.stringify(row));
};

show("accounts", "SELECT display_name, platform_id, status, status_message, last_online_at, last_checked_at FROM accounts ORDER BY platform_id");
show(
  "status transitions (latest 15)",
  `SELECT a.display_name, e.details_json, e.created_at FROM audit_events e JOIN accounts a ON a.id = e.account_id
   WHERE e.action = 'account.status' ORDER BY e.id DESC LIMIT 15`,
);
show(
  "collect runs (latest 10)",
  `SELECT a.display_name, r.status, r.trigger_kind, r.message, r.metrics_written, r.works_written, r.started_at
   FROM collect_runs r JOIN accounts a ON a.id = r.account_id ORDER BY r.id DESC LIMIT 10`,
);
show(
  "latest account metrics",
  `SELECT a.display_name, m.metric, m.value, m.captured_at FROM metric_snapshots m JOIN accounts a ON a.id = m.account_id
   WHERE m.work_id IS NULL ORDER BY m.id DESC LIMIT 16`,
);
show("works count per account", "SELECT a.display_name, COUNT(w.id) AS works FROM accounts a LEFT JOIN works w ON w.account_id = a.id GROUP BY a.id");
db.close();
