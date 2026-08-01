import { useRoute, type RouteProp } from "@react-navigation/native";
import { useMemo, useRef } from "react";
import {
  EnvironmentId,
  type OrchestrationSession,
  type OrchestrationThread,
  type SessionId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";

import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import {
  resolveActiveSessionId,
  resolveThreadSessions,
  sessionIdOf,
} from "../features/threads/threadPresentation";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";
type ThreadSelectionRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
  readonly sessionId?: string | string[];
};

const EMPTY_SESSIONS: ReadonlyArray<OrchestrationSession> = [];

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function latestUserMessageAt(thread: OrchestrationThread): OrchestrationThread["updatedAt"] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

function threadDetailToShell(
  environmentId: EnvironmentId,
  thread: OrchestrationThread,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    session: thread.session,
    latestUserMessageAt: latestUserMessageAt(thread),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function useResolvedThreadSelection(params: ThreadSelectionRouteParams | undefined) {
  const routeParams = params ?? {};
  const routeThreadRef = useMemo<ScopedThreadRef | null>(() => {
    const environmentId = firstRouteParam(routeParams.environmentId);
    const threadId = firstRouteParam(routeParams.threadId);
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  }, [routeParams.environmentId, routeParams.threadId]);
  const lastRouteThreadRef = useRef<ScopedThreadRef | null>(null);
  if (routeThreadRef !== null) {
    lastRouteThreadRef.current = routeThreadRef;
  }
  const selectedThreadRef = routeThreadRef ?? lastRouteThreadRef.current;
  const selectedThreadShell = useThreadShell(selectedThreadRef);
  const selectedThreadDetailState = useEnvironmentThread(
    selectedThreadRef?.environmentId ?? null,
    selectedThreadRef?.threadId ?? null,
  );
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const selectedThread = useMemo(
    () =>
      selectedThreadShell ??
      (selectedThreadRef !== null && selectedThreadDetail !== null
        ? threadDetailToShell(selectedThreadRef.environmentId, selectedThreadDetail)
        : null),
    [selectedThreadDetail, selectedThreadRef, selectedThreadShell],
  );
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(
    () =>
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            projectId: selectedThread.projectId,
          },
    [selectedThread],
  );
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  // Sessions (chats) hosted by this thread come from the full detail (the shell
  // has only the scalar `session`, no `sessions[]`). Legacy single-session
  // threads synthesize one default entry so their chrome stays untouched.
  const sessions = useMemo(
    () => (selectedThreadDetail ? resolveThreadSessions(selectedThreadDetail) : EMPTY_SESSIONS),
    [selectedThreadDetail],
  );
  const requestedSessionId = firstRouteParam(routeParams.sessionId);
  const sessionIdKey = sessions.map((session) => sessionIdOf(session)).join("|");
  const activeSessionId = useMemo<SessionId>(
    () => resolveActiveSessionId(sessions, requestedSessionId),
    // sessionIdKey stands in for the sessions list identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestedSessionId, sessionIdKey],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => sessionIdOf(session) === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  return useMemo(
    () => ({
      selectedThreadRef,
      selectedThread,
      selectedThreadProject,
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      sessions,
      activeSessionId,
      activeSession,
    }),
    [
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      selectedThread,
      selectedThreadProject,
      selectedThreadRef,
      sessions,
      activeSessionId,
      activeSession,
    ],
  );
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

export function useThreadSelection(): ThreadSelectionState {
  const route = useRoute<RouteProp<Record<string, ThreadSelectionRouteParams | undefined>>>();
  return useResolvedThreadSelection(route.params);
}
