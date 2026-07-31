import { createTriggerEnvironmentAtoms } from "@t3tools/client-runtime/state/triggers";

import { connectionAtomRuntime } from "../connection/runtime";

export const triggerEnvironment = createTriggerEnvironmentAtoms(connectionAtomRuntime);
