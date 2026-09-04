// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  canonicalJsonUtf8,
  createSha256Digest,
  domainSeparatedSha256,
  type Sha256Digest,
} from "@holycodex/core";
import * as Schema from "effect/Schema";

import { CodexError, checked } from "./common";

const ARTIFACT_ROOT_RELATIVE = "packages/codex/generated" as const;
const STABLE_CODEX_VERSION = /^codex-cli \d+\.\d+\.\d+$/u;
const STABLE_PROTOCOL_EPOCH = /^codex-app-server-\d+\.\d+\.\d+$/u;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const Sha256DigestSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const GeneratedProvenanceSchema = Schema.Struct({
  schema_version: Schema.Literal("holycodex-generated-v2"),
  artifact_root: Schema.Literal(ARTIFACT_ROOT_RELATIVE),
  codex_cli_version: Schema.String.pipe(Schema.pattern(STABLE_CODEX_VERSION)),
  codex_cli_digest: Sha256DigestSchema,
  protocol_epoch: Schema.String.pipe(Schema.pattern(STABLE_PROTOCOL_EPOCH)),
  generator: Schema.Struct({
    command: Schema.Tuple(Schema.Literal("app-server"), Schema.Literal("generate-ts")),
    supported_surface: Schema.Literal("codex app-server generators"),
  }),
  typescript_root: Schema.Literal("typescript"),
  files: Schema.Struct({
    count: Schema.Number.pipe(Schema.int(), Schema.positive()),
    digest: Sha256DigestSchema,
  }),
});

const GeneratedArtifactFileSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1)),
  size: Schema.Number.pipe(Schema.int(), Schema.positive()),
  sha256: Sha256DigestSchema,
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
  readonly protocol_epoch: string;
  readonly codex_cli_version: string;
  readonly inventory: GeneratedArtifactInventory;
  readonly multi_agent_v2_lifecycle: "verified" | "unverified";
}

export interface GeneratedArtifactVerificationOptions {
  readonly artifactRoot?: string;
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
      "The generated artifact provenance could not be read.",
      {},
      { cause: error },
    );
  }
  return checked(GeneratedProvenanceSchema, parsed, "generated artifact provenance");
}

async function collectInventory(root: string): Promise<GeneratedArtifactInventory> {
  await assertNoSymlinkBoundary(root);
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

async function assertNoSymlinkBoundary(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new CodexError(
        "protocol_mismatch",
        "Generated artifacts may not contain symlinked roots.",
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

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
  const root = resolve(options.artifactRoot ?? join(import.meta.dirname, "../generated"));
  const provenance = await readProvenance(root);
  if (
    provenance.generator.command[0] !== "app-server" ||
    provenance.generator.command[1] !== "generate-ts"
  ) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact provenance has an unexpected generator command.",
    );
  }
  const inventory = await collectInventory(root);
  if (inventory.count !== provenance.files.count || inventory.digest !== provenance.files.digest) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact provenance does not match its portable inventory digest.",
    );
  }
  const version = provenance.codex_cli_version.slice("codex-cli ".length);
  if (provenance.protocol_epoch !== `codex-app-server-${version}`) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated artifact provenance has mismatched Codex and protocol versions.",
    );
  }
  const protocolSource = await readFile(join(root, "typescript", "protocol.ts"), "utf8");
  if (
    protocolSource !==
    `// GENERATED CODE! DO NOT MODIFY BY HAND!\n\nexport const CODEX_PROTOCOL_VERSION = "codex-cli-${version}" as const;\nexport const CODEX_PROTOCOL_EPOCH = "codex-app-server-${version}" as const;\n`
  ) {
    throw new CodexError(
      "protocol_mismatch",
      "Generated protocol imports do not match the resolved Codex version.",
    );
  }
  const lifecycle = await generatedV2LifecycleStatus(root);
  return {
    artifact_root: provenance.artifact_root,
    protocol_epoch: provenance.protocol_epoch,
    codex_cli_version: provenance.codex_cli_version,
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
      "The generated artifact could not be verified.",
      {},
      { cause: error },
    );
  }
}
