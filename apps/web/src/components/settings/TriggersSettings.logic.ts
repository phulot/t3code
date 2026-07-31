import type {
  AtomRef,
  ModelSelection,
  OrchestrationTrigger,
  ProjectId,
  TriggerAction,
  TriggerCondition,
  TriggerId,
  TriggerSessionSpec,
} from "@t3tools/contracts";
import type { CreateTriggerInput } from "@t3tools/client-runtime/state/triggers";

/**
 * Pure form → command mapping and read-model formatting for the triggers
 * settings page. No React, no atoms: everything here is unit-tested in
 * `TriggersSettings.logic.test.ts`.
 */

export type ScheduleUnit = "seconds" | "minutes" | "hours";

const UNIT_MS: Record<ScheduleUnit, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

export type WorktreeMode = "current" | "new";

/**
 * How a trigger's condition is authored in the form: a temporal `schedule`, a
 * single `atom` (an event/state observation), or a `composite` (AND/OR of atom
 * leaves, each optionally negated, with a fixed window and delay).
 */
export type ConditionKind = "schedule" | "atom" | "composite";

/**
 * Client-side mirror of the server atom catalog (`AtomDomainRegistry`). V1 has
 * no discovery RPC, so the known atom types are declared here so the form can
 * render the right params. Kept in lockstep with the server descriptors: any
 * mismatch surfaces as a creation-time validation error, never a silent
 * success.
 */
export interface AtomParamSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: "string" | "number";
  readonly optional?: boolean;
  readonly placeholder?: string;
}

export interface AtomTypeSpec {
  readonly domain: string;
  readonly type: string;
  readonly label: string;
  readonly nature: "state" | "transient";
  readonly params: ReadonlyArray<AtomParamSpec>;
  /** At least one of these param keys must be provided (e.g. pr OR branch). */
  readonly requireOneOf?: ReadonlyArray<string>;
}

export const ATOM_CATALOG: ReadonlyArray<AtomTypeSpec> = [
  {
    domain: "git",
    type: "ref.merged",
    label: "Git ref merged into base",
    nature: "state",
    params: [
      {
        key: "worktreePath",
        label: "Worktree path",
        kind: "string",
        placeholder: "/path/to/worktree",
      },
      { key: "ref", label: "Ref (branch or commit)", kind: "string", placeholder: "feature/x" },
      { key: "base", label: "Base branch", kind: "string", placeholder: "main" },
    ],
  },
  {
    domain: "git",
    type: "pr.merged",
    label: "GitHub pull request merged",
    nature: "transient",
    params: [
      { key: "repo", label: "Repository (owner/name)", kind: "string", placeholder: "acme/app" },
      { key: "pr", label: "PR number", kind: "number", optional: true, placeholder: "123" },
      {
        key: "branch",
        label: "Head branch",
        kind: "string",
        optional: true,
        placeholder: "feature/x",
      },
    ],
    requireOneOf: ["pr", "branch"],
  },
];

export function findAtomSpec(domain: string, type: string): AtomTypeSpec | undefined {
  return ATOM_CATALOG.find((spec) => spec.domain === domain && spec.type === type);
}

/**
 * One atom leaf as authored in the form: a chosen atom type, its raw string
 * param inputs (keyed by param key), and whether it is negated (NOT). NOT is
 * only valid on a `state` atom (mirrors the server rule).
 */
export interface AtomLeafForm {
  readonly domain: string;
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
  readonly negated: boolean;
}

export function emptyAtomLeaf(): AtomLeafForm {
  const first = ATOM_CATALOG[0];
  return {
    domain: first?.domain ?? "git",
    type: first?.type ?? "ref.merged",
    params: {},
    negated: false,
  };
}

/**
 * The flattened shape of the V1 create form. `atDateTimeLocal` is the raw value
 * of an `<input type="datetime-local">` (local wall-clock, no timezone), parsed
 * to an epoch-ms timestamp.
 */
export interface TriggerFormValues {
  readonly name: string;
  readonly conditionKind: ConditionKind;
  readonly scheduleKind: "interval" | "at";
  readonly intervalEvery: number;
  readonly intervalUnit: ScheduleUnit;
  readonly atDateTimeLocal: string;
  // Single-atom condition (conditionKind === "atom").
  readonly atom: AtomLeafForm;
  // Composite condition (conditionKind === "composite").
  readonly compositeOp: "and" | "or";
  readonly leaves: ReadonlyArray<AtomLeafForm>;
  // Fixed window/delay for a composite (D20). `0` (or blank) means unset.
  readonly windowEvery: number;
  readonly windowUnit: ScheduleUnit;
  readonly delayEvery: number;
  readonly delayUnit: ScheduleUnit;
  readonly promptText: string;
  readonly modelSelection: ModelSelection | null;
  readonly worktreeMode: WorktreeMode;
  readonly baseBranch: string;
  readonly branch: string;
  readonly enabled: boolean;
}

