import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TriggerId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTriggerId = (value: string): TriggerId => TriggerId.make(value);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = asProjectId("project-trigger");
const TRIGGER_ID = asTriggerId("trigger-a");

const intervalCondition = {
  kind: "temporal" as const,
  schedule: { kind: "interval" as const, everyMs: 60_000 },
};
const startSessionAction = {
  kind: "startSession" as const,
  spec: { text: "run the nightly job" },
};

const seedWithProject = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  return yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: PROJECT_ID,
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
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
});

// Applies the events produced by one command onto the read model, mirroring the
// engine's decide -> project loop so subsequent commands see prior effects.
const applyCommand = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel }).pipe(Effect.orDie);
    const events = Array.isArray(decided) ? decided : [decided];
    let nextReadModel = readModel;
    let nextSequence = readModel.snapshotSequence;
    for (const event of events) {
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, { ...event, sequence: nextSequence }).pipe(
        Effect.orDie,
      );
    }
    return { readModel: nextReadModel, events };
  });

const seedWithTrigger = Effect.gen(function* () {
  const readModel = yield* seedWithProject;
  const { readModel: withTrigger } = yield* applyCommand(readModel, {
    type: "trigger.create",
    commandId: asCommandId("cmd-trigger-create"),
    triggerId: TRIGGER_ID,
    projectId: PROJECT_ID,
    name: "Nightly",
    condition: intervalCondition,
    action: startSessionAction,
  });
  return withTrigger;
});

