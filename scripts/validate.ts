// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runFreshClone } from "./fresh-clone.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  runCheckedEffect,
} from "./process.ts";
import { runRepositoryProof } from "./repository-proof.ts";

const workspaceRoot = resolveWorkspaceRoot();
const BunVersionSchema = Schema.String.check(Schema.isPattern(/^1\.4\./u));
const FixtureCloneModeSchema = Schema.Literals(["fixture"]);

/** Summary of successful repository validation gates and verified package artifacts. */
export interface ValidationResult {
  /** Repository validation gates that completed successfully. */
  readonly steps: readonly string[];
  /** Digest identifying the generated Codex artifact set validated by the run. */
  readonly generatedArtifactDigest: string;
  /** Canonical public package version checked by package verification. */
  readonly packageVersion: string;
}

/** Run the complete local formatting, lint, test, build, and proof gate. */
export function runValidation(): Effect.Effect<ValidationResult, unknown> {
  return Effect.gen(function* () {
    yield* ensureCodexGenerated();
    const steps: string[] = [];
    const commandEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS);
    const bun = yield* runCheckedEffect(["bun", "--version"], {
      cwd: workspaceRoot,
      env: commandEnvironment,
    });
    yield* Schema.decodeUnknownEffect(BunVersionSchema)(bun.stdout.trim());
    steps.push("bun 1.4");

    yield* runStep(["bun", "run", "fmt:check"], "format", steps);
    yield* runStep(["bun", "run", "lint"], "lint", steps);
    yield* runStep(["bun", "test"], "tests", steps);
    yield* runStep(["bun", "scripts/package-build.ts"], "package build", steps);

    const proof = yield* runRepositoryProof();
    steps.push("repository proof");
    const { runPackageVerificationEffect } = yield* Effect.tryPromise(
      () => import("./package-verification.ts"),
    );
    const packageVerification = yield* runPackageVerificationEffect();
    steps.push("package artifact verification");
    const clone = yield* Effect.tryPromise(() =>
      runFreshClone({
        url: null,
        ref: null,
        dryRun: false,
        fixture: true,
        network: false,
      }),
    );
    yield* Schema.decodeUnknownEffect(FixtureCloneModeSchema)(clone.mode);
    steps.push("fresh-clone fixture proof");
    yield* runStep(["git", "diff", "--check"], "diff whitespace", steps);
    return {
      steps,
      generatedArtifactDigest: proof.generatedArtifactDigest,
      packageVersion: packageVerification.packageVersion,
    };
  });
}

function runStep(
  command: readonly string[],
  label: string,
  steps: string[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* runCheckedEffect(command, {
      cwd: workspaceRoot,
      env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
      failureDiagnostics: process.env["CI"] === "1" ? "full" : "compact",
    });
    steps.push(label);
  });
}

function resolveWorkspaceRoot(): string {
  return resolve(import.meta.dirname, "..");
}

if (import.meta.main) {
  await Effect.runPromise(
    runValidation().pipe(
      Effect.tap((result) =>
        Effect.sync(() => console.log(JSON.stringify({ status: "verified", ...result }))),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(JSON.stringify({ status: "failed", message: Cause.pretty(cause) }));
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
