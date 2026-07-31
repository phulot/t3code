import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ExternalEventJournalLive } from "./ExternalEventJournal.ts";
import { ExternalEventJournal, type ExternalEventFact } from "../Services/ExternalEventJournal.ts";

const journalLayer = it.layer(
  Layer.mergeAll(
    ExternalEventJournalLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const fact = (overrides?: Partial<ExternalEventFact>): ExternalEventFact => ({
  source: "github",
  domain: "git",
  type: "pr.merged",
  params: { repo: "octo/repo", pr: 42, branch: "feature/x" },
  deliveryKey: "delivery-1",
  ...overrides,
});

// The in-memory SQLite is shared across the tests in this layer group, so each
// test uses its own delivery key(s) and counts only its own rows.
const countByKey = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM external_events WHERE delivery_key = ${key}
    `;
    return rows[0]?.count ?? 0;
  });

journalLayer("ExternalEventJournal", (it) => {
  it.effect("records a fresh fact as inserted", () =>
    Effect.gen(function* () {
      const journal = yield* ExternalEventJournal;
      const result = yield* journal.record(fact({ deliveryKey: "fresh" }));
      assert.deepStrictEqual(result, { inserted: true });
      assert.strictEqual(yield* countByKey("fresh"), 1);
    }),
  );

  it.effect("treats a duplicate delivery as not inserted and stores one row", () =>
    Effect.gen(function* () {
      const journal = yield* ExternalEventJournal;
      const first = yield* journal.record(fact({ deliveryKey: "dup" }));
      const second = yield* journal.record(fact({ deliveryKey: "dup" }));
      assert.deepStrictEqual(first, { inserted: true });
      assert.deepStrictEqual(second, { inserted: false });
      assert.strictEqual(yield* countByKey("dup"), 1);
    }),
  );

  it.effect("distinguishes deliveries by delivery key", () =>
    Effect.gen(function* () {
      const journal = yield* ExternalEventJournal;
      yield* journal.record(fact({ deliveryKey: "distinct-a" }));
      const other = yield* journal.record(fact({ deliveryKey: "distinct-b" }));
      assert.deepStrictEqual(other, { inserted: true });
      assert.strictEqual(yield* countByKey("distinct-a"), 1);
      assert.strictEqual(yield* countByKey("distinct-b"), 1);
    }),
  );
});
