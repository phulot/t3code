import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Composite-condition runtime state (Decision D20/D22). All four columns are
  // NULL for temporal/atom triggers and for a composite at rest.
  //
  // - window_ms / delay_ms: the trigger-level fixed bounds (config, carried by
  //   the create/update payload). window_ms bounds how long a partially
  //   satisfied composite may wait for completion; delay_ms delays the fire
  //   after full satisfaction.
  // - window_opened_at / fire_due_at: the evaluator-owned partial state, stored
  //   as epoch milliseconds. window_opened_at is stamped at the first signal;
  //   fire_due_at is the armed deadline while a delay is pending. Both survive a
  //   restart so an in-flight window/delay is not lost.
  yield* sql`
    ALTER TABLE projection_triggers
    ADD COLUMN window_ms INTEGER
  `;
  yield* sql`
    ALTER TABLE projection_triggers
    ADD COLUMN delay_ms INTEGER
  `;
  yield* sql`
    ALTER TABLE projection_triggers
    ADD COLUMN window_opened_at INTEGER
  `;
  yield* sql`
    ALTER TABLE projection_triggers
    ADD COLUMN fire_due_at INTEGER
  `;
});
