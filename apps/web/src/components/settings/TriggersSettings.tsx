import { AlarmClockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { OrchestrationTrigger } from "@t3tools/contracts";

import { newTriggerId } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { triggerEnvironment } from "../../state/triggers";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  type AtomLeafForm,
  ATOM_CATALOG,
  buildCreateTriggerInput,
  type ConditionKind,
  describeLastFire,
  describeSchedule,
  emptyAtomLeaf,
  emptyTriggerForm,
  findAtomSpec,
  type ScheduleUnit,
  type TriggerFormValues,
} from "./TriggersSettings.logic";

const EMPTY_TRIGGERS: ReadonlyArray<OrchestrationTrigger> = Object.freeze([]);

const SCHEDULE_UNIT_LABELS: Record<ScheduleUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours",
};

const CONDITION_KIND_LABELS: Record<ConditionKind, string> = {
  schedule: "On a schedule",
  atom: "On an event",
  composite: "On several conditions",
};

const atomKey = (atom: { readonly domain: string; readonly type: string }): string =>
  `${atom.domain}/${atom.type}`;

/**
 * Editor for a single atom leaf: pick an atom type, fill its params, optionally
 * negate a state atom. Shared by the single-atom and composite condition forms.
 */
function AtomLeafEditor({
  leaf,
  onChange,
  idPrefix,
}: {
  readonly leaf: AtomLeafForm;
  readonly onChange: (next: AtomLeafForm) => void;
  readonly idPrefix: string;
}) {
  const spec = findAtomSpec(leaf.domain, leaf.type);
  return (
    <div className="space-y-2 rounded-lg border border-border/50 p-3">
      <Select
        value={atomKey(leaf)}
        onValueChange={(value) => {
          const next = ATOM_CATALOG.find((candidate) => atomKey(candidate) === value);
          if (next === undefined) return;
          onChange({ domain: next.domain, type: next.type, params: {}, negated: false });
        }}
      >
        <SelectTrigger className="w-full" aria-label="Event type">
          <SelectValue>{spec?.label ?? "Choose an event"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {ATOM_CATALOG.map((candidate) => (
            <SelectItem key={atomKey(candidate)} hideIndicator value={atomKey(candidate)}>
              {candidate.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {spec?.params.map((param) => (
        <div key={param.key} className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-${param.key}`}>
            {param.label}
            {param.optional === true ? " (optional)" : ""}
          </Label>
          <Input
            id={`${idPrefix}-${param.key}`}
            type={param.kind === "number" ? "number" : "text"}
            value={leaf.params[param.key] ?? ""}
            placeholder={param.placeholder}
            onChange={(event) =>
              onChange({
                ...leaf,
                params: { ...leaf.params, [param.key]: event.target.value },
              })
            }
          />
        </div>
      ))}
      {spec?.nature === "state" ? (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={leaf.negated}
            onCheckedChange={(next) => onChange({ ...leaf, negated: next })}
            aria-label="Negate this condition"
          />
          Negate (fire when this is not true)
        </label>
      ) : null}
    </div>
  );
}

function projectKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.id}`;
}

export function TriggersSettingsPanel() {
  const projects = useProjects();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const selectedProject = useMemo(() => {
    if (projects.length === 0) return null;
    const found = selectedKey
      ? projects.find((project) => projectKey(project) === selectedKey)
      : null;
    return found ?? projects[0] ?? null;
  }, [projects, selectedKey]);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Triggers" icon={<AlarmClockIcon className="size-5" />}>
        {projects.length === 0 ? (
          <SettingsRow
            title="No projects yet"
            description="Create a project first — triggers are configured per project."
          />
        ) : (
          <>
            <SettingsRow
              title="Project"
              description="Triggers are scoped to a single project. Pick the project to manage."
              control={
                selectedProject ? (
                  <Select
                    value={projectKey(selectedProject)}
                    onValueChange={(value) => setSelectedKey(value)}
                  >
                    <SelectTrigger className="w-full sm:w-64" aria-label="Trigger project">
                      <SelectValue>{selectedProject.title}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {projects.map((project) => (
                        <SelectItem
                          key={projectKey(project)}
                          hideIndicator
                          value={projectKey(project)}
                        >
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null
              }
            />
            {selectedProject ? (
              <TriggerProjectView key={projectKey(selectedProject)} project={selectedProject} />
            ) : null}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function TriggerProjectView({ project }: { project: EnvironmentProject }) {
  const environmentId = project.environmentId;
  const projectId = project.id;

  const query = useEnvironmentQuery(
    triggerEnvironment.list({ environmentId, input: { projectId } }),
  );
  const triggers = query.data?.triggers ?? EMPTY_TRIGGERS;

  const createCommand = useAtomCommand(triggerEnvironment.create, { reportFailure: false });
  const enableCommand = useAtomCommand(triggerEnvironment.enable, { reportFailure: false });
  const disableCommand = useAtomCommand(triggerEnvironment.disable, { reportFailure: false });
  const deleteCommand = useAtomCommand(triggerEnvironment.delete, { reportFailure: false });

  const [form, setForm] = useState<TriggerFormValues>(emptyTriggerForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const patch = (partial: Partial<TriggerFormValues>) =>
    setForm((previous) => ({ ...previous, ...partial }));

  const handleToggleEnabled = (trigger: OrchestrationTrigger, next: boolean) => {
    const command = next ? enableCommand : disableCommand;
    void command({ environmentId, input: { triggerId: trigger.id } });
  };

  const handleDelete = (trigger: OrchestrationTrigger) => {
    void deleteCommand({ environmentId, input: { triggerId: trigger.id } });
  };

  const handleCreate = async () => {
    const built = buildCreateTriggerInput({ triggerId: newTriggerId(), projectId, form });
    if (!built.ok) {
      setFormError(built.error);
      return;
    }
    setFormError(null);
    setIsSubmitting(true);
    const result = await createCommand({ environmentId, input: built.value });
    setIsSubmitting(false);
    if (result._tag === "Failure") {
      setFormError("The trigger could not be created.");
      return;
    }
    setForm(emptyTriggerForm());
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {query.isPending && triggers.length === 0 ? (
          <SettingsRow title="Loading triggers…" description="Fetching this project's triggers." />
        ) : triggers.length === 0 ? (
          <SettingsRow
            title="No triggers"
            description="This project has no triggers yet. Create one below."
          />
        ) : (
          triggers.map((trigger) => {
            const lastFire = describeLastFire(trigger);
            return (
              <SettingsRow
                key={trigger.id}
                title={
                  <span className="flex items-center gap-2">
                    {trigger.name}
                    {!trigger.enabled ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        Disabled
                      </Badge>
                    ) : null}
                  </span>
                }
                description={describeSchedule(trigger.condition)}
                status={
                  <span
                    className={
                      lastFire.status === "failed"
                        ? "text-destructive"
                        : lastFire.status === "succeeded"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : undefined
                    }
                  >
                    {lastFire.label}
                  </span>
                }
                control={
                  <>
                    <Switch
                      checked={trigger.enabled}
                      onCheckedChange={(next) => handleToggleEnabled(trigger, next)}
                      aria-label={trigger.enabled ? "Disable trigger" : "Enable trigger"}
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Delete trigger"
                      onClick={() => handleDelete(trigger)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </>
                }
              />
            );
          })
        )}
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 p-4">
        <h3 className="text-sm font-semibold text-foreground">New trigger</h3>

        <div className="space-y-1.5">
          <Label htmlFor="trigger-name">Name</Label>
          <Input
            id="trigger-name"
            value={form.name}
            placeholder="Nightly checks"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>

        <div className="space-y-2">
          <Label>When to fire</Label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(CONDITION_KIND_LABELS) as ConditionKind[]).map((kind) => (
              <Button
                key={kind}
                type="button"
                size="sm"
                variant={form.conditionKind === kind ? "default" : "outline"}
                onClick={() => patch({ conditionKind: kind })}
              >
                {CONDITION_KIND_LABELS[kind]}
              </Button>
            ))}
          </div>

          {form.conditionKind === "schedule" ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.scheduleKind === "interval" ? "default" : "outline"}
                  onClick={() => patch({ scheduleKind: "interval" })}
                >
                  Every…
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.scheduleKind === "at" ? "default" : "outline"}
                  onClick={() => patch({ scheduleKind: "at" })}
                >
                  At a specific time
                </Button>
              </div>
              {form.scheduleKind === "interval" ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    className="w-24"
                    value={String(form.intervalEvery)}
                    onChange={(event) => patch({ intervalEvery: Number(event.target.value) })}
                    aria-label="Interval value"
                  />
                  <Select
                    value={form.intervalUnit}
                    onValueChange={(value) => patch({ intervalUnit: value as ScheduleUnit })}
                  >
                    <SelectTrigger className="w-40" aria-label="Interval unit">
                      <SelectValue>{SCHEDULE_UNIT_LABELS[form.intervalUnit]}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {(Object.keys(SCHEDULE_UNIT_LABELS) as ScheduleUnit[]).map((unit) => (
                        <SelectItem key={unit} hideIndicator value={unit}>
                          {SCHEDULE_UNIT_LABELS[unit]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : (
                <Input
                  type="datetime-local"
                  className="w-64"
                  value={form.atDateTimeLocal}
                  onChange={(event) => patch({ atDateTimeLocal: event.target.value })}
                  aria-label="Fire date and time"
                />
              )}
            </div>
          ) : form.conditionKind === "atom" ? (
            <AtomLeafEditor
              leaf={form.atom}
              idPrefix="trigger-atom"
              onChange={(next) => patch({ atom: next })}
            />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.compositeOp === "and" ? "default" : "outline"}
                  onClick={() => patch({ compositeOp: "and" })}
                >
                  All (AND)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.compositeOp === "or" ? "default" : "outline"}
                  onClick={() => patch({ compositeOp: "or" })}
                >
                  Any (OR)
                </Button>
              </div>
              {form.leaves.map((leaf, index) => (
                <div key={index} className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Condition {index + 1}</Label>
                    {form.leaves.length > 2 ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Remove condition ${index + 1}`}
                        onClick={() => patch({ leaves: form.leaves.filter((_, i) => i !== index) })}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    ) : null}
                  </div>
                  <AtomLeafEditor
                    leaf={leaf}
                    idPrefix={`trigger-leaf-${index}`}
                    onChange={(next) =>
                      patch({ leaves: form.leaves.map((l, i) => (i === index ? next : l)) })
                    }
                  />
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => patch({ leaves: [...form.leaves, emptyAtomLeaf()] })}
              >
                <PlusIcon className="size-4" />
                Add condition
              </Button>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-window">Window (optional)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="trigger-window"
                      type="number"
                      min={0}
                      className="w-24"
                      value={String(form.windowEvery)}
                      onChange={(event) => patch({ windowEvery: Number(event.target.value) })}
                      aria-label="Window value"
                    />
                    <Select
                      value={form.windowUnit}
                      onValueChange={(value) => patch({ windowUnit: value as ScheduleUnit })}
                    >
                      <SelectTrigger className="w-32" aria-label="Window unit">
                        <SelectValue>{SCHEDULE_UNIT_LABELS[form.windowUnit]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        {(Object.keys(SCHEDULE_UNIT_LABELS) as ScheduleUnit[]).map((unit) => (
                          <SelectItem key={unit} hideIndicator value={unit}>
                            {SCHEDULE_UNIT_LABELS[unit]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trigger-delay">Delay (optional)</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="trigger-delay"
                      type="number"
                      min={0}
                      className="w-24"
                      value={String(form.delayEvery)}
                      onChange={(event) => patch({ delayEvery: Number(event.target.value) })}
                      aria-label="Delay value"
                    />
                    <Select
                      value={form.delayUnit}
                      onValueChange={(value) => patch({ delayUnit: value as ScheduleUnit })}
                    >
                      <SelectTrigger className="w-32" aria-label="Delay unit">
                        <SelectValue>{SCHEDULE_UNIT_LABELS[form.delayUnit]}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        {(Object.keys(SCHEDULE_UNIT_LABELS) as ScheduleUnit[]).map((unit) => (
                          <SelectItem key={unit} hideIndicator value={unit}>
                            {SCHEDULE_UNIT_LABELS[unit]}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="trigger-prompt">Prompt</Label>
          <Textarea
            id="trigger-prompt"
            rows={3}
            value={form.promptText}
            placeholder="What should the started session do?"
            onChange={(event) => patch({ promptText: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The session inherits the project's default model.
          </p>
        </div>

        <SettingsRow
          title="Run in a new worktree"
          description="Off runs in the current worktree; on branches from a base branch."
          control={
            <Switch
              checked={form.worktreeMode === "new"}
              onCheckedChange={(next) => patch({ worktreeMode: next ? "new" : "current" })}
              aria-label="Run in a new worktree"
            />
          }
        />
        {form.worktreeMode === "new" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="trigger-base-branch">Base branch</Label>
              <Input
                id="trigger-base-branch"
                value={form.baseBranch}
                placeholder="main"
                onChange={(event) => patch({ baseBranch: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="trigger-branch">New branch (optional)</Label>
              <Input
                id="trigger-branch"
                value={form.branch}
                placeholder="auto-generated if empty"
                onChange={(event) => patch({ branch: event.target.value })}
              />
            </div>
          </div>
        ) : null}

        <SettingsRow
          title="Enabled"
          description="A disabled trigger is saved but never fires."
          control={
            <Switch
              checked={form.enabled}
              onCheckedChange={(next) => patch({ enabled: next })}
              aria-label="Enable trigger on creation"
            />
          }
        />

        {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

        <div className="flex justify-end">
          <Button type="button" disabled={isSubmitting} onClick={() => void handleCreate()}>
            <PlusIcon className="size-4" />
            Create trigger
          </Button>
        </div>
      </div>
    </div>
  );
}
