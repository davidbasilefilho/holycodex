// SPDX-License-Identifier: Apache-2.0

import { access, chmod, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { AppServerClient, BunStdioTransport } from "../packages/codex/src/index.ts";
import { CliEnvelopeSchema } from "../packages/core/src/envelopes.ts";
import {
  assertBuildUploadEntries,
  assertPublicPackageEntries,
  assertSafeArtifactFile,
  listSafeArtifactEntries,
} from "./artifact-security.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import {
  allowlistedEnvironment,
  DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  redactDiagnostics,
  runCommand,
  runChecked,
  withTemporaryDirectory,
  writeJson,
} from "./process.ts";
import {
  assertReleaseVersion,
  BaseVersionSchema,
  ReleaseChannelSchema,
  ReleaseVersionSchema,
  SourceShaSchema,
  type ReleaseChannel,
} from "./release-version.ts";

const workspaceRoot = resolve(import.meta.dirname, "..");
const cliRoot = join(workspaceRoot, "packages/cli");
const ReleaseStampSchema = Schema.Struct({
  schemaVersion: Schema.Literal("holycodex-release-v1"),
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
});
const PublicManifestSchema = Schema.Struct({
  name: Schema.Literal("holycodex"),
  version: ReleaseVersionSchema,
  bin: Schema.Record({ key: Schema.String, value: Schema.String }),
  files: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
  type: Schema.Literal("module"),
  exports: Schema.Record({ key: Schema.String, value: Schema.String }),
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
  repository: Schema.Struct({ type: Schema.Literal("git"), url: Schema.String }),
  publishConfig: Schema.Struct({ access: Schema.Literal("public") }),
  release: Schema.optional(ReleaseStampSchema),
});
const WorkspaceManifestSchema = Schema.Struct({
  catalog: Schema.Record({ key: Schema.String, value: Schema.String }),
});
const InstalledPluginManifestSchema = Schema.Struct({
  version: Schema.String.pipe(Schema.minLength(1)),
});
const EXPECTED_CODEX_PROVIDER_PLUGINS = [
  "build-web-apps@openai-curated",
  "codex-security@openai-curated",
] as const;
const CODEX_HOLYCODEX_PLUGIN = "holycodex@holycodex" as const;

type CodexPluginListEntry = Readonly<{
  readonly pluginId: string;
  readonly installed: boolean;
  readonly enabled: boolean;
}>;
type CodexPluginList = Readonly<{
  readonly installed: readonly CodexPluginListEntry[];
  readonly available: readonly CodexPluginListEntry[];
}>;

type PublicManifest = typeof PublicManifestSchema.Type;

export interface PackageReleaseOptions {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sourceSha: string;
}

export interface PackageVerificationResult {
  readonly packageVersion: string;
  readonly tarball: string;
  readonly tarballSha256: string;
  readonly entries: readonly string[];
  readonly commands: readonly string[];
}

export interface PackedPublicPackage {
  readonly baseVersion: string;
  readonly packageVersion: string;
  readonly tarball: string;
  readonly tarballPath: string;
  readonly tarballSha256: string;
  readonly entries: readonly string[];
}