it.layer(NodeServices.layer)("decider trigger flows", (it) => {
  it.effect("creates a trigger for an existing project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject;
      const { readModel: next, events } = yield* applyCommand(readModel, {
        type: "trigger.create",
        commandId: asCommandId("cmd-trigger-create"),
        triggerId: TRIGGER_ID,
        projectId: PROJECT_ID,
        name: "Nightly",
        condition: intervalCondition,
        action: startSessionAction,
      });
      expect(events.map((event) => event.type)).toEqual(["trigger.created"]);
      const trigger = next.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger).toBeDefined();
      expect(trigger?.enabled).toBe(true);
      expect(trigger?.consecutiveTransientFailures).toBe(0);
      expect(trigger?.lastFiredAt).toBeNull();
      expect(trigger?.nextEligibleAt).toBeNull();
    }),
  );

  it.effect("honours enabled=false on create", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject;
      const { readModel: next } = yield* applyCommand(readModel, {
        type: "trigger.create",
        commandId: asCommandId("cmd-trigger-create-disabled"),
        triggerId: TRIGGER_ID,
        projectId: PROJECT_ID,
        name: "Nightly",
        condition: intervalCondition,
        action: startSessionAction,
        enabled: false,
      });
      expect(next.triggers.find((entry) => entry.id === TRIGGER_ID)?.enabled).toBe(false);
    }),
  );

  it.effect("rejects creating a trigger for a missing project", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "trigger.create",
            commandId: asCommandId("cmd-trigger-create-missing"),
            triggerId: asTriggerId("trigger-missing"),
            projectId: asProjectId("project-does-not-exist"),
            name: "Nightly",
            condition: intervalCondition,
            action: startSessionAction,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );

  it.effect("rejects creating the same trigger twice", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "trigger.create",
            commandId: asCommandId("cmd-trigger-create-dup"),
            triggerId: TRIGGER_ID,
            projectId: PROJECT_ID,
            name: "Nightly",
            condition: intervalCondition,
            action: startSessionAction,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("cannot be created twice");
    }),
  );

  it.effect("updates a trigger's name/condition/action", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const { readModel: next, events } = yield* applyCommand(readModel, {
        type: "trigger.update",
        commandId: asCommandId("cmd-trigger-update"),
        triggerId: TRIGGER_ID,
        name: "Renamed",
        condition: { kind: "temporal", schedule: { kind: "at", timestamp: 1_800_000 } },
      });
      expect(events.map((event) => event.type)).toEqual(["trigger.updated"]);
      const trigger = next.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger?.name).toBe("Renamed");
      expect(trigger?.condition).toEqual({
        kind: "temporal",
        schedule: { kind: "at", timestamp: 1_800_000 },
      });
    }),
  );

  it.effect("disables then enables a trigger", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const { readModel: disabled, events: disableEvents } = yield* applyCommand(readModel, {
        type: "trigger.disable",
        commandId: asCommandId("cmd-trigger-disable"),
        triggerId: TRIGGER_ID,
      });
      expect(disableEvents.map((event) => event.type)).toEqual(["trigger.disabled"]);
      expect(disabled.triggers.find((entry) => entry.id === TRIGGER_ID)?.enabled).toBe(false);

      const { readModel: enabled, events: enableEvents } = yield* applyCommand(disabled, {
        type: "trigger.enable",
        commandId: asCommandId("cmd-trigger-enable"),
        triggerId: TRIGGER_ID,
      });
      expect(enableEvents.map((event) => event.type)).toEqual(["trigger.enabled"]);
      expect(enabled.triggers.find((entry) => entry.id === TRIGGER_ID)?.enabled).toBe(true);
    }),
  );

  it.effect("deletes a trigger", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const { readModel: next, events } = yield* applyCommand(readModel, {
        type: "trigger.delete",
        commandId: asCommandId("cmd-trigger-delete"),
        triggerId: TRIGGER_ID,
      });
      expect(events.map((event) => event.type)).toEqual(["trigger.deleted"]);
      expect(next.triggers.find((entry) => entry.id === TRIGGER_ID)).toBeUndefined();
    }),
  );

  it.effect("rejects mutating a missing trigger", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "trigger.disable",
            commandId: asCommandId("cmd-trigger-disable-missing"),
            triggerId: asTriggerId("trigger-missing"),
          },
          readModel,
        }),
      );
      expect(error.message).toContain("does not exist");
    }),
  );

  it.effect("fire-started records lastFiredAt and a +60s nextEligibleAt", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const firedAt = "2026-01-02T00:00:00.000Z";
      const { readModel: next, events } = yield* applyCommand(readModel, {
        type: "trigger.fire-started",
        commandId: asCommandId("cmd-trigger-fire-started"),
        triggerId: TRIGGER_ID,
        firedAt,
      });
      expect(events.map((event) => event.type)).toEqual(["trigger.fire-started"]);
      const trigger = next.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger?.lastFiredAt).toBe(firedAt);
      expect(trigger?.nextEligibleAt).toBe("2026-01-02T00:01:00.000Z");
    }),
  );

  it.effect("fire-settled succeeded records the outcome and keeps the counter at 0", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const { readModel: next, events } = yield* applyCommand(readModel, {
        type: "trigger.fire-settled",
        commandId: asCommandId("cmd-trigger-fire-settled"),
        triggerId: TRIGGER_ID,
        firedAt: "2026-01-02T00:00:00.000Z",
        outcome: { status: "succeeded", threadId: ThreadId.make("thread-x") },
      });
      expect(events.map((event) => event.type)).toEqual(["trigger.fire-settled"]);
      const trigger = next.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger?.consecutiveTransientFailures).toBe(0);
      expect(trigger?.lastOutcome).toEqual({
        status: "succeeded",
        threadId: "thread-x",
      });
      expect(trigger?.enabled).toBe(true);
    }),
  );

  it.effect("a permanent failure records the outcome without incrementing the counter", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithTrigger;
      const { readModel: next } = yield* applyCommand(readModel, {
        type: "trigger.fire-settled",
        commandId: asCommandId("cmd-trigger-fire-permanent"),
        triggerId: TRIGGER_ID,
        firedAt: "2026-01-02T00:00:00.000Z",
        outcome: { status: "failed", failureKind: "permanent", reason: "bad config" },
      });
      const trigger = next.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger?.consecutiveTransientFailures).toBe(0);
      expect(trigger?.enabled).toBe(true);
    }),
  );

  it.effect("auto-disables after 5 consecutive transient failures", () =>
    Effect.gen(function* () {
      let readModel = yield* seedWithTrigger;
      const transientOutcome = {
        status: "failed" as const,
        failureKind: "transient" as const,
        reason: "network blip",
      };

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const result = yield* applyCommand(readModel, {
          type: "trigger.fire-settled",
          commandId: asCommandId(`cmd-trigger-transient-${attempt}`),
          triggerId: TRIGGER_ID,
          firedAt: "2026-01-02T00:00:00.000Z",
          outcome: transientOutcome,
        });
        readModel = result.readModel;
        expect(result.events.map((event) => event.type)).toEqual(["trigger.fire-settled"]);
        const trigger = readModel.triggers.find((entry) => entry.id === TRIGGER_ID);
        expect(trigger?.consecutiveTransientFailures).toBe(attempt);
        expect(trigger?.enabled).toBe(true);
      }

      const fifth = yield* applyCommand(readModel, {
        type: "trigger.fire-settled",
        commandId: asCommandId("cmd-trigger-transient-5"),
        triggerId: TRIGGER_ID,
        firedAt: "2026-01-02T00:00:00.000Z",
        outcome: transientOutcome,
      });
      readModel = fifth.readModel;
      expect(fifth.events.map((event) => event.type)).toEqual([
        "trigger.fire-settled",
        "trigger.auto-disabled",
      ]);
      const trigger = readModel.triggers.find((entry) => entry.id === TRIGGER_ID);
      expect(trigger?.consecutiveTransientFailures).toBe(5);
      expect(trigger?.enabled).toBe(false);
    }),
  );

  it.effect("a success resets the transient failure counter", () =>
    Effect.gen(function* () {
      let readModel = yield* seedWithTrigger;
      const transientOutcome = {
        status: "failed" as const,
        failureKind: "transient" as const,
        reason: "network blip",
      };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const result = yield* applyCommand(readModel, {
          type: "trigger.fire-settled",
          commandId: asCommandId(`cmd-trigger-reset-transient-${attempt}`),
          triggerId: TRIGGER_ID,
          firedAt: "2026-01-02T00:00:00.000Z",
          outcome: transientOutcome,
        });
        readModel = result.readModel;
      }
      expect(
        readModel.triggers.find((entry) => entry.id === TRIGGER_ID)?.consecutiveTransientFailures,
      ).toBe(3);

      const success = yield* applyCommand(readModel, {
        type: "trigger.fire-settled",
        commandId: asCommandId("cmd-trigger-reset-success"),
        triggerId: TRIGGER_ID,
        firedAt: "2026-01-02T00:00:00.000Z",
        outcome: { status: "succeeded", threadId: ThreadId.make("thread-y") },
      });
      readModel = success.readModel;
      expect(
        readModel.triggers.find((entry) => entry.id === TRIGGER_ID)?.consecutiveTransientFailures,
      ).toBe(0);
    }),
  );
});
