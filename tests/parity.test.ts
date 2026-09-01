// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { parseCliEnvelope } from "../packages/core/src/envelopes.ts";
import { runBinary, runCli, assertRootText, pathWithin } from "../packages/cli/src/index.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanRoomBase = "682adea6d6cba374251152af612489126e9c64c1";
const frozenOracle = "eb796235f2f29f2c67c869408a0e22c1a72c13eb";
const parityTarget = "`holycodex-legacy` at `main`";
const ParityFixturesSchema = Schema.Struct({
  schema_epoch: Schema.Literal("holycodex-parity-fixtures-1"),
  normalization: Schema.String.pipe(Schema.minLength(1)),
  matrix: Schema.Array(
    Schema.Struct({
      id: Schema.String.pipe(Schema.minLength(1)),
      classification: Schema.Literal("PRESERVED", "SUPERSEDED", "REMOVED-BY-REQUIREMENT"),
      owner: Schema.String.pipe(Schema.minLength(1)),
      proof: Schema.String.pipe(Schema.minLength(1)),
    }),
  ),
  surfaces: Schema.Array(
    Schema.Struct({
      id: Schema.String.pipe(Schema.minLength(1)),
      owner: Schema.String.pipe(Schema.minLength(1)),
      expected: Schema.String.pipe(Schema.minLength(1)),
    }),
  ),
});
const ManifestVersionSchema = Schema.Struct({ version: Schema.String.pipe(Schema.minLength(1)) });

const expectedSurfaceIds = [
  "cli-help",
  "cli-version",
  "cli-json-and-exits",
  "workflow-lifecycle",
  "workflow-native-default",
  "workflow-compatibility-gate",
  "v2-disabled-fallback",
  "v2-unverified",
  "capability-denied-enabled",
  "rules-compaction",
  "lsp-platform-fixtures",
  "native-install-readback",
  "packed-install-doctor-cleanup",
  "babysit-ci",
  "cutover-runbook",
] as const;

