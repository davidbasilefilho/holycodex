// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { access, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { CliEnvelopeSchema } from "../packages/core/src/envelopes.ts";
import {
  assertReleaseVersion,
  BaseVersionSchema,
  ReleaseChannelSchema,
  ReleaseVersionSchema,
  SourceShaSchema,
  type ReleaseChannel,
} from "./release-version.ts";
import { runCommand, runChecked, withTemporaryDirectory, writeJson } from "./process.ts";

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
const MarketplaceAddEnvelopeSchema = Schema.Struct({
  marketplaceName: Schema.Literal("holycodex"),
});
const PluginAddEnvelopeSchema = Schema.Struct({
  pluginId: Schema.Literal("holycodex@holycodex"),
  installedPath: Schema.String.pipe(Schema.minLength(1)),
});
const PluginListEnvelopeSchema = Schema.Struct({
  installed: Schema.Array(Schema.Struct({ pluginId: Schema.String.pipe(Schema.minLength(1)) })),
});
const InstalledPluginManifestSchema = Schema.Struct({
  version: Schema.String.pipe(Schema.minLength(1)),
});

type PublicManifest = typeof PublicManifestSchema.Type;

export interface PackageReleaseOptions {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sourceSha: string;
}

export interface PackageSmokeResult {
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
  assertAllowedEntries(entries, stagedManifest);

  const tarball = `holycodex-${version}.tgz`;
  await runChecked(["bun", "pm", "pack", "--destination", temporaryRoot, "--quiet"], {
    cwd: packageRoot,
    env: process.env,
  });
  const tarballPath = join(temporaryRoot, tarball);
  await requireFile(tarballPath, "the package tarball");
  await assertPackedEntries(tarballPath, entries);
  const tarballSha256 = await sha256File(tarballPath);
  return { baseVersion, packageVersion: version, tarball, tarballPath, tarballSha256, entries };
}

export async function smokePublicPackage(packed: PackedPublicPackage): Promise<PackageSmokeResult> {
  const version = packed.packageVersion;
  const temporaryRoot = dirname(packed.tarballPath);
  const installedRoot = join(temporaryRoot, "installed");
  await mkdir(installedRoot, { recursive: true });
  await writeJson(join(installedRoot, "package.json"), {
    name: "holycodex-package-smoke",
    private: true,
    type: "module",
    dependencies: { holycodex: `file:${packed.tarballPath.replaceAll("\\", "/")}` },
  });
  const bunStateRoot = join(temporaryRoot, "bun-state");
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

  const installedPackageRoot = join(installedRoot, "node_modules/holycodex");
  const installedEntry = join(installedPackageRoot, "dist/index.js");
  await requireFile(installedEntry, "the installed package entry point");
  await requireFile(
    join(installedPackageRoot, "dist/assets/plugin/plugin.json"),
    "the installed plugin payload source",
  );
  for (const relativePath of ["agents/root.md", "rules/manifest.json", "skills/plan/SKILL.md"]) {
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

  const codexEnvironment = {
    ...bunEnvironment,
    CODEX_HOME: codexHome,
    PATH: [join(workspaceRoot, "node_modules/.bin"), process.env["PATH"]]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter),
  };
  const codexCommand = ["bun", "x", "--no-install", "codex"] as const;
  const marketplaceAdd = await runChecked(
    [...codexCommand, "plugin", "marketplace", "add", workspaceRoot, "--json"],
    { cwd: workspaceRoot, env: codexEnvironment },
  );
  commands.push("codex plugin marketplace add <workspace> --json");
  const pluginAdd = await runChecked(
    [...codexCommand, "plugin", "add", "holycodex@holycodex", "--json"],
    { cwd: workspaceRoot, env: codexEnvironment },
  );
  commands.push("codex plugin add holycodex@holycodex --json");
  const pluginList = await runChecked([...codexCommand, "plugin", "list", "--json"], {
    cwd: workspaceRoot,
    env: codexEnvironment,
  });
  commands.push("codex plugin list --json");
  const marketplaceEnvelope = decode(
    MarketplaceAddEnvelopeSchema,
    JSON.parse(marketplaceAdd.stdout),
    "Codex marketplace add response",
  );
  const pluginEnvelope = decode(
    PluginAddEnvelopeSchema,
    JSON.parse(pluginAdd.stdout),
    "Codex plugin add response",
  );
  const pluginListEnvelope = decode(
    PluginListEnvelopeSchema,
    JSON.parse(pluginList.stdout),
    "Codex plugin list response",
  );
  assert(marketplaceEnvelope.marketplaceName === "holycodex", "Codex marketplace add failed");
  assert(pluginEnvelope.pluginId === "holycodex@holycodex", "Codex plugin add failed");
  assert(
    pluginListEnvelope.installed.some((entry) => entry.pluginId === "holycodex@holycodex"),
    "Codex plugin list did not report HolyCodex",
  );
  const installedPluginRoot = pluginEnvelope.installedPath;
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
  const executableEnvelope = await runInstalledExecutable(executable, installedRoot, commands);
  assert(executableEnvelope.ok, "installed executable bin failed");
  if (executableEnvelope.ok) {
    const executableData = executableEnvelope.data;
    assert(hasProperty(executableData, "version"), "installed executable data is invalid");
    assert(executableData["version"] === version, "installed executable version is not canonical");
  }

  const installEnvelope = await runCli(
    installedEntry,
    ["install", "--yes", "--json", "--no-frontend", "--no-security", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(installEnvelope.ok, "packed package install failed");

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

export async function runPackageSmoke(): Promise<PackageSmokeResult> {
  return await withTemporaryDirectory("holycodex-package-smoke", async (temporaryRoot) => {
    const packed = await packPublicPackage(temporaryRoot);
    return await smokePublicPackage(packed);
  });
}

async function runCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<typeof CliEnvelopeSchema.Type> {
  const command = ["bun", entry, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: environment });
  assert(
    result.exitCode === 0,
    `CLI command failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`,
  );
  return parseEnvelope(result.stdout);
}

async function runInstalledExecutable(
  executable: string,
  cwd: string,
  commands: string[],
): Promise<typeof CliEnvelopeSchema.Type> {
  const args = ["version", "--json"];
  const command = [executable, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: process.env });
  assert(
    result.exitCode === 0,
    `executable bin failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`,
  );
  return parseEnvelope(result.stdout);
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
    throw new Error(`CLI smoke envelope failed validation: ${String(parsed.left)}`);
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
