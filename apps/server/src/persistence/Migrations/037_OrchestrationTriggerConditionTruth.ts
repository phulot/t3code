import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Last evaluated truth of an atom STATE condition (1/0), or NULL when never
  // evaluated yet. NULL is deliberately distinct from 0 so a trigger whose
  // condition is already true at creation still sees a rising edge on the first
  // evaluator tick (catch-up at creation). Nullable: temporal triggers never
  // set it.
  yield* sql`
    ALTER TABLE projection_triggers
    ADD COLUMN condition_truth INTEGER
  `;
});
