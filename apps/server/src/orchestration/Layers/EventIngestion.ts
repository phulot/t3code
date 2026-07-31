/**
 * EventIngestionLive - External-event ingestion implementation.
 *
 * Journals a normalized fact idempotently, then (only for a fresh fact) narrows
 * to the ACTIVE atom triggers of the fact's `(domain, type)`, keeps those whose
 * TRANSIENT atom {@link matchesAtom matches} the fact, and fires each through the
 * shared {@link makeTriggerFiring} pipeline — the exact same pipeline the
 * temporal scheduler and condition evaluator use, so the 60s anti-rebound and
 * per-trigger failure isolation apply here too.
 *
 * `matchesAtom` returns `false` for a STATE atom (it has no `matches`), so the
 * per-`(domain, type)` candidate list is safely filtered to genuine transient
 * matches without a separate nature check.
 *
 * @module EventIngestionLive
 */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ExternalEventJournal } from "../../persistence/Services/ExternalEventJournal.ts";
import { ProjectionTriggerRepository } from "../../persistence/Services/ProjectionTriggers.ts";
import { matchesAtom } from "../Services/AtomDomainRegistry.ts";
import { EventIngestion, type EventIngestionShape } from "../Services/EventIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../Services/SessionLauncher.ts";
import { makeTriggerFiring } from "./TriggerFiring.ts";

const make = Effect.gen(function* () {
  const journal = yield* ExternalEventJournal;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sessionLauncher = yield* SessionLauncherService;
  const triggerRepository = yield* ProjectionTriggerRepository;
  const projectRepository = yield* ProjectionProjectRepository;
  const crypto = yield* Crypto.Crypto;

  const { fireTriggerSafely } = makeTriggerFiring({
    orchestrationEngine,
    sessionLauncher,
    projectRepository,
    crypto,
    commandNamespace: "event-ingestion",
  });

  const ingest: EventIngestionShape["ingest"] = (fact) =>
    Effect.gen(function* () {
      const { inserted } = yield* journal.record(fact);
      if (!inserted) {
        return { inserted: false, fired: 0 };
      }

      const candidates = yield* triggerRepository.listActiveAtomsForType({
        domain: fact.domain,
        type: fact.type,
      });

      const matchFact = { domain: fact.domain, type: fact.type, params: fact.params };
      const matched = candidates.filter(
        (trigger) =>
          trigger.condition.kind === "atom" && matchesAtom(trigger.condition.atom, matchFact),
      );

      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(matched, (trigger) => fireTriggerSafely(trigger, now), {
        discard: true,
      });

      return { inserted: true, fired: matched.length };
    });

  return {
    ingest,
  } satisfies EventIngestionShape;
});

export const EventIngestionLive = Layer.effect(EventIngestion, make);
