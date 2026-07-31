/**
 * ProjectionTriggerRepository - Projection repository interface for triggers.
 *
 * Owns persistence operations for trigger rows in the orchestration projection
 * read model.
 *
 * @module ProjectionTriggerRepository
 */
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TriggerAction,
  TriggerCondition,
  TriggerFireOutcome,
  TriggerId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTrigger = Schema.Struct({
  triggerId: TriggerId,
  projectId: ProjectId,
  name: Schema.String,
  condition: TriggerCondition,
  action: TriggerAction,
  enabled: Schema.Boolean,
  consecutiveTransientFailures: NonNegativeInt,
  lastFiredAt: Schema.NullOr(IsoDateTime),
  lastOutcome: Schema.NullOr(TriggerFireOutcome),
  nextEligibleAt: Schema.NullOr(IsoDateTime),
  // Last evaluated truth of an atom STATE / composite condition, or null while
  // never evaluated (temporal triggers keep it null). Owned by the condition
  // evaluator, not by any projected event.
  conditionTruth: Schema.NullOr(Schema.Boolean),
  // Composite-condition config (Decision D20), carried by the create/update
  // payload. Fixed bounds in milliseconds; null when unset / not composite.
  windowMs: Schema.NullOr(Schema.Number),
  delayMs: Schema.NullOr(Schema.Number),
  // Composite-condition partial runtime state (Decision D22), epoch ms. Owned by
  // the condition evaluator. `windowOpenedAt` is stamped at the first signal;
  // `fireDueAt` is the armed delay deadline. Null when the composite is at rest.
  windowOpenedAt: Schema.NullOr(Schema.Number),
  fireDueAt: Schema.NullOr(Schema.Number),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionTrigger = typeof ProjectionTrigger.Type;

export const SetProjectionTriggerConditionTruthInput = Schema.Struct({
  triggerId: TriggerId,
  truth: Schema.Boolean,
});
export type SetProjectionTriggerConditionTruthInput =
  typeof SetProjectionTriggerConditionTruthInput.Type;

export const SetProjectionTriggerCompositeStateInput = Schema.Struct({
  triggerId: TriggerId,
  windowOpenedAt: Schema.NullOr(Schema.Number),
  fireDueAt: Schema.NullOr(Schema.Number),
  conditionTruth: Schema.NullOr(Schema.Boolean),
});
export type SetProjectionTriggerCompositeStateInput =
  typeof SetProjectionTriggerCompositeStateInput.Type;

export const GetProjectionTriggerInput = Schema.Struct({
  triggerId: TriggerId,
});
export type GetProjectionTriggerInput = typeof GetProjectionTriggerInput.Type;

export const ListProjectionTriggersByProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListProjectionTriggersByProjectInput = typeof ListProjectionTriggersByProjectInput.Type;

export const DeleteProjectionTriggerInput = Schema.Struct({
  triggerId: TriggerId,
});
export type DeleteProjectionTriggerInput = typeof DeleteProjectionTriggerInput.Type;

export const ListActiveAtomTriggersForTypeInput = Schema.Struct({
  domain: Schema.String,
  type: Schema.String,
});
export type ListActiveAtomTriggersForTypeInput = typeof ListActiveAtomTriggersForTypeInput.Type;

/**
 * ProjectionTriggerRepositoryShape - Service API for projected trigger records.
 */
export interface ProjectionTriggerRepositoryShape {
  /**
   * Insert or replace a projected trigger row.
   *
   * Upserts by `triggerId` and persists condition/action/outcome through JSON
   * encoding.
   */
  readonly upsert: (row: ProjectionTrigger) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected trigger row by id.
   */
  readonly getById: (
    input: GetProjectionTriggerInput,
  ) => Effect.Effect<Option.Option<ProjectionTrigger>, ProjectionRepositoryError>;

  /**
   * List all projected trigger rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionTrigger>,
    ProjectionRepositoryError
  >;

  /**
   * List projected trigger rows for a project.
   */
  readonly listByProject: (
    input: ListProjectionTriggersByProjectInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTrigger>, ProjectionRepositoryError>;

  /**
   * List enabled triggers whose condition is temporal. Consumed by the future
   * scheduler (2b) to know which triggers to arm.
   */
  readonly listActiveTemporal: () => Effect.Effect<
    ReadonlyArray<ProjectionTrigger>,
    ProjectionRepositoryError
  >;

  /**
   * List enabled triggers whose condition is an atom. Consumed by the condition
   * evaluator, which further narrows to STATE atoms via the atom registry.
   */
  readonly listActiveAtom: () => Effect.Effect<
    ReadonlyArray<ProjectionTrigger>,
    ProjectionRepositoryError
  >;

  /**
   * List enabled triggers whose condition is a composite (`and`/`or`/`not`).
   * Consumed by the condition evaluator to drive the composite state machine.
   */
  readonly listActiveComposite: () => Effect.Effect<
    ReadonlyArray<ProjectionTrigger>,
    ProjectionRepositoryError
  >;

  /**
   * List enabled triggers whose condition is an atom of the given
   * `(domain, type)`. Consumed by the event-ingestion path to find the
   * candidate transient-atom triggers a journalled fact might fire; the caller
   * further narrows to TRANSIENT atoms and to those the fact actually matches.
   */
  readonly listActiveAtomsForType: (
    input: ListActiveAtomTriggersForTypeInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTrigger>, ProjectionRepositoryError>;

  /**
   * Persist the last evaluated truth of a trigger's atom STATE condition.
   * Targeted update: never touches the columns owned by projected events.
   */
  readonly setConditionTruth: (
    input: SetProjectionTriggerConditionTruthInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Persist a composite trigger's partial runtime state (window/delay/truth).
   * Targeted update: never touches `next_eligible_at` (owned by the fire
   * pipeline) nor any column owned by projected events.
   */
  readonly setCompositeState: (
    input: SetProjectionTriggerCompositeStateInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Hard-delete a projected trigger row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionTriggerInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionTriggerRepository - Service tag for trigger projection persistence.
 */
export class ProjectionTriggerRepository extends Context.Service<
  ProjectionTriggerRepository,
  ProjectionTriggerRepositoryShape
>()("t3/persistence/Services/ProjectionTriggers/ProjectionTriggerRepository") {}
