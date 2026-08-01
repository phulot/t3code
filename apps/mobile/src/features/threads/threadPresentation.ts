import type { StatusTone } from "../../components/StatusPill";
import {
  DEFAULT_SESSION_ID,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type SessionId,
} from "@t3tools/contracts";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Per-session tab labels — mirror web `SESSION_STATUS_LABEL` in SessionTabs.tsx. */
export const SESSION_STATUS_LABEL: Record<OrchestrationSessionStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Working",
  ready: "Ready",
  interrupted: "Interrupted",
  stopped: "Stopped",
  error: "Error",
};

const SESSION_TONE_NEUTRAL = {
  pillClassName: "bg-neutral-500/12 dark:bg-neutral-500/16",
  textClassName: "text-neutral-600 dark:text-neutral-300",
} as const;
const SESSION_TONE_AMBER = {
  pillClassName: "bg-amber-500/12 dark:bg-amber-500/16",
  textClassName: "text-amber-700 dark:text-amber-300",
} as const;
const SESSION_TONE_EMERALD = {
  pillClassName: "bg-emerald-500/12 dark:bg-emerald-500/16",
  textClassName: "text-emerald-700 dark:text-emerald-300",
} as const;
const SESSION_TONE_ROSE = {
  pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
  textClassName: "text-rose-700 dark:text-rose-300",
} as const;

/** Per-session pill tone — mirror web `SESSION_STATUS_TONE`. */
export const SESSION_STATUS_TONE: Record<
  OrchestrationSessionStatus,
  { readonly pillClassName: string; readonly textClassName: string }
> = {
  idle: SESSION_TONE_NEUTRAL,
  starting: SESSION_TONE_AMBER,
  running: SESSION_TONE_AMBER,
  ready: SESSION_TONE_EMERALD,
  interrupted: SESSION_TONE_NEUTRAL,
  stopped: SESSION_TONE_NEUTRAL,
  error: SESSION_TONE_ROSE,
};

/** Full StatusTone (label + classes) for a session pill. */
export function sessionStatusTone(status: OrchestrationSessionStatus): StatusTone {
  return {
    label: SESSION_STATUS_LABEL[status],
    ...SESSION_STATUS_TONE[status],
  };
}

export function sessionIdOf(session: Pick<OrchestrationSession, "sessionId">): SessionId {
  return session.sessionId ?? DEFAULT_SESSION_ID;
}

/**
 * Ordered session list for a thread. `sessions` is the multi-session source of
 * truth; a legacy thread that only carries the scalar `session` synthesizes a
 * single default entry so it renders one seamless tab. Mirrors web
 * `resolveThreadSessions`.
 */
export function resolveThreadSessions(
  thread: Pick<OrchestrationThread, "sessions" | "session"> | null | undefined,
): ReadonlyArray<OrchestrationSession> {
  if (!thread) return [];
  if (thread.sessions && thread.sessions.length > 0) return thread.sessions;
  if (thread.session) return [thread.session];
  return [];
}

/**
 * Resolve the active session id: the requested id when it exists in the list,
 * else the first session's id, else the default. Mirrors web `activeSessionId`.
 */
export function resolveActiveSessionId(
  sessions: ReadonlyArray<OrchestrationSession>,
  requestedSessionId: string | null,
): SessionId {
  const sessionIds = sessions.map((session) => sessionIdOf(session));
  if (requestedSessionId && sessionIds.includes(requestedSessionId as SessionId)) {
    return requestedSessionId as SessionId;
  }
  return sessionIds[0] ?? DEFAULT_SESSION_ID;
}

/**
 * Narrow a thread's messages to a single session for feed rendering. Legacy
 * single-session threads (0 or 1 session) are returned unchanged so their feed
 * is byte-for-byte identical. Mirrors web `scopeThreadToSession` (messages
 * only). Messages with no `sessionId` belong to the default session.
 */
export function scopeThreadDetailToSession(
  thread: OrchestrationThread,
  sessionId: SessionId,
): OrchestrationThread {
  const sessions = thread.sessions;
  if (!sessions || sessions.length <= 1) {
    return thread;
  }
  const target = sessions.find((session) => sessionIdOf(session) === sessionId) ?? sessions[0];
  if (!target) {
    return thread;
  }
  const targetId = sessionIdOf(target);
  const defaultId = thread.session ? sessionIdOf(thread.session) : DEFAULT_SESSION_ID;
  const isDefault = targetId === defaultId;
  return {
    ...thread,
    messages: thread.messages.filter(
      (message) => (message.sessionId ?? DEFAULT_SESSION_ID) === targetId,
    ),
    session: target,
    latestTurn: isDefault ? thread.latestTurn : (target.latestTurn ?? null),
  };
}

export function threadSortValue(thread: EnvironmentThreadShell): number {
  const candidate = Date.parse(thread.updatedAt ?? thread.createdAt);
  return Number.isNaN(candidate) ? 0 : candidate;
}

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

/** Neutral icon colors for threads with no actionable status. */
export const THREAD_STATUS_NEUTRAL_ICON = {
  iconColor: "#8e8e93",
  iconBackground: "rgba(142,142,147,0.22)",
} as const;

function isLatestTurnSettled(
  latestTurn: OrchestrationLatestTurn | null,
  session: OrchestrationSession | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  return session.status !== "running";
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  if (thread.hasPendingApprovals) {
    return {
      kind: "pending-approval",
      label: "Needs Approval",
      pillClassName: "bg-amber-500/12 dark:bg-amber-500/16",
      textClassName: "text-amber-700 dark:text-amber-300",
      iconColor: "#ff9f0a",
      iconBackground: "rgba(255,159,10,0.22)",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      kind: "awaiting-input",
      label: "Awaiting Input",
      pillClassName: "bg-indigo-500/12 dark:bg-indigo-500/16",
      textClassName: "text-indigo-700 dark:text-indigo-300",
      iconColor: "#5e5ce6",
      iconBackground: "rgba(94,92,230,0.22)",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      kind: "working",
      label: "Working",
      pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
      textClassName: "text-sky-700 dark:text-sky-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "starting") {
    return {
      kind: "connecting",
      label: "Connecting",
      pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
      textClassName: "text-sky-700 dark:text-sky-300",
      iconColor: "#0a84ff",
      iconBackground: "rgba(10,132,255,0.22)",
      pulse: true,
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
      textClassName: "text-rose-700 dark:text-rose-300",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      kind: "plan-ready",
      label: "Plan Ready",
      pillClassName: "bg-violet-500/12 dark:bg-violet-500/16",
      textClassName: "text-violet-700 dark:text-violet-300",
      iconColor: "#bf5af2",
      iconBackground: "rgba(191,90,242,0.22)",
      pulse: false,
    };
  }

  return null;
}
