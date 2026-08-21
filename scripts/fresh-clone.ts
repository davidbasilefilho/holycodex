// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { join } from "node:path";
import {
  redactDiagnostics,
  runChecked,
  runCommand,
  withTemporaryDirectory,
  type CommandResult,
} from "./process.ts";

const FreshCloneOptionsSchema = Schema.Struct({
  url: Schema.Union(Schema.String.pipe(Schema.minLength(1)), Schema.Null),
  ref: Schema.Union(Schema.String.pipe(Schema.minLength(1)), Schema.Null),
  dryRun: Schema.Boolean,
  fixture: Schema.Boolean,
  network: Schema.Boolean,
});
export type FreshCloneOptions = typeof FreshCloneOptionsSchema.Type;

export interface FreshCloneResult {
  readonly mode: "fixture" | "dry-run" | "network";
  readonly ref: string | null;
  readonly validation: "skipped" | "passed";
}

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

  return await withTemporaryDirectory("holycodex-fresh-clone", async (temporaryRoot) => {
    const cloneRoot = join(temporaryRoot, "repository");
    await checkedGit(
      ["clone", "--no-checkout", "--no-tags", repositoryUrl, cloneRoot],
      temporaryRoot,
      "clone",
      process.env,
    );
    await checkedGit(
      ["fetch", "--depth", "1", "origin", repositoryRef],
      cloneRoot,
      "fetch",
      process.env,
    );
    await checkedGit(["checkout", "--detach", "FETCH_HEAD"], cloneRoot, "checkout", process.env);

    const origin = await checkedGit(
      ["remote", "get-url", "origin"],
      cloneRoot,
      "origin",
      process.env,
    );
    assert(origin.stdout.trim() === repositoryUrl, "clone origin does not match the requested URL");
    const head = await checkedGit(["rev-parse", "HEAD"], cloneRoot, "head", process.env);
    const fetched = await checkedGit(
      ["rev-parse", "FETCH_HEAD"],
      cloneRoot,
      "fetched ref",
      process.env,
    );
    assert(
      head.stdout.trim() === fetched.stdout.trim(),
      "checked-out HEAD does not match the requested ref",
    );
    const status = await checkedGit(
      ["status", "--porcelain", "--untracked-files=all"],
      cloneRoot,
      "clean state",
      process.env,
    );
    assert(status.stdout.trim().length === 0, "fresh clone is not clean before validation");

    await runChecked(["mise", "exec", "--", "bun", "install", "--frozen-lockfile"], {
      cwd: cloneRoot,
      env: process.env,
    });
    await runChecked(["mise", "exec", "--", "bun", "run", "validate"], {
      cwd: cloneRoot,
      env: process.env,
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
  const parsed = Schema.decodeUnknownEither(FreshCloneOptionsSchema)({
    url,
    ref,
    dryRun,
    fixture,
    network,
  });
  if (Either.isLeft(parsed)) {
    throw new Error(`Fresh-clone options are invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
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
    throw new Error(`${label} failed: ${redactDiagnostics(result.stderr || result.stdout)}`);
  }
  return result;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (import.meta.main) {
  try {
    const result = await runFreshClone(parseOptions(Bun.argv.slice(2)));
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: redactDiagnostics(error instanceof Error ? error.message : "fresh-clone failed"),
      }),
    );
    process.exitCode = 1;
  }
}
