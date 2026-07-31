/**
 * ExternalEventJournal - Append-only journal of external transient facts.
 *
 * A transient fact is an out-of-band observation pushed by a detector (today: a
 * GitHub webhook), normalized into a `(source, domain, type, params)` shape and
 * keyed by the detector's own delivery id. The journal turns an at-least-once
 * delivery into an exactly-once effect: {@link ExternalEventJournalShape.record}
 * inserts idempotently on `(source, deliveryKey)`, reporting `inserted: false`
 * for a duplicate so no downstream firing runs twice.
 *
 * Unlike STATE atoms there is no catch-up: the journal is not replayed, so a
 * fact recorded before any matching trigger existed never fires one. The arrival
 * of a fresh fact *is* the (event) rising edge.
 *
 * @module ExternalEventJournal
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/**
 * A normalized external fact ready to be journalled and matched against
 * transient atoms. `params` is the atom-shaped payload (e.g. for `git/pr.merged`
 * `{ repo, pr, branch }`); `deliveryKey` is the detector's own idempotency id
 * (for GitHub, the `X-GitHub-Delivery` header).
 */
export const ExternalEventFact = Schema.Struct({
  source: Schema.NonEmptyString,
  domain: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  params: Schema.Record(Schema.String, Schema.Unknown),
  deliveryKey: Schema.NonEmptyString,
  /** Optional raw payload retained for debugging/audit. */
  rawPayload: Schema.optional(Schema.String),
});
export type ExternalEventFact = typeof ExternalEventFact.Type;

/** Result of a {@link ExternalEventJournalShape.record}. */
export interface RecordExternalEventResult {
  /** True when this call inserted a new row; false when it was a duplicate. */
  readonly inserted: boolean;
}

/**
 * Query for the journalled facts of a `(domain, type)` recorded at or after an
 * ISO instant. Consumed by the composite evaluator to resolve TRANSIENT-atom
 * satisfaction against the window (Decision D21): a transient leaf is satisfied
 * iff a matching fact was journalled since the window opened.
 */
export const ListExternalEventsSinceInput = Schema.Struct({
  domain: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  since: Schema.String,
});
export type ListExternalEventsSinceInput = typeof ListExternalEventsSinceInput.Type;

/** A journalled fact as replayed to the composite evaluator. */
export const JournalledExternalEvent = Schema.Struct({
  domain: Schema.String,
  type: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
export type JournalledExternalEvent = typeof JournalledExternalEvent.Type;

/**
 * ExternalEventJournalShape - Service API for the external-event journal.
 */
export interface ExternalEventJournalShape {
  /**
   * Idempotently record a fact. Insert conflicts on `(source, deliveryKey)`
   * are no-ops, reported as `inserted: false`.
   */
  readonly record: (
    fact: ExternalEventFact,
  ) => Effect.Effect<RecordExternalEventResult, ProjectionRepositoryError>;

  /**
   * List the journalled facts of a `(domain, type)` recorded at or after
   * `since`, most-recent first. Used to resolve transient-atom satisfaction
   * inside a composite window.
   */
  readonly listFactsSince: (
    input: ListExternalEventsSinceInput,
  ) => Effect.Effect<ReadonlyArray<JournalledExternalEvent>, ProjectionRepositoryError>;
}

/**
 * ExternalEventJournal - Service tag for the external-event journal.
 */
export class ExternalEventJournal extends Context.Service<
  ExternalEventJournal,
  ExternalEventJournalShape
>()("t3/persistence/Services/ExternalEventJournal") {}
