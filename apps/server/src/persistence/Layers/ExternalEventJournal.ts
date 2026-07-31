/**
 * ExternalEventJournalLive - SQLite-backed external-event journal.
 *
 * Idempotent insert into `external_events` keyed by the UNIQUE
 * `(source, delivery_key)`. The insert uses `ON CONFLICT DO NOTHING RETURNING
 * id`: a fresh delivery returns one row (`inserted: true`), a replayed delivery
 * returns none (`inserted: false`) and leaves the single stored row untouched.
 *
 * @module ExternalEventJournalLive
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ExternalEventJournal,
  type ExternalEventJournalShape,
  JournalledExternalEvent,
  ListExternalEventsSinceInput,
} from "../Services/ExternalEventJournal.ts";

// DB row shape: `params` arrives as the JSON text stored in `params_json`.
const JournalledExternalEventDbRow = JournalledExternalEvent.mapFields(
  Struct.assign({
    params: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

// Serialize the normalized params to the JSON stored in `params_json`. Kept a
// plain module-level helper (not inside the Effect generator) so it reads as a
// simple encode step rather than an effectful one.
const encodeParamsJson = (params: Record<string, unknown>): string => JSON.stringify(params);

const makeExternalEventJournal = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record: ExternalEventJournalShape["record"] = (fact) =>
    Effect.gen(function* () {
      const receivedAt = DateTime.formatIso(yield* DateTime.now);
      const paramsJson = encodeParamsJson(fact.params);
      const rows = yield* sql<{ readonly id: number }>`
        INSERT INTO external_events (
          source,
          delivery_key,
          domain,
          type,
          params_json,
          raw_payload_json,
          received_at
        )
        VALUES (
          ${fact.source},
          ${fact.deliveryKey},
          ${fact.domain},
          ${fact.type},
          ${paramsJson},
          ${fact.rawPayload ?? null},
          ${receivedAt}
        )
        ON CONFLICT (source, delivery_key) DO NOTHING
        RETURNING id
      `;
      return { inserted: rows.length > 0 };
    }).pipe(Effect.mapError(toPersistenceSqlError("ExternalEventJournal.record:query")));

  const listFactsSinceRows = SqlSchema.findAll({
    Request: ListExternalEventsSinceInput,
    Result: JournalledExternalEventDbRow,
    execute: ({ domain, type, since }) =>
      sql`
        SELECT
          domain,
          type,
          params_json AS "params"
        FROM external_events
        WHERE domain = ${domain}
          AND type = ${type}
          AND received_at >= ${since}
        ORDER BY received_at DESC, id DESC
      `,
  });

  const listFactsSince: ExternalEventJournalShape["listFactsSince"] = (input) =>
    listFactsSinceRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ExternalEventJournal.listFactsSince:query")),
    );

  return {
    record,
    listFactsSince,
  } satisfies ExternalEventJournalShape;
});

export const ExternalEventJournalLive = Layer.effect(
  ExternalEventJournal,
  makeExternalEventJournal,
);