describe("0.15 foundation parity contract", () => {
  test("records the exact baseline identities and sole permitted difference", async () => {
    const matrix = await readFile(resolve(workspaceRoot, "docs/PARITY.md"), "utf8");

    expect(matrix).toContain(cleanRoomBase);
    expect(matrix).toContain(frozenOracle);
    expect(matrix).toContain(parityTarget);
    expect(matrix).toContain("target-backed evidence is\npending");
    expect(matrix).toContain(
      "observation after an approved push or tag, with no mutation authority",
    );
    expect(matrix).toContain("Admissible evidence");
    expect(matrix).toContain("Independent proof");
    expect(matrix).toContain("proven");
    expect(matrix).toContain("capability-gated");
    expect(matrix).toContain("external pending");
    expect(matrix).not.toMatch(/\|\s+(?:staged|future)\s+\|/iu);
    expect(matrix).toContain("No required local capability is unresolved");
    const inventory = matrix.slice(matrix.indexOf("## Required surface inventory"));
    const tableRows = inventory.split("\n").filter((line) => line.startsWith("|"));
    expect(tableRows.length).toBeGreaterThan(2);
    for (const row of tableRows) {
      expect(row.split("|")).toHaveLength(8);
    }
  });

  test("keeps Effect Schema ownership canonical across the workspace", async () => {
    const [rootManifest, mise, coreManifest, coreSources] = await Promise.all([
      readFile(resolve(workspaceRoot, "package.json"), "utf8"),
      readFile(resolve(workspaceRoot, "mise.toml"), "utf8"),
      readFile(resolve(workspaceRoot, "packages/core/package.json"), "utf8"),
      readCoreSources(resolve(workspaceRoot, "packages/core/src")),
    ]);

    expect(rootManifest).toContain('"effect": "3.22.1"');
    expect(rootManifest).not.toContain('"arktype"');
    expect(rootManifest).toContain('"packageManager": "bun@1.4.0"');
    expect(mise).toContain('bun = "1.4"');
    expect(coreManifest).toContain('"effect": "catalog:"');
    expect(coreManifest).not.toContain("arktype");
    expect(coreSources.join("\n")).toContain('from "effect/Schema"');
    expect(coreSources.join("\n")).not.toMatch(/arktype|ArkType/u);
    const docs = await readFile(resolve(workspaceRoot, "docs/DEPENDENCIES.md"), "utf8");
    expect(docs).toContain("sole runtime");
    expect(docs).not.toMatch(/arktype/iu);
  });

  test("uses an independently authored, deterministic surface inventory", async () => {
    const raw: unknown = JSON.parse(
      await readFile(resolve(workspaceRoot, "tests/fixtures/parity-surfaces.json"), "utf8"),
    );
    const parsed = Schema.decodeUnknownEither(ParityFixturesSchema)(raw);
    expect(Either.isRight(parsed)).toBe(true);
    if (Either.isLeft(parsed)) {
      throw new Error(String(parsed.left));
    }
    expect(parsed.right.normalization).toContain("JSON decoding");
    expect(parsed.right.matrix).toHaveLength(26);
    expect(new Set(parsed.right.matrix.map((row) => row.id)).size).toBe(26);
    for (const row of parsed.right.matrix) {
      await expect(readFile(resolve(workspaceRoot, row.owner), "utf8")).resolves.toBeTruthy();
      await expect(readFile(resolve(workspaceRoot, row.proof), "utf8")).resolves.toBeTruthy();
    }
    expect(parsed.right.surfaces.map((surface) => surface.id)).toEqual(expectedSurfaceIds);
    expect(parsed.right.surfaces.find((surface) => surface.id === "babysit-ci")).toEqual({
      id: "babysit-ci",
      owner: "workflow",
      expected: "observation-only",
    });
    expect(parsed.right.surfaces.find((surface) => surface.id === "cutover-runbook")).toEqual({
      id: "cutover-runbook",
      owner: "release",
      expected: "approval-gated",
    });
  });

  test("proves CLI help, canonical version, JSON envelopes, and exit classification", async () => {
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.envelope.ok).toBe(true);
    if (help.envelope.ok) {
      expect(JSON.stringify(help.envelope.data)).toContain("capability-denied QuickJS");
    }

    const manifestRaw: unknown = JSON.parse(
      await readFile(resolve(workspaceRoot, "packages/cli/package.json"), "utf8"),
    );
    const manifest = Schema.decodeUnknownEither(ManifestVersionSchema)(manifestRaw);
    expect(Either.isRight(manifest)).toBe(true);
    if (Either.isLeft(manifest)) {
      throw new Error(String(manifest.left));
    }
    const version = await runCli(["version"]);
    expect(version.exitCode).toBe(0);
    expect(JSON.stringify(version.envelope)).toContain(manifest.right.version);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const jsonExit = await runBinary(["version", "--json"], {
      stdoutIsTTY: false,
      stderrIsTTY: false,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    expect(jsonExit).toBe(0);
    expect(stderr).toEqual([]);
    const jsonRaw: unknown = JSON.parse(stdout.join(""));
    const jsonEnvelope = parseCliEnvelope(jsonRaw);
    expect(jsonEnvelope.ok).toBe(true);

    const invalid = await runCli(["doctor", "--unknown"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.envelope.ok).toBe(false);
    if (!invalid.envelope.ok) {
      expect(invalid.envelope.error.code).toBe("invalid_argument");
    }
  });

  test("proves isolated platform path fixtures and the plugin asset surfaces", async () => {
    const windowsRoot = assertRootText("C:\\Users\\fixture\\.codex", "CODEX_HOME", "win32");
    const gitBashRoot = assertRootText("/c/Users/fixture/.codex", "CODEX_HOME", "win32");
    expect(gitBashRoot).toBe(windowsRoot);
    expect(pathWithin(windowsRoot, "C:\\Users\\fixture\\.codex\\runs", "win32")).toBe(true);

    const [rules, compaction] = await Promise.all([
      readFile(resolve(workspaceRoot, "packages/plugin/assets/rules/manifest.json"), "utf8"),
      readFile(resolve(workspaceRoot, "packages/plugin/assets/compaction/manifest.json"), "utf8"),
    ]);
    expect(rules).toContain("rules/holycodex.md");
    expect(compaction).toContain("verification");
  });

  test("keeps every required practical surface mapped to an independent proof", async () => {
    const proofPaths = [
      "packages/cli/src/index.test.ts",
      "packages/cli/src/workflow.test.ts",
      "packages/cli/src/index.test.ts",
      "packages/codex/src/boundary.test.ts",
      "packages/codex/src/generated-artifact.test.ts",
      "packages/codex/test/fixtures/codex-cli-0.148.0/capability-v1-fallback.ndjson",
      "packages/codex/test/fixtures/codex-cli-0.148.0/capability-v2-disabled.ndjson",
      "packages/codex/test/fixtures/codex-cli-0.148.0/capability-v2-advertised.ndjson",
      "packages/plugin/assets/rules/manifest.json",
      "packages/plugin/assets/compaction/manifest.json",
      "tests/fixtures/effect-promise-adapters.json",
      "scripts/fresh-clone.ts",
      "scripts/package-smoke.ts",
      "docs/CUTOVER.md",
      "packages/codex/generated/codex-cli-0.148.0/provenance.json",
    ] as const;
    for (const path of proofPaths) {
      await expect(readFile(resolve(workspaceRoot, path), "utf8")).resolves.toBeTruthy();
    }
    const matrix = await readFile(resolve(workspaceRoot, "docs/PARITY.md"), "utf8");
    expect(matrix).toContain(
      "observation after an approved push or tag, with no mutation authority",
    );
    expect(matrix).toContain("real canonical clone remains external pending");
    expect(matrix).toContain(
      "External repository identities and metadata are pending until cutover",
    );
  });
});

async function readCoreSources(directory: string): Promise<readonly string[]> {
  const contents: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      contents.push(...(await readCoreSources(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      contents.push(await readFile(path, "utf8"));
    }
  }
  return contents;
}
