import { CommandId, EventId, ProjectId, TriggerId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const makeTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-trigger");
const TRIGGER_ID = TriggerId.make("trigger-a");

const intervalCondition = {
  kind: "temporal" as const,
  schedule: { kind: "interval" as const, everyMs: 60_000 },
};
const startSessionAction = {
  kind: "startSession" as const,
  spec: { text: "run the nightly job" },
};

type TriggerRow = {
  readonly triggerId: string;
  readonly projectId: string;
  readonly name: string;
  readonly enabled: number;
  readonly conditionJson: string;
  readonly actionJson: string;
  readonly consecutiveTransientFailures: number;
  readonly lastFiredAt: string | null;
  readonly lastOutcomeJson: string | null;
  readonly nextEligibleAt: string | null;
};

const selectTrigger = (sql: SqlClient.SqlClient, triggerId: string) =>
  sql<TriggerRow>`
    SELECT
      trigger_id AS "triggerId",
      project_id AS "projectId",
      name,
      enabled,
      condition_json AS "conditionJson",
      action_json AS "actionJson",
      consecutive_transient_failures AS "consecutiveTransientFailures",
      last_fired_at AS "lastFiredAt",
      last_outcome_json AS "lastOutcomeJson",
      next_eligible_at AS "nextEligibleAt"
    FROM projection_triggers
    WHERE trigger_id = ${triggerId}
  `;

it.layer(Layer.fresh(makeTestLayer("t3-projection-triggers-")))(
  "OrchestrationProjectionTriggers",
  (it) => {
    it.effect("projects a trigger lifecycle through the DB pipeline", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-project"),
          aggregateKind: "project",
          aggregateId: PROJECT_ID,
          occurredAt: NOW,
          commandId: CommandId.make("cmd-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-project"),
          metadata: {},
          payload: {
            projectId: PROJECT_ID,
            title: "Project Trigger",
            workspaceRoot: "/tmp/project-trigger",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
          },
        });

        yield* eventStore.append({
          type: "trigger.created",
          eventId: EventId.make("evt-trigger-created"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: NOW,
          commandId: CommandId.make("cmd-trigger-created"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-created"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            projectId: PROJECT_ID,
            name: "Nightly",
            condition: intervalCondition,
            action: startSessionAction,
            enabled: true,
            createdAt: NOW,
            updatedAt: NOW,
          },
        });

        yield* projectionPipeline.bootstrap;

        const createdRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(createdRows.length, 1);
        assert.equal(createdRows[0]?.projectId, PROJECT_ID);
        assert.equal(createdRows[0]?.name, "Nightly");
        assert.equal(createdRows[0]?.enabled, 1);
        assert.equal(createdRows[0]?.consecutiveTransientFailures, 0);
        assert.equal(createdRows[0]?.lastFiredAt, null);
        assert.equal(createdRows[0]?.nextEligibleAt, null);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(createdRows[0]?.conditionJson ?? "null"), intervalCondition);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(createdRows[0]?.actionJson ?? "null"), startSessionAction);

        // Every projector (including the new triggers one) advanced.
        const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
          SELECT last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
          ORDER BY projector ASC
        `;
        assert.equal(stateRows.length, Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length);

        // fire-started stamps last_fired_at + a +60s anti-rebound window.
        yield* eventStore.append({
          type: "trigger.fire-started",
          eventId: EventId.make("evt-trigger-fire-started"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: "2026-01-02T00:00:00.000Z",
          commandId: CommandId.make("cmd-trigger-fire-started"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-fire-started"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            firedAt: "2026-01-02T00:00:00.000Z",
            nextEligibleAt: "2026-01-02T00:01:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const firedRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(firedRows[0]?.lastFiredAt, "2026-01-02T00:00:00.000Z");
        assert.equal(firedRows[0]?.nextEligibleAt, "2026-01-02T00:01:00.000Z");

        // fire-settled carries the decider-computed counter + terminal outcome.
        yield* eventStore.append({
          type: "trigger.fire-settled",
          eventId: EventId.make("evt-trigger-fire-settled"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: "2026-01-02T00:00:05.000Z",
          commandId: CommandId.make("cmd-trigger-fire-settled"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-fire-settled"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            firedAt: "2026-01-02T00:00:00.000Z",
            outcome: { status: "failed", failureKind: "transient", reason: "network blip" },
            consecutiveTransientFailures: 2,
            updatedAt: "2026-01-02T00:00:05.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const settledRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(settledRows[0]?.consecutiveTransientFailures, 2);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.deepEqual(JSON.parse(settledRows[0]?.lastOutcomeJson ?? "null"), {
          status: "failed",
          failureKind: "transient",
          reason: "network blip",
        });
        assert.equal(settledRows[0]?.enabled, 1);

        // auto-disabled flips enabled off without touching the counter.
        yield* eventStore.append({
          type: "trigger.auto-disabled",
          eventId: EventId.make("evt-trigger-auto-disabled"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: "2026-01-02T00:00:06.000Z",
          commandId: CommandId.make("cmd-trigger-auto-disabled"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-auto-disabled"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            reason: "5 consecutive transient failures",
            updatedAt: "2026-01-02T00:00:06.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const disabledRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(disabledRows[0]?.enabled, 0);

        // enable resets the counter back to 0.
        yield* eventStore.append({
          type: "trigger.enabled",
          eventId: EventId.make("evt-trigger-enabled"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: "2026-01-02T00:00:07.000Z",
          commandId: CommandId.make("cmd-trigger-enabled"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-enabled"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            updatedAt: "2026-01-02T00:00:07.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const enabledRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(enabledRows[0]?.enabled, 1);
        assert.equal(enabledRows[0]?.consecutiveTransientFailures, 0);

        // delete hard-removes the projection row.
        yield* eventStore.append({
          type: "trigger.deleted",
          eventId: EventId.make("evt-trigger-deleted"),
          aggregateKind: "trigger",
          aggregateId: TRIGGER_ID,
          occurredAt: "2026-01-02T00:00:08.000Z",
          commandId: CommandId.make("cmd-trigger-deleted"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-trigger-deleted"),
          metadata: {},
          payload: {
            triggerId: TRIGGER_ID,
            deletedAt: "2026-01-02T00:00:08.000Z",
          },
        });

        yield* projectionPipeline.bootstrap;

        const deletedRows = yield* selectTrigger(sql, TRIGGER_ID);
        assert.equal(deletedRows.length, 0);
      }),
    );
  },
);
