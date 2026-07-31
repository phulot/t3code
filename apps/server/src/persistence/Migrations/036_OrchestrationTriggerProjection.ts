import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_triggers (
      trigger_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      condition_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      consecutive_transient_failures INTEGER NOT NULL,
      last_fired_at TEXT,
      last_outcome_json TEXT,
      next_eligible_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_triggers_project_id
    ON projection_triggers(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_triggers_enabled
    ON projection_triggers(enabled)
  `;
});