export async function packPublicPackage(
  temporaryRoot: string,
  options?: PackageReleaseOptions,
): Promise<PackedPublicPackage> {
  const manifest = await readPublicManifest();
  const baseVersion = decode(BaseVersionSchema, manifest.version, "the canonical package version");
  const version = options?.version ?? baseVersion;
  const release = options === undefined ? undefined : createReleaseStamp(options);
  if (options !== undefined && release !== undefined) {
    assertReleaseVersion(baseVersion, release.channel, version);
  }

  await requireFile(join(cliRoot, "dist/index.js"), "the packed CLI entry point");
  const buildEntries = await listSafeArtifactEntries(join(cliRoot, "dist"), "the build output");
  assertBuildUploadEntries(buildEntries);
  const packageRoot = join(temporaryRoot, "package");
  await mkdir(packageRoot, { recursive: true });
  await cp(join(cliRoot, "dist"), join(packageRoot, "dist"), {
    recursive: true,
    dereference: true,
  });
  const readme = join(cliRoot, "README.md");
  if (await exists(readme)) {
    await cp(readme, join(packageRoot, "README.md"));
  }
  const stagedManifest = release === undefined ? manifest : { ...manifest, version, release };
  await writeJson(join(packageRoot, "package.json"), stagedManifest);
  const entries = await listPackageEntries(packageRoot);
  assertPublicPackageEntries(entries);
  assertAllowedEntries(entries, stagedManifest);

  const tarball = `holycodex-${version}.tgz`;
  await runChecked(["bun", "pm", "pack", "--destination", temporaryRoot, "--quiet"], {
    cwd: packageRoot,
    env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
  });
  const tarballPath = join(temporaryRoot, tarball);
  await requireFile(tarballPath, "the package tarball");
  await assertSafeArtifactFile(tarballPath, tarball, "the package tarball");
  await assertPackedEntries(tarballPath, entries);
  const tarballSha256 = await sha256File(tarballPath);
  return { baseVersion, packageVersion: version, tarball, tarballPath, tarballSha256, entries };
}

