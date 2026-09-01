// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import * as Schema from "effect/Schema";
import {
  canonicalJson,
  canonicalJsonUtf8,
  createSha256Digest,
  domainSeparatedSha256,
  type Sha256Digest,
} from "@holycodex/core";
import { CODEX_PROTOCOL_EPOCH, CodexError, checked, sanitizeText } from "./common";
import { allowlistedEnvironment, decodeUtf8, readBoundedStream } from "./transport";

const ARTIFACT_ROOT_RELATIVE = "packages/codex/generated/codex-cli-0.148.0" as const;
const EXPECTED_BINARY_VERSION = "codex-cli 0.148.0" as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const Sha256DigestSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const GeneratedProvenanceSchema = Schema.Struct({
  artifact_digest: Sha256DigestSchema,
  artifact_root: Schema.Literal(ARTIFACT_ROOT_RELATIVE),
  codex_cli: Schema.Struct({
    path_observed: Schema.String.pipe(Schema.minLength(1)),
    sha256: Sha256DigestSchema,
    version: Schema.Literal(EXPECTED_BINARY_VERSION),
  }),
  generator: Schema.Struct({
    commands: Schema.Array(Schema.Array(Schema.String)),
    experimental: Schema.Literal(false),
    protocol_epoch: Schema.Literal(CODEX_PROTOCOL_EPOCH),
    supported_surface: Schema.Literal("codex app-server generators"),
  }),
  files: Schema.Struct({
    count: Schema.Number.pipe(Schema.int(), Schema.positive()),
    typescript_root: Schema.Literal("typescript"),
  }),
  capability_evidence: Schema.Struct({
    multi_agent: Schema.Literal("stable"),
    multi_agent_v2: Schema.Literal("disabled"),
    generated_lifecycle: Schema.Literal("verified", "unverified"),
    selection_rule: Schema.String.pipe(Schema.minLength(1)),
  }),
});

const GeneratedArtifactFileSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
  size: Schema.Number.pipe(Schema.int(), Schema.positive()),
  sha256: Sha256DigestSchema,
});
const GeneratedArtifactCommandResultSchema = Schema.Struct({
  exitCode: Schema.Number.pipe(Schema.int()),
  stdout: Schema.String.pipe(Schema.maxLength(16 * 1024)),
  stderr: Schema.String.pipe(Schema.maxLength(16 * 1024)),
});

export interface GeneratedArtifactFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
}

export interface GeneratedArtifactInventory {
  readonly count: number;
  readonly files: readonly GeneratedArtifactFile[];
  readonly digest: Sha256Digest;
}

export interface GeneratedArtifactVerification {
  readonly artifact_root: typeof ARTIFACT_ROOT_RELATIVE;
  readonly protocol_epoch: typeof CODEX_PROTOCOL_EPOCH;
  readonly executable: {
    readonly path: string;
    readonly version: typeof EXPECTED_BINARY_VERSION;
    readonly sha256: Sha256Digest;
  };
  readonly inventory: GeneratedArtifactInventory;
  readonly multi_agent_v2_lifecycle: "verified" | "unverified";
}

export interface GeneratedArtifactCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GeneratedArtifactExecutableAdapter {
  readonly runVersion: (
    path: string,
    environment: Readonly<Record<string, string>>,
  ) => Promise<GeneratedArtifactCommandResult>;
}

export interface GeneratedArtifactVerificationOptions {
  readonly artifactRoot?: string;
  readonly verifyExecutable?: boolean;
  readonly executableAdapter?: GeneratedArtifactExecutableAdapter;
}

function comparePath(left: GeneratedArtifactFile, right: GeneratedArtifactFile): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

async function sha256File(path: string): Promise<Sha256Digest> {
  const bytes = await readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const validated = createSha256Digest(hex);
  if (!validated.ok) {
    throw new CodexError("protocol_mismatch", "The generated artifact digest is invalid.");
  }
  return validated.value;
}

