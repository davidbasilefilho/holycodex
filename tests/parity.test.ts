// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { runBinary, runCli, assertRootText, pathWithin } from "../packages/cli/src/index.ts";
import { parseCliEnvelope } from "../packages/core/src/envelopes.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanRoomBase = "682adea6d6cba374251152af612489126e9c64c1";
const frozenOracle = "eb796235f2f29f2c67c869408a0e22c1a72c13eb";
const parityTarget = "Foundation version";
const ParityFixturesSchema = Schema.Struct({
  schema_epoch: Schema.Literals(["holycodex-parity-fixtures-1"]),
  normalization: Schema.String.check(Schema.isMinLength(1)),
  matrix: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      classification: Schema.Literals(["PRESERVED", "SUPERSEDED", "REMOVED-BY-REQUIREMENT"]),
      owner: Schema.String.check(Schema.isMinLength(1)),
      proof: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
  surfaces: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      owner: Schema.String.check(Schema.isMinLength(1)),
      expected: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
});
const ManifestVersionSchema = Schema.Struct({
  version: Schema.String.check(Schema.isMinLength(1)),
});

const expectedSurfaceIds = [
  "cli-help",
  "cli-version",
  "cli-json-and-exits",
  "v2-disabled-fallback",
  "v2-unverified",
  "capability-denied-enabled",
  "native-install-readback",
  "packed-install-doctor-remove",
  "cutover-runbook",
] as const;

