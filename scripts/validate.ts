// SPDX-License-Identifier: Apache-2.0

import { runFreshClone } from "./fresh-clone.ts";
import { runPackageVerification } from "./package-verification.ts";
import { runRepositoryProof } from "./repository-proof.ts";
import { allowlistedEnvironment, DEFAULT_COMMAND_ENVIRONMENT_KEYS, runChecked } from "./process.ts";
import { resolve } from "node:path";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";

const workspaceRoot = resolveWorkspaceRoot();

export interface ValidationResult {
  readonly steps: readonly string[];
  readonly generatedArtifactDigest: string;
  readonly packageVersion: string;
}

export async function runValidation(): Promise<ValidationResult> {
  await ensureCodexGenerated();
  const steps: string[] = [];
  const commandEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS);
  const bun = await runChecked(["bun", "--version"], {
    cwd: workspaceRoot,
    env: commandEnvironment,
  });
  assert(/^1\.4\./u.test(bun.stdout.trim()), "validation requires mise-resolved Bun 1.4");
  steps.push("bun 1.4");

  await runStep(["vp", "run", "fmt", "--check"], "format", steps);
  await runStep(["vp", "run", "lint"], "lint", steps);
  await runStep(["vp", "run", "check", "--no-fmt", "--no-lint"], "typescript", steps);
  await runStep(["vp", "run", "test", "--run"], "tests", steps);
  await runStep(["bun", "scripts/package-build.ts"], "package build", steps);

  const proof = await runRepositoryProof();
  steps.push("repository proof");
  const packageVerification = await runPackageVerification();
  steps.push("package artifact verification");
  const clone = await runFreshClone({
    url: null,
    ref: null,
    dryRun: false,
    fixture: true,
    network: false,
  });
  assert(clone.mode === "fixture", "fresh-clone fixture proof did not run in fixture mode");
  steps.push("fresh-clone fixture proof");
  await runStep(["git", "diff", "--check"], "diff whitespace", steps);
  return {
    steps,
    generatedArtifactDigest: proof.generatedArtifactDigest,
    packageVersion: packageVerification.packageVersion,
  };
}

async function runStep(command: readonly string[], label: string, steps: string[]): Promise<void> {
  await runChecked(command, {
    cwd: workspaceRoot,
    env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
  });
  steps.push(label);
}

function resolveWorkspaceRoot(): string {
  return resolve(import.meta.dirname, "..");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (import.meta.main) {
  try {
    const result = await runValidation();
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "repository validation failed",
      }),
    );
    process.exitCode = 1;
  }
}
