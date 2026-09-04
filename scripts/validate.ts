// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { runFreshClone } from "./fresh-clone.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import { allowlistedEnvironment, DEFAULT_COMMAND_ENVIRONMENT_KEYS, runChecked } from "./process.ts";
import { runRepositoryProof } from "./repository-proof.ts";

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
  assert(bun.stdout.trim().startsWith("1.4."), "validation requires mise-resolved Bun 1.4");
  steps.push("bun 1.4");

  await runStep(["vp", "run", "fmt", "--check"], "format", steps);
  await runStep(["vp", "run", "lint"], "lint", steps);
  await runStep(["vp", "run", "check", "--no-fmt", "--no-lint"], "typescript", steps);
  await runStep(["vp", "run", "test", "--run"], "tests", steps);
  await runStep(["bun", "scripts/package-build.ts"], "package build", steps);

  const proof = await runRepositoryProof();
  steps.push("repository proof");
  const { runPackageVerification } = await import("./package-verification.ts");
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
