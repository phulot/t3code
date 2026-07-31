/**
 * AtomDomainRegistry - Catalog of atom types, indexed by `(domain, type)`.
 *
 * An atom is a named, parameterized observation about the world. Each atom
 * `type` within a `domain` is described by a descriptor that knows:
 * - its {@link AtomNature} — `"state"` (a boolean predicate re-evaluable at any
 *   time, driven by polling) or `"transient"` (a fact pushed by an external
 *   event such as a webhook, evaluated out-of-band),
 * - how to `validate` its params at trigger-creation time,
 * - how to `evaluate` its params into a boolean (STATE atoms only).
 *
 * The catalog itself is pure data: {@link validateAtom} and
 * {@link lookupAtomDescriptor} require no services, so trigger-creation
 * validation can run inside the (dependency-light) orchestration engine without
 * pulling in git tooling. The {@link AtomDomainRegistry} service wraps the same
 * catalog with the git runner needed to actually evaluate STATE atoms; it is
 * the injectable/stubbable surface consumed by the condition evaluator.
 *
 * @module AtomDomainRegistry
 */
import { AtomRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { VcsProcess } from "../../vcs/VcsProcess.ts";

/** Whether an atom is polled (`state`) or pushed by an external event. */
export type AtomNature = "state" | "transient";

/**
 * A normalized external fact, as consumed by a TRANSIENT atom's
 * {@link AtomDescriptor.matches}. Structurally compatible with the persistence
 * `ExternalEventFact`; declared here so the pure catalog stays free of a
 * persistence import.
 */
export interface ExternalEventMatchFact {
  readonly domain: string;
  readonly type: string;
  readonly params: Record<string, unknown>;
}

/**
 * Raised when no descriptor is registered for an atom's `(domain, type)`.
 */
export class AtomUnknownTypeError {
  readonly _tag = "AtomUnknownTypeError";
  readonly message: string;
  constructor(atom: AtomRef) {
    this.message = `Unknown atom type '${atom.domain}/${atom.type}'.`;
  }
}

/**
 * Raised when an atom's params fail the descriptor's validation (bad shape or a
 * failed minimal-access check). Surfaced to the caller creating the trigger.
 */
export class AtomValidationError {
  readonly _tag = "AtomValidationError";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Raised when a STATE atom cannot be evaluated (e.g. the git command failed).
 * Per Decision D18 this is treated as *domain health*, never a trigger-action
 * failure: it is logged and does not count toward auto-disable.
 */
export class AtomEvaluationError {
  readonly _tag = "AtomEvaluationError";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * Descriptor for one atom `type` inside a domain.
 */
export interface AtomDescriptor {
  readonly nature: AtomNature;
  /** Validate params at creation time. Pure: no runtime services required. */
  readonly validate: (params: Record<string, unknown>) => Effect.Effect<void, AtomValidationError>;
  /**
   * Evaluate params into a boolean. Required for STATE atoms; TRANSIENT atoms
   * are never polled (they are pushed) and omit it.
   */
  readonly evaluate?: (
    params: Record<string, unknown>,
  ) => Effect.Effect<boolean, AtomEvaluationError, VcsProcess>;
  /**
   * Decide whether an external fact corresponds to this concrete atom. Required
   * for TRANSIENT atoms (there is nothing to poll — a matching fact *is* the
   * rising edge); STATE atoms omit it. Pure: no runtime services.
   */
  readonly matches?: (params: Record<string, unknown>, fact: ExternalEventMatchFact) => boolean;
}

// ---------------------------------------------------------------------------
// git domain
// ---------------------------------------------------------------------------

/**
 * Params of the `git/ref.merged` STATE atom: is `ref` an ancestor of `base`
 * (i.e. has `ref` been merged into `base`) in the repository at `worktreePath`.
 */
const GitRefMergedParams = Schema.Struct({
  worktreePath: Schema.NonEmptyString,
  ref: Schema.NonEmptyString,
  base: Schema.NonEmptyString,
});

const decodeGitRefMergedParams = Schema.decodeUnknownEffect(GitRefMergedParams);

/**
 * `git/ref.merged` — a pure-ancestry STATE atom. "base contains ref" is decided
 * by `git merge-base --is-ancestor <ref> <base>`, whose exit code is the whole
 * answer (0 = ancestor/merged, 1 = not, other = error). No network, no host
 * git service state — just the local repository at `worktreePath`.
 *
 * NOTE: the GitHub-flavoured `git/pr.merged` is a TRANSIENT atom (a PR-merged
 * fact is pushed by a webhook, not polled) and is intentionally deferred to
 * increment 3b; only the pure-ancestry STATE atom ships here.
 */
const gitRefMerged: AtomDescriptor = {
  nature: "state",
  validate: (params) =>
    decodeGitRefMergedParams(params).pipe(
      Effect.asVoid,
      Effect.mapError(
        (error) => new AtomValidationError(`Invalid 'git/ref.merged' params: ${error.message}`),
      ),
    ),
  evaluate: (params) =>
    Effect.gen(function* () {
      const decoded = yield* decodeGitRefMergedParams(params).pipe(
        Effect.mapError(
          (error) => new AtomEvaluationError(`Invalid 'git/ref.merged' params: ${error.message}`),
        ),
      );
      const vcs = yield* VcsProcess;
      const output = yield* vcs
        .run({
          operation: "atom.git.ref.merged",
          command: "git",
          args: ["merge-base", "--is-ancestor", decoded.ref, decoded.base],
          cwd: decoded.worktreePath,
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new AtomEvaluationError(
                `git merge-base --is-ancestor failed for '${decoded.ref}'..'${decoded.base}': ${error.message}`,
              ),
          ),
        );
      // --is-ancestor: 0 = ref is an ancestor of base (merged), 1 = it is not,
      // anything else = a real error (bad ref, not a repo, ...).
      if (output.exitCode === 0) {
        return true;
      }
      if (output.exitCode === 1) {
        return false;
      }
      return yield* Effect.fail(
        new AtomEvaluationError(
          `git merge-base --is-ancestor exited with ${String(output.exitCode)} for '${decoded.ref}'..'${decoded.base}': ${output.stderr.trim()}`,
        ),
      );
    }),
};

/**
 * Params of the `git/pr.merged` TRANSIENT atom: a specific GitHub pull request
 * merged into `repo`, identified by its `pr` number and/or its `branch` (the PR
 * head ref). At least one of `pr`/`branch` must be given so the atom points at a
 * concrete PR rather than "any merge".
 */
const GitPrMergedParams = Schema.Struct({
  repo: Schema.NonEmptyString,
  pr: Schema.optional(Schema.Number),
  branch: Schema.optional(Schema.NonEmptyString),
});

const decodeGitPrMergedParams = Schema.decodeUnknownEffect(GitPrMergedParams);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * `git/pr.merged` — a GitHub "pull request closed & merged" TRANSIENT atom. It
 * is never polled: it fires when a matching normalized webhook fact is
 * journalled. `matches` compares the concrete atom params against the fact's
 * params: `repo` (case-insensitive — GitHub repos are), plus each specified
 * identifier (`pr` and/or `branch`) must equal the fact's.
 */
const gitPrMerged: AtomDescriptor = {
  nature: "transient",
  validate: (params) =>
    decodeGitPrMergedParams(params).pipe(
      Effect.mapError(
        (error) => new AtomValidationError(`Invalid 'git/pr.merged' params: ${error.message}`),
      ),
      Effect.flatMap((decoded) =>
        decoded.pr === undefined && decoded.branch === undefined
          ? Effect.fail(
              new AtomValidationError(
                "'git/pr.merged' params must include at least one of 'pr' or 'branch'.",
              ),
            )
          : Effect.void,
      ),
    ),
  matches: (params, fact) => {
    const repo = asString(params.repo);
    const factRepo = asString(fact.params.repo);
    if (repo === undefined || factRepo === undefined) {
      return false;
    }
    if (repo.toLowerCase() !== factRepo.toLowerCase()) {
      return false;
    }

    let identifierMatched = false;
    if (params.pr !== undefined) {
      if (fact.params.pr !== params.pr) {
        return false;
      }
      identifierMatched = true;
    }
    if (params.branch !== undefined) {
      if (asString(fact.params.branch) !== asString(params.branch)) {
        return false;
      }
      identifierMatched = true;
    }
    return identifierMatched;
  },
};

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

const atomKey = (domain: string, type: string): string => `${domain} ${type}`;

const CATALOG: ReadonlyMap<string, AtomDescriptor> = new Map<string, AtomDescriptor>([
  [atomKey("git", "ref.merged"), gitRefMerged],
  [atomKey("git", "pr.merged"), gitPrMerged],
]);

/**
 * Look up the descriptor registered for an atom, if any. Pure.
 */
export function lookupAtomDescriptor(atom: AtomRef): Option.Option<AtomDescriptor> {
  const descriptor = CATALOG.get(atomKey(atom.domain, atom.type));
  return descriptor === undefined ? Option.none() : Option.some(descriptor);
}

/**
 * Validate an atom against the catalog. Fails with {@link AtomUnknownTypeError}
 * for an unregistered `(domain, type)`, or {@link AtomValidationError} for bad
 * params. Pure: safe to call from the orchestration engine at creation time.
 */
export function validateAtom(
  atom: AtomRef,
): Effect.Effect<void, AtomUnknownTypeError | AtomValidationError> {
  return Option.match(lookupAtomDescriptor(atom), {
    onNone: () => Effect.fail(new AtomUnknownTypeError(atom)),
    onSome: (descriptor) => descriptor.validate(atom.params),
  });
}

/**
 * Whether an external fact matches a concrete atom. Pure. Returns `false` for an
 * unknown type or a non-transient atom (STATE atoms have no `matches`), so a
 * caller can safely test any active atom trigger against a fact.
 */
export function matchesAtom(atom: AtomRef, fact: ExternalEventMatchFact): boolean {
  return Option.match(lookupAtomDescriptor(atom), {
    onNone: () => false,
    onSome: (descriptor) =>
      descriptor.matches === undefined ? false : descriptor.matches(atom.params, fact),
  });
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/**
 * AtomDomainRegistryShape - Service API over the atom catalog.
 */
export interface AtomDomainRegistryShape {
  /** Validate an atom's params (delegates to {@link validateAtom}). */
  readonly validate: (
    atom: AtomRef,
  ) => Effect.Effect<void, AtomUnknownTypeError | AtomValidationError>;
  /** Report an atom's nature, or fail if its type is unknown. */
  readonly natureOf: (atom: AtomRef) => Effect.Effect<AtomNature, AtomUnknownTypeError>;
  /**
   * Evaluate a STATE atom into a boolean. Fails for an unknown type or a
   * non-evaluable (TRANSIENT) atom, and with {@link AtomEvaluationError} on an
   * evaluation error (domain health, per D18).
   */
  readonly evaluate: (
    atom: AtomRef,
  ) => Effect.Effect<boolean, AtomUnknownTypeError | AtomEvaluationError>;
}

/**
 * AtomDomainRegistry - Service tag for the atom catalog + evaluator.
 */
export class AtomDomainRegistry extends Context.Service<
  AtomDomainRegistry,
  AtomDomainRegistryShape
>()("t3/orchestration/Services/AtomDomainRegistry") {}
