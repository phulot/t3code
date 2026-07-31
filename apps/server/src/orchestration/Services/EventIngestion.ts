/**
 * EventIngestion - Turn a normalized external fact into trigger firings.
 *
 * The EVENTIAL channel's counterpart to the condition evaluator's STATE polling.
 * A detector (today: the GitHub webhook) normalizes an inbound delivery into an
 * {@link ExternalEventFact} and hands it here. Ingestion is a single, idempotent
 * step:
 *   1. journal the fact on `(source, deliveryKey)` — a replayed delivery is a
 *      no-op (`inserted: false`) and fires nothing,
 *   2. only for a *fresh* fact, find the ACTIVE atom triggers of the fact's
 *      `(domain, type)` whose TRANSIENT atom `matches` the fact, and fire each
 *      through the shared trigger fire pipeline (60s anti-rebound included).
 *
 * There is no catch-up: a fact that arrives before any matching trigger exists
 * never fires one. The arrival of a fresh fact *is* the rising edge.
 *
 * @module EventIngestion
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ExternalEventFact } from "../../persistence/Services/ExternalEventJournal.ts";

/** Outcome of an {@link EventIngestionShape.ingest}. */
export interface IngestExternalEventResult {
  /** True when the fact was newly journalled; false when it was a duplicate. */
  readonly inserted: boolean;
  /** How many matching triggers were fired (always 0 for a duplicate). */
  readonly fired: number;
}

/**
 * EventIngestionShape - Service API for the external-event ingestion path.
 */
export interface EventIngestionShape {
  /**
   * Journal a fact and, if fresh, fire every ACTIVE transient-atom trigger it
   * matches. Idempotent on `(source, deliveryKey)`.
   */
  readonly ingest: (
    fact: ExternalEventFact,
  ) => Effect.Effect<IngestExternalEventResult, ProjectionRepositoryError>;
}

/**
 * EventIngestion - Service tag for the external-event ingestion path.
 */
export class EventIngestion extends Context.Service<EventIngestion, EventIngestionShape>()(
  "t3/orchestration/Services/EventIngestion",
) {}