export type BuildResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export function emptyTriggerForm(): TriggerFormValues {
  return {
    name: "",
    conditionKind: "schedule",
    scheduleKind: "interval",
    intervalEvery: 30,
    intervalUnit: "minutes",
    atDateTimeLocal: "",
    atom: emptyAtomLeaf(),
    compositeOp: "and",
    leaves: [emptyAtomLeaf(), emptyAtomLeaf()],
    windowEvery: 0,
    windowUnit: "minutes",
    delayEvery: 0,
    delayUnit: "minutes",
    promptText: "",
    modelSelection: null,
    worktreeMode: "current",
    baseBranch: "main",
    branch: "",
    enabled: true,
  };
}

/**
 * Map an atom leaf's raw string params to a validated {@link AtomRef}. Trims
 * every value, enforces required params, coerces `number` params, and applies
 * the `requireOneOf` rule.
 */
export function buildAtomRef(leaf: AtomLeafForm): BuildResult<AtomRef> {
  const spec = findAtomSpec(leaf.domain, leaf.type);
  if (spec === undefined) {
    return { ok: false, error: "Choose a condition type." };
  }
  const params: Record<string, unknown> = {};
  for (const param of spec.params) {
    const raw = (leaf.params[param.key] ?? "").trim();
    if (raw.length === 0) {
      if (param.optional === true) {
        continue;
      }
      return { ok: false, error: `${param.label} is required.` };
    }
    if (param.kind === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return { ok: false, error: `${param.label} must be a number.` };
      }
      params[param.key] = value;
    } else {
      params[param.key] = raw;
    }
  }
  if (spec.requireOneOf !== undefined && !spec.requireOneOf.some((key) => key in params)) {
    return {
      ok: false,
      error: `Provide at least one of: ${spec.requireOneOf.join(", ")}.`,
    };
  }
  return { ok: true, value: { domain: spec.domain, type: spec.type, params } };
}

/**
 * Map an atom leaf to a {@link TriggerCondition}, wrapping in `not` when negated.
 * NOT is rejected on a non-state atom (mirrors the server invariant).
 */
export function buildAtomLeafCondition(leaf: AtomLeafForm): BuildResult<TriggerCondition> {
  const spec = findAtomSpec(leaf.domain, leaf.type);
  if (spec === undefined) {
    return { ok: false, error: "Choose a condition type." };
  }
  const ref = buildAtomRef(leaf);
  if (!ref.ok) {
    return ref;
  }
  const atomCondition: TriggerCondition = { kind: "atom", atom: ref.value };
  if (!leaf.negated) {
    return { ok: true, value: atomCondition };
  }
  if (spec.nature !== "state") {
    return { ok: false, error: "NOT can only be applied to a state condition." };
  }
  return { ok: true, value: { kind: "not", condition: atomCondition } };
}

/**
 * Map the composite portion of the form to an `and`/`or` {@link TriggerCondition}
 * over its atom leaves. Requires at least two leaves.
 */
export function buildCompositeCondition(form: TriggerFormValues): BuildResult<TriggerCondition> {
  if (form.leaves.length < 2) {
    return { ok: false, error: "A composite condition needs at least two conditions." };
  }
  const conditions: TriggerCondition[] = [];
  for (const leaf of form.leaves) {
    const condition = buildAtomLeafCondition(leaf);
    if (!condition.ok) {
      return condition;
    }
    conditions.push(condition.value);
  }
  return { ok: true, value: { kind: form.compositeOp, conditions } };
}

/**
 * Convert a duration value+unit to milliseconds, or `undefined` when unset
 * (blank/non-positive). Used for the optional composite window/delay.
 */
export function optionalDurationMs(value: number, unit: ScheduleUnit): number | undefined {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value * UNIT_MS[unit]);
}

/**
 * Map the schedule portion of the form to a {@link TriggerCondition}. An
 * interval of N minutes becomes `everyMs = N * 60_000`; an `at` datetime becomes
 * an epoch-ms `timestamp`.
 */
export function buildTriggerCondition(form: TriggerFormValues): BuildResult<TriggerCondition> {
  if (form.conditionKind === "atom") {
    return buildAtomLeafCondition(form.atom);
  }
  if (form.conditionKind === "composite") {
    return buildCompositeCondition(form);
  }
  if (form.scheduleKind === "interval") {
    if (!Number.isFinite(form.intervalEvery) || form.intervalEvery <= 0) {
      return { ok: false, error: "Interval must be greater than zero." };
    }
    const everyMs = Math.round(form.intervalEvery * UNIT_MS[form.intervalUnit]);
    if (everyMs <= 0) {
      return { ok: false, error: "Interval must be greater than zero." };
    }
    return { ok: true, value: { kind: "temporal", schedule: { kind: "interval", everyMs } } };
  }
  const timestamp = Date.parse(form.atDateTimeLocal);
  if (Number.isNaN(timestamp)) {
    return { ok: false, error: "Enter a valid date and time." };
  }
  return { ok: true, value: { kind: "temporal", schedule: { kind: "at", timestamp } } };
}

