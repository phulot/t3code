import type {
  OrchestrationSession,
  OrchestrationSessionStatus,
  SessionId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { memo } from "react";

import { sessionIdOf } from "../ChatView.logic";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SESSION_STATUS_LABEL: Record<OrchestrationSessionStatus, string> = {
  idle: "Idle",
  starting: "Starting",
  running: "Working",
  ready: "Ready",
  interrupted: "Interrupted",
  stopped: "Stopped",
  error: "Error",
};

const SESSION_STATUS_TONE: Record<OrchestrationSessionStatus, string> = {
  idle: "text-muted-foreground",
  starting: "text-amber-600 dark:text-amber-400",
  running: "text-amber-600 dark:text-amber-400",
  ready: "text-emerald-600 dark:text-emerald-400",
  interrupted: "text-muted-foreground",
  stopped: "text-muted-foreground",
  error: "text-destructive",
};

interface SessionTabsProps {
  sessions: ReadonlyArray<OrchestrationSession>;
  activeSessionId: SessionId;
  attentionSessionIds: ReadonlySet<SessionId>;
  onSelectSession: (sessionId: SessionId) => void;
  onCreateSession: () => void;
  createShortcutLabel?: string | undefined;
}

/**
 * One tab per session (chat) hosted by the thread. Each tab shows the session's
 * own literal status; the active tab's chat renders only that session's
 * messages/turns. Rendered only when a thread hosts more than one session, so
 * legacy single-session threads keep their untouched single-view chrome.
 */
export const SessionTabs = memo(function SessionTabs({
  sessions,
  activeSessionId,
  attentionSessionIds,
  onSelectSession,
  onCreateSession,
  createShortcutLabel,
}: SessionTabsProps) {
  return (
    <div
      className="flex min-h-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2 py-1"
      role="tablist"
      aria-label="Thread sessions"
    >
      {sessions.map((session, index) => {
        const sessionId = sessionIdOf(session);
        const isActive = sessionId === activeSessionId;
        const needsAttention = attentionSessionIds.has(sessionId);
        return (
          <button
            key={sessionId}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelectSession(sessionId)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <span>Chat {index + 1}</span>
            {needsAttention ? (
              <span className="size-1.5 rounded-full bg-amber-500" aria-label="Needs attention" />
            ) : null}
            <span className={cn("text-[10px]", SESSION_STATUS_TONE[session.status])}>
              {SESSION_STATUS_LABEL[session.status]}
            </span>
          </button>
        );
      })}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onCreateSession}
              aria-label="New session"
              className="ml-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          New session{createShortcutLabel ? ` (${createShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