function checkedSha256(value: string, label: string): Sha256Digest {
  const validated = createSha256Digest(value);
  if (!validated.ok) {
    throw new CodexError("protocol_mismatch", `The ${label} digest is invalid.`);
  }
  return validated.value;
}

async function readProvenance(root: string): Promise<typeof GeneratedProvenanceSchema.Type> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, "provenance.json"), "utf8")) as unknown;
  } catch (error: unknown) {
    throw new CodexError(
      "protocol_mismatch",
      "The checked-in generated artifact provenance could not be read.",
      {},
      { cause: error },
    );
  }
  return checked(GeneratedProvenanceSchema, parsed, "generated artifact provenance");
}

async function collectInventory(root: string): Promise<GeneratedArtifactInventory> {
  const files: GeneratedArtifactFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new CodexError("protocol_mismatch", "Generated artifacts may not contain symlinks.");
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new CodexError("protocol_mismatch", "Generated artifacts contain a non-file entry.");
      }
      const path = relative(root, absolute).split("\\").join("/");
      if (path === "provenance.json") {
        continue;
      }
      if (!path.startsWith("typescript/")) {
        throw new CodexError(
          "protocol_mismatch",
          "Generated artifacts contain a file outside the declared roots.",
          { path },
        );
      }
      if (metadata.size <= 0 || metadata.size > MAX_FILE_BYTES) {
        throw new CodexError(
          "protocol_mismatch",
          "A generated artifact file has an invalid size.",
          {
            path,
          },
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new CodexError("protocol_mismatch", "Generated artifacts exceed the size bound.");
      }
      files.push({ path, size: metadata.size, sha256: await sha256File(absolute) });
    }
  };
  await visit(root);
  files.sort(comparePath);
  const validatedFiles: GeneratedArtifactFile[] = files.map((file) => {
    const validated = checked(GeneratedArtifactFileSchema, file, "generated artifact file");
    return {
      path: validated.path,
      size: validated.size,
      sha256: checkedSha256(validated.sha256, "generated artifact file"),
    };
  });
  const digest = await domainSeparatedSha256("codex-schema-output", [
    canonicalJsonUtf8(validatedFiles),
  ]);
  return { count: validatedFiles.length, files: validatedFiles, digest };
}

async function verifyExecutable(
  path: string,
  expectedVersion: typeof EXPECTED_BINARY_VERSION,
  expectedDigest: Sha256Digest,
  executableAdapter: GeneratedArtifactExecutableAdapter,
): Promise<{
  readonly path: string;
  readonly version: typeof EXPECTED_BINARY_VERSION;
  readonly sha256: Sha256Digest;
}> {
  const observedDigest = await sha256File(path);
  if (observedDigest !== expectedDigest) {
    throw new CodexError(
      "discovery_failed",
      "The recorded Codex executable digest does not match the generated artifact provenance.",
      { path },
    );
  }
  let result: GeneratedArtifactCommandResult;
  try {
    result = checked(
      GeneratedArtifactCommandResultSchema,
      await executableAdapter.runVersion(path, allowlistedEnvironment()),
      "Codex version command result",
    );
    const version = sanitizeText(result.stdout);
    if (result.exitCode !== 0 || version !== expectedVersion) {
      throw new CodexError(
        "discovery_failed",
        "The Codex executable version is not the recorded version.",
        {
          exitCode: result.exitCode,
          version,
          diagnostics: sanitizeText(result.stderr),
        },
      );
    }
  } catch (error: unknown) {
    if (error instanceof CodexError) {
      throw error;
    }
    throw new CodexError(
      "discovery_failed",
      "The Codex executable version check failed.",
      {},
      { cause: error },
    );
  }
  return { path, version: expectedVersion, sha256: observedDigest };
}

