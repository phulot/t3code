import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { TriggerAction, TriggerCondition, TriggerFireOutcome } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionTriggerInput,
  GetProjectionTriggerInput,
  ListActiveAtomTriggersForTypeInput,
  ListProjectionTriggersByProjectInput,
  ProjectionTrigger,
  ProjectionTriggerRepository,
  type ProjectionTriggerRepositoryShape,
  SetProjectionTriggerCompositeStateInput,
  SetProjectionTriggerConditionTruthInput,
} from "../Services/ProjectionTriggers.ts";

const ProjectionTriggerDbRow = ProjectionTrigger.mapFields(
  Struct.assign({
    enabled: Schema.Number,
    condition: Schema.fromJsonString(TriggerCondition),
    action: Schema.fromJsonString(TriggerAction),
    lastOutcome: Schema.NullOr(Schema.fromJsonString(TriggerFireOutcome)),
    conditionTruth: Schema.NullOr(Schema.Number),
  }),
);
type ProjectionTriggerDbRow = typeof ProjectionTriggerDbRow.Type;

function toProjectionTrigger(row: ProjectionTriggerDbRow): ProjectionTrigger {
  return {
    triggerId: row.triggerId,
    projectId: row.projectId,
    name: row.name,
    condition: row.condition,
    action: row.action,
    enabled: row.enabled === 1,
    consecutiveTransientFailures: row.consecutiveTransientFailures,
    lastFiredAt: row.lastFiredAt,
    lastOutcome: row.lastOutcome,
    nextEligibleAt: row.nextEligibleAt,
    conditionTruth: row.conditionTruth === null ? null : row.conditionTruth === 1,
    windowMs: row.windowMs,
    delayMs: row.delayMs,
    windowOpenedAt: row.windowOpenedAt,
    fireDueAt: row.fireDueAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const makeProjectionTriggerRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTriggerRow = SqlSchema.void({
    Request: ProjectionTrigger,
    execute: (row) =>
      sql`
        INSERT INTO projection_triggers (
          trigger_id,
          project_id,
          name,
          enabled,
          condition_json,
          action_json,
          consecutive_transient_failures,
          last_fired_at,
          last_outcome_json,
          next_eligible_at,
          condition_truth,
          window_ms,
          delay_ms,
          window_opened_at,
          fire_due_at,
          created_at,
          updated_at
        )
        VALUES (
          ${row.triggerId},
          ${row.projectId},
          ${row.name},
          ${row.enabled ? 1 : 0},
          ${JSON.stringify(row.condition)},
          ${JSON.stringify(row.action)},
          ${row.consecutiveTransientFailures},
          ${row.lastFiredAt},
          ${row.lastOutcome !== null ? JSON.stringify(row.lastOutcome) : null},
          ${row.nextEligibleAt},
          ${row.conditionTruth === null ? null : row.conditionTruth ? 1 : 0},
          ${row.windowMs},
          ${row.delayMs},
          ${row.windowOpenedAt},
          ${row.fireDueAt},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (trigger_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          enabled = excluded.enabled,
          condition_json = excluded.condition_json,
          action_json = excluded.action_json,
          consecutive_transient_failures = excluded.consecutive_transient_failures,
          last_fired_at = excluded.last_fired_at,
          last_outcome_json = excluded.last_outcome_json,
          next_eligible_at = excluded.next_eligible_at,
          condition_truth = excluded.condition_truth,
          window_ms = excluded.window_ms,
          delay_ms = excluded.delay_ms,
          window_opened_at = excluded.window_opened_at,
          fire_due_at = excluded.fire_due_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionTriggerRow = SqlSchema.findOneOption({
    Request: GetProjectionTriggerInput,
    Result: ProjectionTriggerDbRow,
    execute: ({ triggerId }) =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE trigger_id = ${triggerId}
      `,
  });

  const listProjectionTriggerRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTriggerDbRow,
    execute: () =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const listProjectionTriggerRowsByProject = SqlSchema.findAll({
    Request: ListProjectionTriggersByProjectInput,
    Result: ProjectionTriggerDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const listActiveTemporalTriggerRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTriggerDbRow,
    execute: () =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE enabled = 1
          AND json_extract(condition_json, '$.kind') = 'temporal'
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const listActiveAtomTriggerRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTriggerDbRow,
    execute: () =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE enabled = 1
          AND json_extract(condition_json, '$.kind') = 'atom'
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const listActiveAtomTriggerRowsForType = SqlSchema.findAll({
    Request: ListActiveAtomTriggersForTypeInput,
    Result: ProjectionTriggerDbRow,
    execute: ({ domain, type }) =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE enabled = 1
          AND json_extract(condition_json, '$.kind') = 'atom'
          AND json_extract(condition_json, '$.atom.domain') = ${domain}
          AND json_extract(condition_json, '$.atom.type') = ${type}
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const listActiveCompositeTriggerRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTriggerDbRow,
    execute: () =>
      sql`
        SELECT
          trigger_id AS "triggerId",
          project_id AS "projectId",
          name,
          condition_json AS "condition",
          action_json AS "action",
          enabled,
          consecutive_transient_failures AS "consecutiveTransientFailures",
          last_fired_at AS "lastFiredAt",
          last_outcome_json AS "lastOutcome",
          next_eligible_at AS "nextEligibleAt",
          condition_truth AS "conditionTruth",
          window_ms AS "windowMs",
          delay_ms AS "delayMs",
          window_opened_at AS "windowOpenedAt",
          fire_due_at AS "fireDueAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_triggers
        WHERE enabled = 1
          AND json_extract(condition_json, '$.kind') IN ('and', 'or', 'not')
        ORDER BY created_at ASC, trigger_id ASC
      `,
  });

  const setConditionTruthRow = SqlSchema.void({
    Request: SetProjectionTriggerConditionTruthInput,
    execute: ({ triggerId, truth }) =>
      sql`
        UPDATE projection_triggers
        SET condition_truth = ${truth ? 1 : 0}
        WHERE trigger_id = ${triggerId}
      `,
  });

  const setCompositeStateRow = SqlSchema.void({
    Request: SetProjectionTriggerCompositeStateInput,
    execute: ({ triggerId, windowOpenedAt, fireDueAt, conditionTruth }) =>
      sql`
        UPDATE projection_triggers
        SET window_opened_at = ${windowOpenedAt},
            fire_due_at = ${fireDueAt},
            condition_truth = ${conditionTruth === null ? null : conditionTruth ? 1 : 0}
        WHERE trigger_id = ${triggerId}
      `,
  });

  const deleteProjectionTriggerRow = SqlSchema.void({
    Request: DeleteProjectionTriggerInput,
    execute: ({ triggerId }) =>
      sql`
        DELETE FROM projection_triggers
        WHERE trigger_id = ${triggerId}
      `,
  });

  const upsert: ProjectionTriggerRepositoryShape["upsert"] = (row) =>
    upsertProjectionTriggerRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.upsert:query")),
    );

  const getById: ProjectionTriggerRepositoryShape["getById"] = (input) =>
    getProjectionTriggerRow(input).pipe(
      Effect.map(Option.map(toProjectionTrigger)),
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.getById:query")),
    );

  const listAll: ProjectionTriggerRepositoryShape["listAll"] = () =>
    listProjectionTriggerRows().pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.listAll:query")),
    );

  const listByProject: ProjectionTriggerRepositoryShape["listByProject"] = (input) =>
    listProjectionTriggerRowsByProject(input).pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.listByProject:query")),
    );

  const listActiveTemporal: ProjectionTriggerRepositoryShape["listActiveTemporal"] = () =>
    listActiveTemporalTriggerRows().pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionTriggerRepository.listActiveTemporal:query"),
      ),
    );

  const listActiveAtom: ProjectionTriggerRepositoryShape["listActiveAtom"] = () =>
    listActiveAtomTriggerRows().pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.listActiveAtom:query")),
    );

  const listActiveAtomsForType: ProjectionTriggerRepositoryShape["listActiveAtomsForType"] = (
    input,
  ) =>
    listActiveAtomTriggerRowsForType(input).pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionTriggerRepository.listActiveAtomsForType:query"),
      ),
    );

  const listActiveComposite: ProjectionTriggerRepositoryShape["listActiveComposite"] = () =>
    listActiveCompositeTriggerRows().pipe(
      Effect.map((rows) => rows.map(toProjectionTrigger)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionTriggerRepository.listActiveComposite:query"),
      ),
    );

  const setConditionTruth: ProjectionTriggerRepositoryShape["setConditionTruth"] = (input) =>
    setConditionTruthRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.setConditionTruth:query")),
    );

  const setCompositeState: ProjectionTriggerRepositoryShape["setCompositeState"] = (input) =>
    setCompositeStateRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.setCompositeState:query")),
    );

  const deleteById: ProjectionTriggerRepositoryShape["deleteById"] = (input) =>
    deleteProjectionTriggerRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTriggerRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    listByProject,
    listActiveTemporal,
    listActiveAtom,
    listActiveAtomsForType,
    listActiveComposite,
    setConditionTruth,
    setCompositeState,
    deleteById,
  } satisfies ProjectionTriggerRepositoryShape;
});

export const ProjectionTriggerRepositoryLive = Layer.effect(
  ProjectionTriggerRepository,
  makeProjectionTriggerRepository,
);
