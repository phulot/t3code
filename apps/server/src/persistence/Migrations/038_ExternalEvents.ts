import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Journal of external, transient facts (e.g. a GitHub "pull_request merged"
  // webhook). Unlike the STATE-atom `condition_truth`, this is an append-only
  // event log with no catch-up: only facts recorded here drive transient-atom
  // firings, and a fact that arrived before a trigger existed is never replayed.
  //
  // `(source, delivery_key)` is UNIQUE: it turns an at-least-once delivery
  // (GitHub retries on non-2xx / timeout, all with the same X-GitHub-Delivery)
  // into an exactly-once effect. A duplicate insert is a no-op, so the firing
  // that follows a fresh insert runs at most once per delivery.
  yield* sql`
    CREATE TABLE IF NOT EXISTS external_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      delivery_key TEXT NOT NULL,
      domain TEXT NOT NULL,
      type TEXT NOT NULL,
      params_json TEXT NOT NULL,
      raw_payload_json TEXT,
      received_at TEXT NOT NULL,
      UNIQUE (source, delivery_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_external_events_domain_type
    ON external_events(domain, type)
  `;
});
