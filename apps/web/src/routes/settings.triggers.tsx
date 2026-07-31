import { createFileRoute } from "@tanstack/react-router";

import { TriggersSettingsPanel } from "../components/settings/TriggersSettings";

function SettingsTriggersRoute() {
  return <TriggersSettingsPanel />;
}

export const Route = createFileRoute("/settings/triggers")({
  component: SettingsTriggersRoute,
});