describe("0.16 foundation parity contract", () => {
  test("records the exact baseline identities and sole permitted difference", async () => {
    const matrix = await readFile(resolve(workspaceRoot, "docs/PARITY.md"), "utf8");

    expect(matrix).toContain(cleanRoomBase);
    expect(matrix).toContain(frozenOracle);
    expect(matrix).toContain(parityTarget);
    expect(matrix).toContain("Worker.operations");
    expect(matrix).toContain("admissible difference");
    expect(matrix).toContain("Independent proof");
    expect(matrix).toContain("proven");
    expect(matrix).toContain("capability-gated");
    expect(matrix).toContain("external pending");
    expect(matrix).not.toMatch(/\|\s+(?:staged|future)\s+\|/iu);
    expect(matrix).toContain("Required surface inventory");
    const inventory = matrix.slice(matrix.indexOf("## Required surface inventory"));
    const tableRows = inventory.split("\n").filter((line) => line.startsWith("|"));
    expect(tableRows.length).toBeGreaterThan(2);
    for (const row of tableRows) {
      expect(row.split("|")).toHaveLength(6);
    }
  });

  test("records the GPT-6.1 Sol/Luna profile routing boundary", async () => {
    const [behavior, configuration, cli] = await Promise.all([
      readFile(resolve(workspaceRoot, "docs/BEHAVIOR.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/CONFIGURATION.md"), "utf8"),
      readFile(resolve(workspaceRoot, "docs/CLI.md"), "utf8"),
    ]);
    expect(behavior).toContain("low = gpt-6.1-sol/low");
    expect(behavior).toContain("default = gpt-6.1-sol/medium");
    expect(behavior).toContain("high = gpt-6.1-sol/medium");
    expect(behavior).toContain("gpt-6-luna");
    expect(behavior).toMatch(/The live profiles are\s+`low`, `default`, and `high`/u);
    expect(behavior).toContain("Legacy `go`");
    expect(configuration).toContain("--profile");
    expect(cli).toContain("--profile <name>");
    expect(cli).not.toContain("--plan <name>");
  });

  test("keeps Effect Schema ownership canonical across the workspace", async () => {
    const [rootManifest, mise, coreManifest, coreSources] = await Promise.all([
      readFile(resolve(workspaceRoot, "package.json"), "utf8"),
      readFile(resolve(workspaceRoot, "mise.toml"), "utf8"),
      readFile(resolve(workspaceRoot, "packages/core/package.json"), "utf8"),
      readCoreSources(resolve(workspaceRoot, "packages/core/src")),
    ]);

    expect(rootManifest).toContain('"effect": "^3.22.2"');
    expect(rootManifest).not.toContain('"arktype"');
    expect(rootManifest).toContain('"packageManager": "bun@1.4.2"');
    expect(mise).toContain('bun = "1.4"');
    expect(coreManifest).toContain('"effect": "catalog:"');
    expect(coreManifest).not.toContain("arktype");
    expect(coreSources.join("\n")).toContain('from "effect/Schema"');
    expect(coreSources.join("\n")).not.toMatch(/arktype|ArkType/u);
    const docs = await readFile(resolve(workspaceRoot, "docs/DEPENDENCIES.md"), "utf8");
    expect(docs).toContain("sole boundary-validation ecosystem");
    expect(docs).not.toMatch(/arktype/iu);
  });

  test("uses an independently authored, deterministic surface inventory", async () => {
    const raw: unknown = JSON.parse(
      await readFile(resolve(workspaceRoot, "tests/fixtures/parity-surfaces.json"), "utf8"),
    );
    const parsed = Schema.decodeUnknownResult(ParityFixturesSchema)(raw);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) {
      throw new Error(String(parsed.failure));
    }
    expect(parsed.success.normalization).toContain("JSON decoding");
    expect(parsed.success.matrix).toHaveLength(17);
    expect(new Set(parsed.success.matrix.map((row) => row.id)).size).toBe(17);
    for (const row of parsed.success.matrix) {
      await expect(readFile(resolve(workspaceRoot, row.owner), "utf8")).resolves.toBeTruthy();
      await expect(readFile(resolve(workspaceRoot, row.proof), "utf8")).resolves.toBeTruthy();
    }
    const actualSurfaceIds: string[] = parsed.success.surfaces.map((surface) => surface.id);
    expect(actualSurfaceIds).toEqual([...expectedSurfaceIds]);
    expect(parsed.success.surfaces.find((surface) => surface.id === "cutover-runbook")).toEqual({
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
      expect(JSON.stringify(help.envelope.data)).toContain("native Codex plugin management");
    }

    const manifestRaw: unknown = JSON.parse(
      await readFile(resolve(workspaceRoot, "packages/cli/package.json"), "utf8"),
    );
    const manifest = Schema.decodeUnknownResult(ManifestVersionSchema)(manifestRaw);
    expect(Result.isSuccess(manifest)).toBe(true);
    if (Result.isFailure(manifest)) {
      throw new Error(String(manifest.failure));
    }
    const version = await runCli(["version"]);
    expect(version.exitCode).toBe(0);
    expect(JSON.stringify(version.envelope)).toContain(manifest.success.version);

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

  test("proves isolated platform path fixtures and the plugin skill surface", async () => {
    const windowsRoot = assertRootText("C:\\Users\\fixture\\.codex", "CODEX_HOME", "win32");
    expect(pathWithin(windowsRoot, "C:\\Users\\fixture\\.codex\\runs", "win32")).toBe(true);
    await expect(
      readFile(
        resolve(workspaceRoot, "packages/plugin/assets/skills/visual-loop/SKILL.md"),
        "utf8",
      ),
    ).resolves.toContain("name: visual-loop");
  });

  test("keeps every required practical surface mapped to an independent proof", async () => {
    const proofPaths = [
      "packages/cli/src/index.test.ts",
      "packages/codex/src/generated-artifact.test.ts",
      "packages/plugin/assets/skills/visual-loop/SKILL.md",
      "tests/fixtures/effect-promise-adapters.json",
      "scripts/fresh-clone.ts",
      "scripts/package-verification.ts",
      "docs/CUTOVER.md",
    ] as const;
    for (const path of proofPaths) {
      await expect(readFile(resolve(workspaceRoot, path), "utf8")).resolves.toBeTruthy();
    }
    const matrix = await readFile(resolve(workspaceRoot, "docs/PARITY.md"), "utf8");
    expect(matrix).toContain("Worker.operations");
    expect(matrix).toContain("external pending");
    expect(matrix).toContain("approved remote actions");
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