/**
 * Map the action portion of the form to a `startSession` {@link TriggerAction}.
 */
export function buildTriggerAction(form: TriggerFormValues): BuildResult<TriggerAction> {
  const text = form.promptText.trim();
  if (text.length === 0) {
    return { ok: false, error: "Prompt text is required." };
  }
  const spec: TriggerSessionSpec = {
    text,
    ...(form.modelSelection === null ? {} : { modelSelection: form.modelSelection }),
  };
  if (form.worktreeMode === "new") {
    const baseBranch = form.baseBranch.trim();
    if (baseBranch.length === 0) {
      return { ok: false, error: "Base branch is required for a new worktree." };
    }
    const branch = form.branch.trim();
    return {
      ok: true,
      value: {
        kind: "startSession",
        spec: {
          ...spec,
          prepareWorktree: { baseBranch, ...(branch.length === 0 ? {} : { branch }) },
        },
      },
    };
  }
  return { ok: true, value: { kind: "startSession", spec } };
}

/**
 * Build the full `trigger.create` command input from the form. Validates name,
 * schedule and action, returning the first error encountered.
 */
export function buildCreateTriggerInput(params: {
  readonly triggerId: TriggerId;
  readonly projectId: ProjectId;
  readonly form: TriggerFormValues;
}): BuildResult<CreateTriggerInput> {
  const name = params.form.name.trim();
  if (name.length === 0) {
    return { ok: false, error: "Name is required." };
  }
  const condition = buildTriggerCondition(params.form);
  if (!condition.ok) {
    return condition;
  }
  const action = buildTriggerAction(params.form);
  if (!action.ok) {
    return action;
  }
  // Window/delay are only meaningful for a composite condition (D20); ignored
  // otherwise so a schedule/atom trigger never carries a stray bound.
  const windowMs =
    params.form.conditionKind === "composite"
      ? optionalDurationMs(params.form.windowEvery, params.form.windowUnit)
      : undefined;
  const delayMs =
    params.form.conditionKind === "composite"
      ? optionalDurationMs(params.form.delayEvery, params.form.delayUnit)
      : undefined;
  return {
    ok: true,
    value: {
      triggerId: params.triggerId,
      projectId: params.projectId,
      name,
      condition: condition.value,
      action: action.value,
      enabled: params.form.enabled,
      ...(windowMs === undefined ? {} : { windowMs }),
      ...(delayMs === undefined ? {} : { delayMs }),
    },
  };
}

export type LastFireStatus = "never" | "succeeded" | "failed";

export interface LastFireDescription {
  readonly status: LastFireStatus;
  readonly label: string;
}

/**
 * Human-readable summary of a trigger's most recent fire outcome.
 */
export function describeLastFire(
  trigger: Pick<OrchestrationTrigger, "lastFiredAt" | "lastOutcome">,
): LastFireDescription {
  if (trigger.lastFiredAt === null || trigger.lastOutcome === null) {
    return { status: "never", label: "Never fired" };
  }
  if (trigger.lastOutcome.status === "succeeded") {
    return { status: "succeeded", label: "Last run succeeded" };
  }
  return {
    status: "failed",
    label: `Last run failed (${trigger.lastOutcome.failureKind}): ${trigger.lastOutcome.reason}`,
  };
}

/**
 * Short description of a trigger's schedule for the list row.
 */
export function describeSchedule(condition: TriggerCondition): string {
  if (condition.kind === "atom") {
    return `When ${condition.atom.domain}/${condition.atom.type}`;
  }
  if (condition.kind === "not") {
    return `Not (${describeSchedule(condition.condition)})`;
  }
  if (condition.kind === "and" || condition.kind === "or") {
    const joiner = condition.kind === "and" ? " and " : " or ";
    return condition.conditions.map(describeSchedule).join(joiner);
  }
  const schedule = condition.schedule;
  if (schedule.kind === "interval") {
    return `Every ${formatDuration(schedule.everyMs)}`;
  }
  return `Once at ${new Date(schedule.timestamp).toLocaleString()}`;
}

function formatDuration(everyMs: number): string {
  if (everyMs % UNIT_MS.hours === 0) {
    const hours = everyMs / UNIT_MS.hours;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (everyMs % UNIT_MS.minutes === 0) {
    const minutes = everyMs / UNIT_MS.minutes;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = Math.round(everyMs / UNIT_MS.seconds);
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}
