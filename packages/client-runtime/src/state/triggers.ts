import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import {
  type CreateTriggerInput,
  type DeleteTriggerInput,
  type DisableTriggerInput,
  type EnableTriggerInput,
  type UpdateTriggerInput,
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  updateTrigger,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateTriggerInput,
  DeleteTriggerInput,
  DisableTriggerInput,
  EnableTriggerInput,
  UpdateTriggerInput,
} from "../operations/commands.ts";

/**
 * Trigger environment atoms: a project-scoped live list subscription plus the
 * create/update/enable/disable/delete command families.
 *
 * The `list` subscription re-emits the project's full trigger list on every
 * trigger event, so the atom value always holds the current list (last emission
 * wins — no client-side reducer).
 */
export function createTriggerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const triggerScheduler = createAtomCommandScheduler();
  const triggerConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { triggerId: string } }) =>
      JSON.stringify([environmentId, input.triggerId]),
  };
  return {
    list: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:triggers:list",
      tag: ORCHESTRATION_WS_METHODS.subscribeTriggers,
    }),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trigger:create",
      execute: (input: CreateTriggerInput) => createTrigger(input),
      scheduler: triggerScheduler,
      concurrency: triggerConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trigger:update",
      execute: (input: UpdateTriggerInput) => updateTrigger(input),
      scheduler: triggerScheduler,
      concurrency: triggerConcurrency,
    }),
    enable: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trigger:enable",
      execute: (input: EnableTriggerInput) => enableTrigger(input),
      scheduler: triggerScheduler,
      concurrency: triggerConcurrency,
    }),
    disable: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trigger:disable",
      execute: (input: DisableTriggerInput) => disableTrigger(input),
      scheduler: triggerScheduler,
      concurrency: triggerConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:trigger:delete",
      execute: (input: DeleteTriggerInput) => deleteTrigger(input),
      scheduler: triggerScheduler,
      concurrency: triggerConcurrency,
    }),
  };
}