export async function verifyPublicPackage(
  packed: PackedPublicPackage,
  codexCliVersion?: string,
): Promise<PackageVerificationResult> {
  const resolvedCodexCliVersion = codexCliVersion ?? (await ensureCodexGenerated()).codexCliVersion;
  assert(
    /^codex-cli \d+\.\d+\.\d+$/u.test(resolvedCodexCliVersion),
    "the generated Codex version authority is not a stable CLI version",
  );
  const version = packed.packageVersion;
  const temporaryRoot = dirname(packed.tarballPath);
  const installedRoot = join(temporaryRoot, "installed");
  await mkdir(installedRoot, { recursive: true });
  await writeJson(join(installedRoot, "package.json"), {
    name: "holycodex-package-verification",
    private: true,
    type: "module",
    dependencies: { holycodex: `file:${packed.tarballPath.replaceAll("\\", "/")}` },
  });
  const bunStateRoot = join(temporaryRoot, "bun-state");
  const bunInstallRoot = join(bunStateRoot, "install");
  const bunTempRoot = join(bunStateRoot, "tmp");
  const bunEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    BUN_INSTALL: bunInstallRoot,
    BUN_TMPDIR: bunTempRoot,
    TEMP: bunTempRoot,
    TMP: bunTempRoot,
    TMPDIR: bunTempRoot,
  });
  await mkdir(bunInstallRoot, { recursive: true });
  await mkdir(bunTempRoot, { recursive: true });
  await runChecked(["bun", "install", "--no-save", "--ignore-scripts", "--no-progress"], {
    cwd: installedRoot,
    env: bunEnvironment,
  });

  const installedPackageRoot = join(installedRoot, "node_modules/holycodex");
  const installedEntry = join(installedPackageRoot, "dist/index.js");
  await requireFile(installedEntry, "the installed package entry point");
  await requireFile(
    join(installedPackageRoot, "dist/assets/plugin/plugin.json"),
    "the installed plugin payload source",
  );
  for (const relativePath of ["skills/plan/SKILL.md"]) {
    await requireFile(
      join(installedPackageRoot, "dist/assets/plugin", relativePath),
      `the installed plugin asset ${relativePath}`,
    );
  }
  const installedManifest = await readInstalledManifest(join(installedPackageRoot, "package.json"));
  assert(
    Object.keys(installedManifest.dependencies).length > 0,
    "the installed package must retain runtime dependencies",
  );
  assert(
    Object.values(installedManifest.dependencies).every(
      (dependency) => !dependency.startsWith("workspace:"),
    ),
    "the installed package must not retain workspace dependency ranges",
  );

  const codexHome = join(temporaryRoot, "codex-home");
  const commands: string[] = [];
  const stateRoot = join(codexHome, "holycodex");
  await mkdir(codexHome, { recursive: true });
  const unrelatedConfig = 'approval_policy = "on-request"\n';
  await writeFile(join(codexHome, "config.toml"), unrelatedConfig, {
    encoding: "utf8",
    mode: 0o600,
  });
  // Exercise Codex discovery, App Server bootstrap, and plugin readback with
  // an isolated executable.  No local marketplace is pre-seeded and no
  // network or user Codex state can affect this package proof.
  const fixturePluginSource = join(codexHome, "fixture-plugin-source");
  await cp(join(installedPackageRoot, "dist/assets/plugin"), fixturePluginSource, {
    recursive: true,
    dereference: true,
  });
  // The npm payload keeps the manifest at the asset root; Codex's native
  // plugin manager reads the canonical .codex-plugin location.
  await mkdir(join(fixturePluginSource, ".codex-plugin"), { recursive: true });
  await cp(
    join(fixturePluginSource, "plugin.json"),
    join(fixturePluginSource, ".codex-plugin/plugin.json"),
  );
  const codexFixture = await createCodexFixture(codexHome, resolvedCodexCliVersion);

  const codexEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    CODEX_HOME: codexHome,
    PATH: [
      codexFixture.binDirectory,
      join(workspaceRoot, "node_modules/.bin"),
      bunEnvironment["PATH"],
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter),
    BUN_INSTALL: bunInstallRoot,
    BUN_TMPDIR: bunTempRoot,
    TEMP: bunTempRoot,
    TMP: bunTempRoot,
    TMPDIR: bunTempRoot,
  });
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

  const executable = await findInstalledExecutable(installedRoot);
  const executableEnvelope = await runInstalledExecutable(
    executable,
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(executableEnvelope.ok, "installed executable bin failed");
  if (executableEnvelope.ok) {
    const executableData = executableEnvelope.data;
    assert(hasProperty(executableData, "version"), "installed executable data is invalid");
    assert(executableData["version"] === version, "installed executable version is not canonical");
  }

  const installEnvelope = await runCli(
    installedEntry,
    ["install", "--yes", "--json", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(installEnvelope.ok, "packed package install failed");

  const pluginListEnvelope = parseCodexPluginList(
    (
      await runChecked([codexFixture.executable, "plugin", "list", "--json"], {
        cwd: workspaceRoot,
        env: codexEnvironment,
      })
    ).stdout,
  );
  for (const pluginId of EXPECTED_CODEX_PROVIDER_PLUGINS) {
    assert(
      pluginListEnvelope.installed.some((entry) => entry.pluginId === pluginId),
      `Codex plugin list did not report selected provider ${pluginId}`,
    );
  }
  assert(
    pluginListEnvelope.installed.some((entry) => entry.pluginId === CODEX_HOLYCODEX_PLUGIN),
    "Codex plugin list did not report HolyCodex",
  );
  const installedPluginRoot = join(codexHome, "plugins/holycodex");
  for (const relativePath of [".codex-plugin/plugin.json", "skills/plan/SKILL.md"]) {
    await requireFile(
      join(installedPluginRoot, relativePath),
      `installed Codex plugin asset ${relativePath}`,
    );
  }
  const installedPluginManifest = decode(
    InstalledPluginManifestSchema,
    JSON.parse(await readFile(join(installedPluginRoot, ".codex-plugin/plugin.json"), "utf8")),
    "installed Codex plugin manifest",
  );
  assert(
    installedPluginManifest.version === packed.baseVersion,
    "installed Codex plugin manifest version is not canonical",
  );
  await assertCodexAppServerReadback(
    codexFixture.executable,
    codexEnvironment,
    codexHome,
    resolvedCodexCliVersion,
  );

  // The fixture intentionally has a closed command surface.  Prove an
  // unexpected command is rejected without exposing process environment data.
  const rejected = await runCommand([codexFixture.executable, "unexpected-command"], {
    cwd: workspaceRoot,
    env: codexEnvironment,
  });
  assert(rejected.exitCode !== 0, "the Codex fixture accepted an unexpected command");

  const doctorEnvelope = await runCli(
    installedEntry,
    ["doctor", "--json", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(doctorEnvelope.ok, "packed package doctor command failed");
  if (doctorEnvelope.ok) {
    const doctorData = doctorEnvelope.data;
    assert(hasProperty(doctorData, "healthy"), "packed package doctor data is invalid");
    assert(doctorData["healthy"] === true, "packed package doctor did not report healthy");
  }

  const removeEnvelope = await runCli(
    installedEntry,
    ["remove", "--yes", "--json", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(removeEnvelope.ok, "packed package remove command failed");
  assert(!(await exists(join(stateRoot, "active.json"))), "remove left the active install record");
  assert(
    !(await exists(join(stateRoot, "conflicted.json"))),
    "remove left the conflicted install record",
  );
  assert(
    (await readFile(join(codexHome, "config.toml"), "utf8")) === unrelatedConfig,
    "remove did not restore unrelated Codex configuration",
  );
  const afterRemove = parseCodexPluginList(
    (
      await runChecked([codexFixture.executable, "plugin", "list", "--json"], {
        cwd: workspaceRoot,
        env: codexEnvironment,
      })
    ).stdout,
  );
  assert(
    !afterRemove.installed.some((entry) => entry.pluginId === CODEX_HOLYCODEX_PLUGIN),
    "Codex plugin list retained HolyCodex after removal",
  );
  return {
    packageVersion: version,
    tarball: packed.tarball,
    tarballSha256: packed.tarballSha256,
    entries: packed.entries,
    commands,
  };
}

export async function assertPackedEntries(
  tarballPath: string,
  expectedEntries: readonly string[],
): Promise<void> {
  const actualEntries = listTarEntries(gunzipSync(await readFile(tarballPath)))
    .map((entry) => entry.replace(/^\.\//u, ""))
    .filter((entry) => entry !== "package" && entry !== "package/")
    .map((entry) => (entry.startsWith("package/") ? entry.slice("package/".length) : entry))
    .sort();
  const expected = [...expectedEntries].sort();
  assert(
    JSON.stringify(actualEntries) === JSON.stringify(expected),
    `the package tarball entries are not allowlisted: ${JSON.stringify(actualEntries)}`,
  );
}

function listTarEntries(archive: Uint8Array): string[] {
  const entries: string[] = [];
  const textDecoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = readTarText(textDecoder, header.subarray(0, 100));
    const prefix = readTarText(textDecoder, header.subarray(345, 500));
    const size = readTarSize(textDecoder, header.subarray(124, 136));
    const type = header[156] ?? 0;
    offset += 512;
    if (offset + size > archive.byteLength) {
      throw new Error("the package tarball contains a truncated entry");
    }
    if (type === 0 || type === 48 || type === 55) {
      entries.push(prefix.length > 0 ? `${prefix}/${name}` : name);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarText(decoder: TextDecoder, bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul)).trim();
}

function readTarSize(decoder: TextDecoder, bytes: Uint8Array): number {
  const value = readTarText(decoder, bytes).replaceAll(String.fromCharCode(0), "");
  if (value.length === 0) {
    return 0;
  }
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("the package tarball contains an invalid entry size");
  }
  return size;
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runPackageVerification(): Promise<PackageVerificationResult> {
  return await withTemporaryDirectory("holycodex-package-verification", async (temporaryRoot) => {
    const generated = await ensureCodexGenerated();
    const packed = await packPublicPackage(temporaryRoot);
    return await verifyPublicPackage(packed, generated.codexCliVersion);
  });
}

async function runCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>> = allowlistedEnvironment(
    DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  ),
): Promise<typeof CliEnvelopeSchema.Type> {
  const command = ["bun", entry, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: environment });
  assert(
    result.exitCode === 0,
    `CLI command failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
  );
  return parseEnvelope(result.stdout);
}

async function runInstalledExecutable(
  executable: string,
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<typeof CliEnvelopeSchema.Type> {
  const args = ["version", "--json"];
  const command = [executable, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: environment });
  assert(
    result.exitCode === 0,
    `executable bin failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
  );
  return parseEnvelope(result.stdout);
}

async function createCodexFixture(
  codexHome: string,
  codexCliVersion: string,
): Promise<Readonly<{ binDirectory: string; executable: string }>> {
  const binDirectory = join(dirname(codexHome), "fake-codex-bin");
  await mkdir(binDirectory, { recursive: true });
  const programPath = join(binDirectory, "fake-codex.mjs");
  await writeFile(programPath, fakeCodexProgram(codexCliVersion), {
    encoding: "utf8",
    mode: 0o600,
  });
  if (process.platform === "win32") {
    const executable = join(binDirectory, "codex.exe");
    await runChecked(
      [
        process.execPath,
        "build",
        "--compile",
        "--windows-hide-console",
        `--outfile=${executable}`,
        programPath,
      ],
      {
        cwd: workspaceRoot,
        env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
      },
    );
    return { binDirectory, executable };
  }
  const executable = join(binDirectory, "codex");
  await writeFile(executable, `#!/usr/bin/env bun\n${fakeCodexProgram(codexCliVersion)}`, {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(executable, 0o700);
  return { binDirectory, executable };
}

async function assertCodexAppServerReadback(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  codexHome: string,
  codexCliVersion: string,
): Promise<void> {
  const transport = new BunStdioTransport({ executablePath: executable, environment });
  const client = new AppServerClient(transport, { requestTimeoutMs: 10_000 });
  try {
    const initialize = await client.initialize();
    assert(
      initialize.userAgent === codexCliVersion,
      "Codex App Server returned a version different from generated provenance",
    );
    assert(
      initialize.protocolVersion ===
        `codex-app-server-${codexCliVersion.slice("codex-cli ".length)}`,
      "Codex App Server returned a protocol version different from generated provenance",
    );
    const readback = await client.readConfig({ includeLayers: true, cwd: codexHome });
    const agents = readback.config["agents"];
    assert(
      typeof agents === "object" && agents !== null && !Array.isArray(agents),
      "Codex App Server config readback omitted role registrations",
    );
    const agentTable = agents as Record<string, unknown>;
    const agentTypes = [
      "Explorer.lookup",
      "Explorer.trace",
      "Librarian.lookup",
      "Librarian.research",
      "Worker.mechanical",
      "Worker.implementation",
      "Worker.integration",
      "Worker.operations",
      "Reviewer.plan",
      "Reviewer.code",
      "Reviewer.artifact",
    ] as const;
    for (const agentType of agentTypes) {
      const registration = agentTable[agentType];
      assert(
        typeof registration === "object" &&
          registration !== null &&
          !Array.isArray(registration) &&
          (registration as Record<string, unknown>)["config_file"] ===
            `holycodex/agents/${agentType}.toml`,
        `Codex App Server config readback omitted the ${agentType} registration`,
      );
      assert(
        typeof (registration as Record<string, unknown>)["name"] === "undefined",
        `Codex App Server config readback unexpectedly materialized ${agentType} metadata`,
      );
    }
  } finally {
    await client.close();
  }
}

function parseCodexPluginList(stdout: string): CodexPluginList {
  const raw: unknown = JSON.parse(stdout);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Codex plugin list response is not an object");
  }
  const record = raw as Record<string, unknown>;
  const installed = record["installed"];
  const available = record["available"];
  if (!Array.isArray(installed) || !Array.isArray(available)) {
    throw new Error("Codex plugin list response omitted installed or available entries");
  }
  const parseEntries = (value: readonly unknown[]): readonly CodexPluginListEntry[] =>
    value.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>)["pluginId"] !== "string" ||
        typeof (entry as Record<string, unknown>)["installed"] !== "boolean" ||
        typeof (entry as Record<string, unknown>)["enabled"] !== "boolean"
      ) {
        throw new Error("Codex plugin list response contains an invalid entry");
      }
      return {
        pluginId: (entry as Record<string, unknown>)["pluginId"] as string,
        installed: (entry as Record<string, unknown>)["installed"] as boolean,
        enabled: (entry as Record<string, unknown>)["enabled"] as boolean,
      };
    });
  return { installed: parseEntries(installed), available: parseEntries(available) };
}

/** Source for the hermetic Codex executable used by package verification. */
function fakeCodexProgram(codexCliVersion: string): string {
  const source = String.raw`const CODEX_VERSION = "CODEX_VERSION_PLACEHOLDER";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HOME = process.env.CODEX_HOME;
const HOLY = "holycodex@holycodex";
const MARKETPLACE = "davidbasilefilho/holycodex";
const PROVIDERS = ["build-web-apps@openai-curated", "codex-security@openai-curated"];
const STATE_PATH = HOME === undefined ? "" : join(HOME, "fixture-codex-state.json");
const SNAPSHOT_ROOT = HOME === undefined ? "" : join(HOME, "plugins", "openai-plugins");
const SNAPSHOT_PATH = join(SNAPSHOT_ROOT, "marketplace.json");

function fail(message) {
  throw new Error(message);
}

function ensureHome() {
  if (HOME === undefined || HOME.length === 0) fail("CODEX_HOME is required");
}

async function readState() {
  ensureHome();
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.marketplaces) ||
      !Array.isArray(parsed.installed) ||
      parsed.marketplaces.some((value) => typeof value !== "string") ||
      parsed.installed.some((value) => typeof value !== "string")
    ) {
      fail("fixture state is invalid");
    }
    const known = new Set([HOLY, ...PROVIDERS]);
    if (parsed.installed.some((id) => !known.has(id))) fail("fixture state contains an unknown plugin");
    return { marketplaces: [...new Set(parsed.marketplaces)], installed: [...new Set(parsed.installed)] };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { marketplaces: [], installed: [] };
    }
    throw error;
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function writeOfficialSnapshot() {
  ensureHome();
  await mkdir(SNAPSHOT_ROOT, { recursive: true, mode: 0o700 });
  await writeFile(
    SNAPSHOT_PATH,
    JSON.stringify({
      name: "openai-curated",
      source: "https://github.com/openai/plugins.git",
      plugins: [
        { name: "build-web-apps", source: "build-web-apps" },
        { name: "codex-security", source: "codex-security" },
      ],
    }) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

async function hasOfficialProvider(name) {
  try {
    const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8"));
    return (
      snapshot.name === "openai-curated" &&
      snapshot.source === "https://github.com/openai/plugins.git" &&
      Array.isArray(snapshot.plugins) &&
      snapshot.plugins.some((entry) => entry.name === name && entry.source === name)
    );
  } catch {
    return false;
  }
}

function pluginEntry(pluginId, installed) {
  const separator = pluginId.lastIndexOf("@");
  return {
    pluginId,
    installed,
    enabled: installed,
    name: separator > 0 ? pluginId.slice(0, separator) : pluginId,
    marketplaceName: separator > 0 ? pluginId.slice(separator + 1) : null,
    version: null,
  };
}

async function listPlugins() {
  const state = await readState();
  const visible = [...PROVIDERS, ...(state.marketplaces.includes(MARKETPLACE) ? [HOLY] : [])];
  return {
    installed: state.installed.map((pluginId) => pluginEntry(pluginId, true)),
    available: visible
      .filter((pluginId) => !state.installed.includes(pluginId))
      .map((pluginId) => pluginEntry(pluginId, false)),
  };
}

async function addPlugin(pluginId) {
  const state = await readState();
  if (pluginId !== HOLY && !PROVIDERS.includes(pluginId)) fail("fixture rejected an unselected plugin");
  if (pluginId === HOLY) {
    if (!state.marketplaces.includes(MARKETPLACE)) fail("HolyCodex marketplace was not registered");
    const source = join(HOME, "fixture-plugin-source");
    const manifest = JSON.parse(await readFile(join(source, ".codex-plugin", "plugin.json"), "utf8"));
    if (manifest.name !== "holycodex" || typeof manifest.version !== "string") fail("HolyCodex plugin manifest is invalid");
    await readFile(join(source, "skills", "plan", "SKILL.md"), "utf8");
    const destination = join(HOME, "plugins", "holycodex");
    await rm(destination, { recursive: true, force: true });
    await mkdir(join(HOME, "plugins"), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, dereference: true });
  } else if (!(await hasOfficialProvider(pluginId.slice(0, pluginId.lastIndexOf("@"))))) {
    fail("selected official provider is absent from Codex startup snapshot");
  }
  if (!state.installed.includes(pluginId)) state.installed.push(pluginId);
  await saveState(state);
  process.stdout.write(JSON.stringify({ pluginId, installedPath: pluginId === HOLY ? join(HOME, "plugins", "holycodex") : undefined }) + "\n");
}

async function removePlugin(pluginId) {
  const state = await readState();
  if (!state.installed.includes(pluginId)) fail("plugin is not installed");
  state.installed = state.installed.filter((candidate) => candidate !== pluginId);
  if (pluginId === HOLY) await rm(join(HOME, "plugins", "holycodex"), { recursive: true, force: true });
  await saveState(state);
  process.stdout.write(JSON.stringify({ pluginId, removed: true }) + "\n");
}

async function configRead() {
  const text = await readFile(join(HOME, "config.toml"), "utf8");
  if (!text.includes("multi_agent_v2 = true")) fail("Codex config omitted multi-agent mode");
  const config = { features: { multi_agent_v2: true }, agents: {} };
  const agentTypes = [
    "Explorer.lookup",
    "Explorer.trace",
    "Librarian.lookup",
    "Librarian.research",
    "Worker.mechanical",
    "Worker.implementation",
    "Worker.integration",
    "Worker.operations",
    "Reviewer.plan",
    "Reviewer.code",
    "Reviewer.artifact",
  ];
  for (const agentType of agentTypes) {
    const reference = "config_file = \"holycodex/agents/" + agentType + ".toml\"";
    if (!text.includes(reference)) fail("Codex config omitted the " + agentType + " registration");
    const roleFile = agentType + ".toml";
    const roleText = await readFile(join(HOME, "holycodex", "agents", roleFile), "utf8");
    if (roleText.includes("tool_output_token_limit")) {
      fail("Codex role file contains the removed tool_output_token_limit");
    }
    config.agents[agentType] = { config_file: "holycodex/agents/" + roleFile };
  }
  return { config, origins: {}, layers: null };
}

async function appServer() {
  let pending = "";
  for await (const chunk of process.stdin) {
    pending += new TextDecoder().decode(chunk);
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim().length > 0) {
        const message = JSON.parse(line);
        if (message.method === "initialized") {
          // The client notification completes the standard handshake.
        } else if (message.method === "initialize") {
          await writeOfficialSnapshot();
          process.stdout.write(JSON.stringify({ id: message.id, result: {
            userAgent: CODEX_VERSION,
            codexHome: HOME,
            platformFamily: "fixture",
            platformOs: process.platform,
            protocolVersion: "codex-app-server-" + CODEX_VERSION.slice("codex-cli ".length),
          } }) + "\n");
        } else if (message.method === "config/read") {
          process.stdout.write(JSON.stringify({ id: message.id, result: await configRead() }) + "\n");
        } else {
          process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "fixture rejected an unexpected App Server method" } }) + "\n");
        }
      }
      newline = pending.indexOf("\n");
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(CODEX_VERSION + "\n");
    return;
  }
  if (args.length === 1 && args[0] === "app-server") {
    await appServer();
    return;
  }
  if (args.length === 3 && args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
    process.stdout.write(JSON.stringify(await listPlugins()) + "\n");
    return;
  }
  if (args.length === 4 && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
    if (args[3] !== MARKETPLACE) fail("fixture rejected an unexpected marketplace");
    const state = await readState();
    if (!state.marketplaces.includes(MARKETPLACE)) state.marketplaces.push(MARKETPLACE);
    await saveState(state);
    process.stdout.write(JSON.stringify({ marketplaceName: "holycodex" }) + "\n");
    return;
  }
  if (args.length === 4 && args[0] === "plugin" && args[1] === "add" && args[3] === "--json") {
    await addPlugin(args[2]);
    return;
  }
  if (args.length === 4 && args[0] === "plugin" && args[1] === "remove" && args[3] === "--json") {
    await removePlugin(args[2]);
    return;
  }
  fail("fixture rejected an unexpected Codex command");
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : "fixture command failed") + "\n");
  process.exitCode = 2;
});
`;
  return source.replace('"CODEX_VERSION_PLACEHOLDER"', JSON.stringify(codexCliVersion));
}

async function readPublicManifest(): Promise<PublicManifest> {
  const raw: unknown = JSON.parse(await readFile(join(cliRoot, "package.json"), "utf8"));
  const parsed = Schema.decodeUnknownEither(PublicManifestSchema, {
    onExcessProperty: "ignore",
  })(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`The public package manifest is invalid: ${String(parsed.left)}`);
  }
  const workspaceRaw: unknown = JSON.parse(
    await readFile(join(workspaceRoot, "package.json"), "utf8"),
  );
  const workspace = Schema.decodeUnknownEither(WorkspaceManifestSchema, {
    onExcessProperty: "ignore",
  })(workspaceRaw);
  if (Either.isLeft(workspace)) {
    throw new Error(`The workspace manifest is invalid: ${String(workspace.left)}`);
  }
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(parsed.right.dependencies)) {
    if (version !== "catalog:") {
      dependencies[name] = version;
      continue;
    }
    const catalogVersion = workspace.right.catalog[name];
    if (catalogVersion === undefined) {
      throw new Error(`The workspace catalog is missing ${name}.`);
    }
    dependencies[name] = catalogVersion;
  }
  return { ...parsed.right, dependencies };
}

async function readInstalledManifest(path: string): Promise<PublicManifest> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = Schema.decodeUnknownEither(PublicManifestSchema, {
    onExcessProperty: "preserve",
  })(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`The installed package manifest is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

async function listPackageEntries(root: string, current = root): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`The staged package may not contain symlinks: ${absolute}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listPackageEntries(root, absolute)));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).split("\\").join("/"));
    } else {
      throw new Error(`The staged package contains a non-file entry: ${absolute}`);
    }
  }
  return files.sort();
}

