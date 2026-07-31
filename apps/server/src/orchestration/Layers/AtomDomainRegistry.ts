/**
 * AtomDomainRegistryLive - Catalog-backed atom registry.
 *
 * Wraps the pure atom catalog with the {@link VcsProcess} runner that STATE
 * atoms need to actually evaluate (e.g. the `git/ref.merged` ancestry check).
 * Validation delegates to the pure {@link validateAtom} helper so the catalog
 * stays the single source of truth shared with the orchestration engine.
 *
 * @module AtomDomainRegistryLive
 */
import type { AtomRef } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import {
  AtomDomainRegistry,
  type AtomDomainRegistryShape,
  AtomEvaluationError,
  AtomUnknownTypeError,
  lookupAtomDescriptor,
  validateAtom,
} from "../Services/AtomDomainRegistry.ts";

const make = Effect.gen(function* () {
  const vcs = yield* VcsProcess;

  const validate: AtomDomainRegistryShape["validate"] = (atom) => validateAtom(atom);

  const natureOf: AtomDomainRegistryShape["natureOf"] = (atom) =>
    Option.match(lookupAtomDescriptor(atom), {
      onNone: () => Effect.fail(new AtomUnknownTypeError(atom)),
      onSome: (descriptor) => Effect.succeed(descriptor.nature),
    });

  const evaluate: AtomDomainRegistryShape["evaluate"] = (atom: AtomRef) =>
    Option.match(lookupAtomDescriptor(atom), {
      onNone: () => Effect.fail(new AtomUnknownTypeError(atom)),
      onSome: (descriptor) =>
        descriptor.evaluate === undefined
          ? Effect.fail(
              new AtomEvaluationError(
                `Atom '${atom.domain}/${atom.type}' is not evaluable by polling (nature '${descriptor.nature}').`,
              ),
            )
          : // The VcsProcess dependency is satisfied here so the service method
            // stays dependency-free for its callers.
            descriptor.evaluate(atom.params).pipe(Effect.provideService(VcsProcess, vcs)),
    });

  return {
    validate,
    natureOf,
    evaluate,
  } satisfies AtomDomainRegistryShape;
});

export const AtomDomainRegistryLive = Layer.effect(AtomDomainRegistry, make);
