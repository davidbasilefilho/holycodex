// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  redactDiagnostics,
  runChecked,
  runCommand,
  withTemporaryDirectory,
  type CommandResult,
} from "./process.ts";

const FreshCloneOptionsSchema = Schema.Struct({
  url: Schema.Union([Schema.String.check(Schema.isMinLength(1)), Schema.Null]),
  ref: Schema.Union([Schema.String.check(Schema.isMinLength(1)), Schema.Null]),
  dryRun: Schema.Boolean,
  fixture: Schema.Boolean,
  network: Schema.Boolean,
});
/** Inputs controlling fixture, dry-run, or explicitly networked fresh-clone validation. */
export type FreshCloneOptions = typeof FreshCloneOptionsSchema.Type;

/** Outcome of a fresh-clone validation run. */
export interface FreshCloneResult {
  /** Execution mode used for the clone check. */
  readonly mode: "fixture" | "dry-run" | "network";
  /** Requested ref, or null when fixture mode supplies its own ref. */
  readonly ref: string | null;
  /** Whether repository validation ran or was skipped by the selected mode. */
  readonly validation: "skipped" | "passed";
}

/** Clone and validate a repository according to the requested safety mode. */
export async function runFreshClone(options: FreshCloneOptions): Promise<FreshCloneResult> {
  if (options.fixture) {
    assert(!options.network, "fixture mode cannot use network");
    const fixtureUrl = "https://user:secret@example.invalid/holycodex.git";
    const redacted = redactDiagnostics(fixtureUrl);
    assert(!redacted.includes("secret"), "fixture redaction proof failed");
    assert(redacted.includes("[REDACTED]"), "fixture redaction marker is missing");
    return { mode: "fixture", ref: "refs/heads/main", validation: "skipped" };
  }
  if (options.url === null || options.ref === null) {
    throw new Error("An explicit repository URL and ref are required.");
  }
  const repositoryUrl = options.url;
  const repositoryRef = options.ref;
  validateUrl(repositoryUrl);
  validateRef(repositoryRef);
  if (options.dryRun) {
    return { mode: "dry-run", ref: repositoryRef, validation: "skipped" };
  }
  if (!options.network) {
    throw new Error("A network clone requires the explicit --network safety switch.");
  }

  const commandEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  });

  return await withTemporaryDirectory("holycodex-fresh-clone", async (temporaryRoot) => {
    const cloneRoot = join(temporaryRoot, "repository");
    await checkedGit(
      ["clone", "--no-checkout", "--no-tags", repositoryUrl, cloneRoot],
      temporaryRoot,
      "clone",
      commandEnvironment,
    );
    await checkedGit(
      ["fetch", "--depth", "1", "origin", repositoryRef],
      cloneRoot,
      "fetch",
      commandEnvironment,
    );
    await checkedGit(
      ["checkout", "--detach", "FETCH_HEAD"],
      cloneRoot,
      "checkout",
      commandEnvironment,
    );

    const origin = await checkedGit(
      ["remote", "get-url", "origin"],
      cloneRoot,
      "origin",
      commandEnvironment,
    );
    assert(origin.stdout.trim() === repositoryUrl, "clone origin does not match the requested URL");
    const head = await checkedGit(["rev-parse", "HEAD"], cloneRoot, "head", commandEnvironment);
    const fetched = await checkedGit(
      ["rev-parse", "FETCH_HEAD"],
      cloneRoot,
      "fetched ref",
      commandEnvironment,
    );
    assert(
      head.stdout.trim() === fetched.stdout.trim(),
      "checked-out HEAD does not match the requested ref",
    );
    const status = await checkedGit(
      ["status", "--porcelain", "--untracked-files=all"],
      cloneRoot,
      "clean state",
      commandEnvironment,
    );
    assert(status.stdout.trim().length === 0, "fresh clone is not clean before validation");

    await runChecked(["bun", "install", "--frozen-lockfile"], {
      cwd: cloneRoot,
      env: commandEnvironment,
    });
    await runChecked(["bun", "run", "validate"], {
      cwd: cloneRoot,
      env: commandEnvironment,
    });
    return { mode: "network", ref: repositoryRef, validation: "passed" };
  });
}

function parseOptions(argv: readonly string[]): FreshCloneOptions {
  let url: string | null = null;
  let ref: string | null = null;
  let dryRun = false;
  let fixture = false;
  let network = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--url":
        url = requiredValue(argv, ++index, "--url");
        break;
      case "--ref":
        ref = requiredValue(argv, ++index, "--ref");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--fixture":
        fixture = true;
        break;
      case "--network":
        network = true;
        break;
      case "--help":
        console.log("Usage: bun scripts/fresh-clone.ts --url <repository> --ref <ref> --network");
        console.log("       bun scripts/fresh-clone.ts --fixture");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown fresh-clone option: ${argument ?? ""}`);
    }
  }
  const parsed = Schema.decodeUnknownResult(FreshCloneOptionsSchema)({
    url,
    ref,
    dryRun,
    fixture,
    network,
  });
  if (Result.isFailure(parsed)) {
    throw new Error(`Fresh-clone options are invalid: ${String(parsed.failure)}`);
  }
  return parsed.success;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function validateUrl(value: string): void {
  if (value.includes("\u0000") || /\s/u.test(value) || value.startsWith("-")) {
    throw new Error("The repository URL contains invalid characters.");
  }
  if (!/^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/iu.test(value)) {
    throw new Error("The repository URL must be an explicit HTTPS, SSH, Git, or file URL.");
  }
}

function validateRef(value: string): void {
  if (
    value.includes("\u0000") ||
    /\s/u.test(value) ||
    value.startsWith("-") ||
    value.length > 256 ||
    value.includes("..")
  ) {
    throw new Error("The repository ref contains invalid characters.");
  }
}

async function checkedGit(
  command: readonly string[],
  cwd: string,
  label: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult> {
  const result = await runCommand(["git", "-c", "credential.interactive=false", ...command], {
    cwd,
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
    );
  }
  return result;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (import.meta.main) {
  const program = Effect.tryPromise({
    try: () => runFreshClone(parseOptions(Bun.argv.slice(2))),
    catch: (error) => error,
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => console.log(JSON.stringify({ status: "verified", ...result }))),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(
          JSON.stringify({
            status: "failed",
            message: redactDiagnostics(
              error instanceof Error ? error.message : "fresh-clone failed",
            ),
          }),
        );
        process.exitCode = 1;
      }),
    ),
  );
  await Effect.runPromise(program);
}