function assertAllowedEntries(entries: readonly string[], manifest: PublicManifest): void {
  for (const entry of entries) {
    const allowed =
      entry === "package.json" ||
      manifest.files.some((root) => entry === root || entry.startsWith(`${root}/`));
    assert(allowed, `the staged package contains an undeclared entry: ${entry}`);
  }
}

async function findInstalledExecutable(installedRoot: string): Promise<string> {
  for (const candidate of [
    join(installedRoot, "node_modules/.bin/holycodex"),
    join(installedRoot, "node_modules/.bin/holycodex.cmd"),
    join(installedRoot, "node_modules/.bin/holycodex.exe"),
  ]) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("the installed executable bin is missing");
}

function createReleaseStamp(options: PackageReleaseOptions): typeof ReleaseStampSchema.Type {
  const parsed = Schema.decodeUnknownEither(ReleaseStampSchema)({
    schemaVersion: "holycodex-release-v1",
    channel: options.channel,
    sourceSha: options.sourceSha,
  });
  if (Either.isLeft(parsed)) {
    throw new Error(`The release stamp is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

function parseEnvelope(stdout: string): typeof CliEnvelopeSchema.Type {
  const raw: unknown = JSON.parse(stdout);
  const parsed = Schema.decodeUnknownEither(CliEnvelopeSchema)(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`CLI package verification envelope failed validation: ${String(parsed.left)}`);
  }
  return parsed.right;
}

function decode<A>(schema: Schema.Schema<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownEither(schema)(value);
  if (Either.isLeft(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.left)}`);
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
    const result = await runPackageVerification();
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "package verification failed",
      }),
    );
    process.exitCode = 1;
  }
}
