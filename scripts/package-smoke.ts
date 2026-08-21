// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { access, cp, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CliEnvelopeSchema } from "../packages/core/src/envelopes.ts";
import { validateSource } from "../packages/plugin/src/planning.ts";
import { runCommand, runChecked, withTemporaryDirectory, writeJson } from "./process.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const cliRoot = join(workspaceRoot, "packages/cli");
const PublicManifestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.String.pipe(Schema.minLength(1)),
  bin: Schema.Record({ key: Schema.String, value: Schema.String }),
  files: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  type: Schema.Literal("module"),
  exports: Schema.Record({ key: Schema.String, value: Schema.String }),
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
});

export interface PackageSmokeResult {
  readonly packageVersion: string;
  readonly tarball: string;
  readonly commands: readonly string[];
}

export async function runPackageSmoke(): Promise<PackageSmokeResult> {
  const manifest = await readPublicManifest();
  const version = manifest.version;
  await requireFile(join(cliRoot, "dist/index.js"), "the packed CLI entry point");
  return await withTemporaryDirectory("holycodex-package-smoke", async (temporaryRoot) => {
    const packageRoot = join(temporaryRoot, "package");
    await mkdir(packageRoot, { recursive: true });
    await cp(join(cliRoot, "dist"), join(packageRoot, "dist"), { recursive: true });
    const readme = join(cliRoot, "README.md");
    if (await exists(readme)) {
      await cp(readme, join(packageRoot, "README.md"));
    }
    await writeJson(join(packageRoot, "package.json"), manifest);
    const tarballName = `holycodex-${version}.tgz`;
    await runChecked(["bun", "pm", "pack", "--destination", temporaryRoot, "--quiet"], {
      cwd: packageRoot,
      env: process.env,
    });
    const tarball = join(temporaryRoot, tarballName);
    await requireFile(tarball, "the package tarball");
    const installedRoot = join(temporaryRoot, "installed");
    await mkdir(installedRoot, { recursive: true });
    await writeJson(join(installedRoot, "package.json"), {
      name: "holycodex-package-smoke",
      private: true,
      type: "module",
      dependencies: { holycodex: `file:${tarball.replaceAll("\\", "/")}` },
    });
    await withBunTemporaryDirectory(async (bunStateRoot) => {
      const bunEnvironment = {
        ...process.env,
        BUN_INSTALL: join(bunStateRoot, "install"),
        BUN_TMPDIR: join(bunStateRoot, "tmp"),
        TEMP: join(bunStateRoot, "tmp"),
        TMP: join(bunStateRoot, "tmp"),
        TMPDIR: join(bunStateRoot, "tmp"),
      };
      await mkdir(bunEnvironment.BUN_INSTALL, { recursive: true });
      await mkdir(bunEnvironment.BUN_TMPDIR, { recursive: true });
      await runChecked(["bun", "install", "--no-save", "--ignore-scripts", "--no-progress"], {
        cwd: installedRoot,
        env: bunEnvironment,
      });
    });
    const installedEntry = join(installedRoot, "node_modules/holycodex/dist/index.js");
    await requireFile(installedEntry, "the installed package entry point");
    await requireFile(
      join(installedRoot, "node_modules/holycodex/dist/assets/.codex-plugin/plugin.json"),
      "the installed plugin payload source",
    );
    for (const relativePath of [
      "agents/root.md",
      "hooks/manifest.json",
      "rules/manifest.json",
      "skills/plan/SKILL.md",
    ]) {
      await requireFile(
        join(installedRoot, "node_modules/holycodex/dist/assets", relativePath),
        `the installed plugin asset ${relativePath}`,
      );
    }
    await validateSource(join(installedRoot, "node_modules/holycodex/dist/assets"));

    const codexHome = join(temporaryRoot, "codex-home");
    const marketplaceRoot = join(temporaryRoot, "marketplace");
    const stateRoot = join(codexHome, "holycodex");
    await mkdir(stateRoot, { recursive: true });
    await writeJson(join(stateRoot, "legacy-state.json"), {
      schema_epoch: "legacy-state-1",
      plan: "plus",
      tier: "Standard",
      autonomy: "assisted",
      max_subagents: 1,
    });

    const commands: string[] = [];
    const versionEnvelope = await runCli(
      installedEntry,
      ["version", "--json"],
      installedRoot,
      commands,
    );
    assert(versionEnvelope.ok, "installed package version command failed");
    if (versionEnvelope.ok) {
      const versionData = versionEnvelope.data;
      assert(hasProperty(versionData, "version"), "installed package version data is invalid");
      assert(versionData["version"] === version, "installed package version is not canonical");
    }

    const installEnvelope = await runCli(
      installedEntry,
      [
        "install",
        "--yes",
        "--json",
        "--codex-home",
        codexHome,
        "--marketplace-root",
        marketplaceRoot,
      ],
      installedRoot,
      commands,
    );
    assert(installEnvelope.ok, "packed package install failed");
    await requireFile(join(stateRoot, "migrated-state.json"), "the migrated state record");

    const doctorEnvelope = await runCli(
      installedEntry,
      ["doctor", "--json", "--codex-home", codexHome, "--marketplace-root", marketplaceRoot],
      installedRoot,
      commands,
    );
    assert(doctorEnvelope.ok, "packed package doctor command failed");
    if (doctorEnvelope.ok) {
      const doctorData = doctorEnvelope.data;
      assert(hasProperty(doctorData, "healthy"), "packed package doctor data is invalid");
      assert(doctorData["healthy"] === true, "packed package doctor did not report healthy");
    }

    const cleanupEnvelope = await runCli(
      installedEntry,
      [
        "cleanup",
        "--scope",
        "workspace",
        "--yes",
        "--json",
        "--codex-home",
        codexHome,
        "--marketplace-root",
        marketplaceRoot,
      ],
      installedRoot,
      commands,
    );
    assert(cleanupEnvelope.ok, "packed package cleanup command failed");
    assert(
      !(await exists(join(stateRoot, "active.json"))),
      "cleanup left the active install record",
    );
    return {
      packageVersion: version,
      tarball: tarballName,
      commands,
    };
  });
}

async function runCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
): Promise<typeof CliEnvelopeSchema.Type> {
  const command = ["bun", entry, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: process.env });
  assert(
    result.exitCode === 0,
    `CLI command failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`,
  );
  const raw: unknown = JSON.parse(result.stdout);
  const parsed = Schema.decodeUnknownEither(CliEnvelopeSchema)(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`CLI smoke envelope failed validation: ${String(parsed.left)}`);
  }
  return parsed.right;
}

async function readPublicManifest(): Promise<typeof PublicManifestSchema.Type> {
  const raw: unknown = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
  const parsed = Schema.decodeUnknownEither(PublicManifestSchema)(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`The public package manifest is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withBunTemporaryDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  return await withTemporaryDirectory("holycodex-package-smoke-bun", operation);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function hasProperty(value: unknown, key: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && key in value;
}

if (import.meta.main) {
  try {
    const result = await runPackageSmoke();
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "package smoke failed",
      }),
    );
    process.exitCode = 1;
  }
}