const BunExecutableAdapter: GeneratedArtifactExecutableAdapter = {
  runVersion: async (path, environment) => {
    if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
      throw new CodexError(
        "discovery_failed",
        "Bun is required for generated artifact executable verification.",
      );
    }
    const child = Bun.spawn([path, "--version"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      throw new CodexError(
        "discovery_failed",
        "The recorded Codex executable did not expose pipes.",
      );
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readBoundedStream(child.stdout, 16 * 1024),
        readBoundedStream(child.stderr, 16 * 1024),
        child.exited,
      ]);
      return {
        exitCode,
        stdout: decodeUtf8(stdout, "Codex version output"),
        stderr: decodeUtf8(stderr, "Codex version diagnostics"),
      };
    } catch (error: unknown) {
      try {
        child.kill();
      } catch {
        // The version process may already have exited.
      }
      throw error;
    }
  },
};

async function generatedV2LifecycleStatus(root: string): Promise<"verified" | "unverified"> {
  // The generated union is authoritative for RPCs. A V2 collaboration data type alone
  // is insufficient; this checks for a generated client control method before enabling V2.
  try {
    const requestSource = await readFile(join(root, "typescript", "ClientRequest.ts"), "utf8");
    return /"method":\s*"[^"]*(?:agent|collab)[^"]*"/u.test(requestSource)
      ? "verified"
      : "unverified";
  } catch {
    return "unverified";
  }
}

async function verifyGeneratedArtifactInternal(
  options: GeneratedArtifactVerificationOptions,
): Promise<GeneratedArtifactVerification> {
  const root = resolve(
    options.artifactRoot ?? join(import.meta.dirname, "../generated/codex-cli-0.148.0"),
  );
  const provenance = await readProvenance(root);
  if (provenance.generator.commands.length !== 1) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact provenance has an invalid generator command list.",
    );
  }
  const expectedCommands = [["app-server", "generate-ts", "--out", "<artifact-root>/typescript"]];
  if (canonicalJson(provenance.generator.commands) !== canonicalJson(expectedCommands)) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact provenance has unexpected generator commands.",
    );
  }
  const inventory = await collectInventory(root);
  const recordedArtifactDigest = checkedSha256(
    provenance.artifact_digest,
    "recorded generated artifact",
  );
  if (inventory.count !== provenance.files.count || inventory.digest !== recordedArtifactDigest) {
    throw new CodexError(
      "protocol_mismatch",
      "The generated artifact inventory does not match its recorded provenance.",
      {
        observed_count: inventory.count,
        recorded_count: provenance.files.count,
        observed_digest: inventory.digest,
        recorded_digest: recordedArtifactDigest,
      },
    );
  }
  const lifecycle = await generatedV2LifecycleStatus(root);
  if (provenance.capability_evidence.generated_lifecycle !== lifecycle) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact V2 lifecycle evidence is inconsistent with the checked-in contract.",
      { observed: lifecycle, recorded: provenance.capability_evidence.generated_lifecycle },
    );
  }
  const recordedExecutableDigest = checkedSha256(
    provenance.codex_cli.sha256,
    "recorded Codex executable",
  );
  const executable =
    options.verifyExecutable === false
      ? {
          path: provenance.codex_cli.path_observed,
          version: provenance.codex_cli.version,
          sha256: recordedExecutableDigest,
        }
      : await verifyExecutable(
          provenance.codex_cli.path_observed,
          provenance.codex_cli.version,
          recordedExecutableDigest,
          options.executableAdapter ?? BunExecutableAdapter,
        );
  return {
    artifact_root: provenance.artifact_root,
    protocol_epoch: provenance.generator.protocol_epoch,
    executable,
    inventory,
    multi_agent_v2_lifecycle: lifecycle,
  };
}

export async function verifyGeneratedArtifact(
  options: GeneratedArtifactVerificationOptions = {},
): Promise<GeneratedArtifactVerification> {
  try {
    return await verifyGeneratedArtifactInternal(options);
  } catch (error: unknown) {
    if (error instanceof CodexError) {
      throw error;
    }
    throw new CodexError(
      "protocol_mismatch",
      "The checked-in generated artifact could not be verified.",
      {},
      { cause: error },
    );
  }
}
