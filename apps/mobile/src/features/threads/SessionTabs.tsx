import type { OrchestrationSession, SessionId } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { StatusPill } from "../../components/StatusPill";
import { cn } from "../../lib/cn";
import { sessionIdOf, sessionStatusTone } from "./threadPresentation";

interface SessionTabsProps {
  readonly sessions: ReadonlyArray<OrchestrationSession>;
  readonly activeSessionId: SessionId;
  readonly onSelectSession: (sessionId: SessionId) => void;
  readonly onCreateSession: () => void;
}

/**
 * One tab per session (chat) hosted by the thread. Each tab shows the session's
 * own literal status; the active tab's chat renders only that session's
 * messages/turns. Rendered only when a thread hosts more than one session, so
 * legacy single-session threads keep their untouched single-view chrome.
 * Mirrors the web SessionTabs component.
 */
export const SessionTabs = memo(function SessionTabs({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
}: SessionTabsProps) {
  return (
    <View className="border-b border-border bg-screen">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 6,
        }}
      >
        {sessions.map((session, index) => {
          const sessionId = sessionIdOf(session);
          const isActive = sessionId === activeSessionId;
          return (
            <Pressable
              key={sessionId}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              onPress={() => onSelectSession(sessionId)}
              className={cn(
                "flex-row items-center gap-2 rounded-lg px-3 py-1.5",
                isActive ? "bg-neutral-500/16" : "bg-transparent",
              )}
            >
              <Text
                className={cn(
                  "font-t3-bold text-xs",
                  isActive ? "text-primary-text" : "text-secondary-text",
                )}
              >
                Chat {index + 1}
              </Text>
              <StatusPill size="compact" {...sessionStatusTone(session.status)} />
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New session"
          onPress={onCreateSession}
          className="size-7 items-center justify-center rounded-lg bg-neutral-500/12"
        >
          <SymbolView name="plus" size={16} tintColor="#8e8e93" type="monochrome" />
        </Pressable>
      </ScrollView>
    </View>
  );
});
