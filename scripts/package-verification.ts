// SPDX-License-Identifier: Apache-2.0

import { access, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { parseConfig } from "../packages/cli/src/installer.ts";
import { windowsGitBashShellDirective } from "../packages/cli/src/native-agents.ts";
import type {
  NativeAgentProjection,
  RootAgentProjection,
} from "../packages/cli/src/native-agents.ts";
import { AppServerClient, BunStdioTransport, readTomlPath } from "../packages/codex/src/index.ts";
import { PROFILE_CATALOG } from "../packages/core/src/catalog.ts";
import { CliEnvelopeSchema } from "../packages/core/src/envelopes.ts";
import { NATIVE_AGENT_TYPES } from "../packages/core/src/routes.ts";
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
  baseVersionFromRelease,
  CanonicalVersionSchema,
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
const ADDITIONAL_FIXTURE_PLUGIN = "additional@fixture" as const;
const LEGACY_WORK_PROVIDER_PLUGINS = [
  "documents@openai-primary-runtime",
  "pdf@openai-primary-runtime",
  "presentations@openai-primary-runtime",
  "spreadsheets@openai-primary-runtime",
  "template-creator@openai-primary-runtime",
] as const;
// These identities authenticate the immutable published previous-stable package used by the
// upgrade proof. Its exact version is derived from the current canonical patch version below.
const PREVIOUS_STABLE_SOURCE_SHA = "78bbcb5a51392f3397cf32ff7e433d21c0bbf39c";
const PREVIOUS_STABLE_CLI_SHA256 =
  "b1adcc45cabeb667affc7426fdb4bacbabba3e29095fef0fb3c99e3e4c3d5fba";
const PREVIOUS_STABLE_AGENT_SHA256 =
  "4adcd4a2084080c7127b97c508a4a024e58faefff21f52803746c67756edc854";

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
type InstalledCliModule = Readonly<{
  readonly runCli: (argv: readonly string[], context?: unknown) => Promise<unknown>;
  readonly upgradeHolyCodex: (
    options: unknown,
    environment: Readonly<Record<string, string | undefined>>,
    request: { readonly dryRun?: boolean },
  ) => Promise<Record<string, unknown>>;
  readonly installRecordDigest: (value: Record<string, unknown>) => Promise<string>;
  readonly projectNativeAgents: (
    profile: (typeof PROFILE_CATALOG)[number]["name"],
    tier?: "standard" | "fast" | "fast-all",
  ) => readonly NativeAgentProjection[];
  readonly projectRootAgent: (
    profile: (typeof PROFILE_CATALOG)[number]["name"],
    tier?: "standard" | "fast" | "fast-all",
  ) => RootAgentProjection;
  readonly renderNativeAgent: (agent: NativeAgentProjection) => string;
}>;

type InternalUpgradeOutcome =
  | Readonly<{ ok: true; data: Record<string, unknown> }>
  | Readonly<{ ok: false; error: Readonly<{ code: string }> }>;

function verifyPublishedRouting(installed: InstalledCliModule): void {
  let projectedRoutes = 0;
  for (const profile of PROFILE_CATALOG) {
    const roots = [
      installed.projectRootAgent(profile.name, "standard"),
      installed.projectRootAgent(profile.name, "fast"),
      installed.projectRootAgent(profile.name, "fast-all"),
    ];
    assert(
      roots.every(
        (root) => root.model === profile.root.model && root.effort === profile.root.effort,
      ),
      `the packed ${profile.name} Root route changed across service tiers`,
    );
    assert(
      roots[0]?.serviceTier === "default" &&
        roots[1]?.serviceTier === "default" &&
        roots[2]?.serviceTier === "fast",
      `the packed ${profile.name} Root service-tier projection is invalid`,
    );

    const standard = installed.projectNativeAgents(profile.name, "standard");
    const fast = installed.projectNativeAgents(profile.name, "fast");
    const fastAll = installed.projectNativeAgents(profile.name, "fast-all");
    assert(
      standard.length === NATIVE_AGENT_TYPES.length &&
        fast.length === standard.length &&
        fastAll.length === standard.length,
      `the packed ${profile.name} route projection is incomplete`,
    );

    for (const route of profile.routes) {
      const name = `${route.role}.${route.task}`;
      const standardAgent = standard.find((agent) => agent.name === name);
      const fastAgent = fast.find((agent) => agent.name === name);
      const fastAllAgent = fastAll.find((agent) => agent.name === name);
      assert(
        standardAgent !== undefined && fastAgent !== undefined && fastAllAgent !== undefined,
        `the packed ${profile.name} route projection omitted ${name}`,
      );
      for (const agent of [standardAgent, fastAgent, fastAllAgent]) {
        assert(
          agent.model === "gpt-6-luna" &&
            agent.model === route.model &&
            agent.effort === route.effort,
          `the packed ${profile.name} route for ${name} changed model or effort`,
        );
      }
      assert(
        standardAgent.serviceTier === "default" &&
          fastAgent.serviceTier === "fast" &&
          fastAllAgent.serviceTier === "fast",
        `the packed ${profile.name} route for ${name} changed service tier`,
      );

      for (const [agent, expectedTier] of [
        [standardAgent, "default"],
        [fastAllAgent, "fast"],
      ] as const) {
        const document = parseConfig(installed.renderNativeAgent(agent));
        assert(
          readTomlPath(document, "name") === name &&
            readTomlPath(document, "model") === route.model &&
            readTomlPath(document, "model_reasoning_effort") === route.effort &&
            readTomlPath(document, "service_tier") === expectedTier,
          `the packed ${profile.name} TOML projection for ${name} is invalid`,
        );
      }
      projectedRoutes += 1;
    }
  }
  assert(
    projectedRoutes === PROFILE_CATALOG.length * NATIVE_AGENT_TYPES.length,
    "the packed module did not verify all 39 profile and specialist projections",
  );
}

/** Exercise the packed package's migration boundary without a public CLI command. */
async function runInternalUpgrade(
  entry: string,
  codexHome: string,
  environment: Readonly<Record<string, string | undefined>>,
  dryRun = false,
): Promise<InternalUpgradeOutcome> {
  const installed = (await import(pathToFileURL(entry).href)) as InstalledCliModule;
  try {
    return {
      ok: true,
      data: await installed.upgradeHolyCodex({ paths: { codexHome } }, environment, { dryRun }),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "internal_error",
      },
    };
  }
}

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
  readonly canonicalVersion: string;
  readonly baseVersion: string;
  readonly packageVersion: string;
  readonly tarball: string;
  readonly tarballPath: string;
  readonly tarballSha256: string;
  readonly entries: readonly string[];
}

/** Pack the public package into a verified tarball in a temporary directory. */
export async function packPublicPackage(
  temporaryRoot: string,
  options?: PackageReleaseOptions,
): Promise<PackedPublicPackage> {
  const manifest = await readPublicManifest();
  const canonicalVersion = decode(
    CanonicalVersionSchema,
    manifest.version,
    "the canonical package version",
  );
  const baseVersion = baseVersionFromRelease(canonicalVersion);
  const version = options?.version ?? canonicalVersion;
  const release = options === undefined ? undefined : createReleaseStamp(options);
  if (options !== undefined && release !== undefined) {
    assertReleaseVersion(canonicalVersion, release.channel, version);
  }

  await requireFile(join(cliRoot, "dist/index.js"), "the packed CLI entry point");
  await requireFile(join(cliRoot, "dist/agent.js"), "the packed agent CLI entry point");
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
  return {
    canonicalVersion,
    baseVersion,
    packageVersion: version,
    tarball,
    tarballPath,
    tarballSha256,
    entries,
  };
}

/** Install and exercise a packed public package in an isolated environment. */
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
    npm_execpath: process.execPath,
    npm_command: "exec",
    npm_config_user_agent: `bun/${Bun.version}`,
  });
  await mkdir(bunInstallRoot, { recursive: true });
  await mkdir(bunTempRoot, { recursive: true });
  bunEnvironment["PATH"] = [join(bunInstallRoot, "bin"), bunEnvironment["PATH"]]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(delimiter);
  await runChecked(["bun", "install", "--no-save", "--ignore-scripts", "--no-progress"], {
    cwd: installedRoot,
    env: bunEnvironment,
  });

  const installedPackageRoot = join(installedRoot, "node_modules/holycodex");
  const installedEntry = join(installedPackageRoot, "dist/index.js");
  const installedAgentEntry = join(installedPackageRoot, "dist/agent.js");
  await requireFile(installedEntry, "the installed package entry point");
  await requireFile(installedAgentEntry, "the installed agent CLI entry point");
  await requireFile(
    join(installedPackageRoot, "dist/assets/plugin/plugin.json"),
    "the installed plugin payload source",
  );
  for (const relativePath of [
    "skills/plan/SKILL.md",
    "skills/grill-me/SKILL.md",
    "skills/writing-instructions/SKILL.md",
    "skills/babysit-ci/SKILL.md",
  ]) {
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
  await runInstalledOpenTuiProbe(installedRoot, installedEntry, commands, bunEnvironment);
  const stateRoot = join(codexHome, "holycodex");
  await mkdir(codexHome, { recursive: true });
  const unrelatedConfig =
    '[features]\ncontext_management = true\nunrelated = "keep"\n\napproval_policy = "on-request"\n';
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
    npm_execpath: process.execPath,
    npm_command: "exec",
    npm_config_user_agent: `bun/${Bun.version}`,
  });
  const installedModule = (await import(pathToFileURL(installedEntry).href)) as InstalledCliModule;
  verifyPublishedRouting(installedModule);
  await verifyPreviousStableUpgrade({
    temporaryRoot,
    currentCanonicalVersion: packed.canonicalVersion,
    currentVersion: packed.packageVersion,
    currentInstalledRoot: installedRoot,
    currentInstalledPackageRoot: installedPackageRoot,
    currentEntry: installedEntry,
    codexCliVersion: resolvedCodexCliVersion,
    bunEnvironment,
    commands,
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
  const removedUpgrade = await runCliResult(
    installedEntry,
    ["upgrade", "--json"],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(
    removedUpgrade.exitCode === 1 &&
      !removedUpgrade.envelope.ok &&
      removedUpgrade.envelope.error.code === "unknown_command",
    "the packed public CLI must reject the removed upgrade command",
  );

  await runInstalledAgentHelp(installedAgentEntry, installedRoot, commands);

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
    [
      "install",
      "--yes",
      "--json",
      "--profile",
      "high",
      "--tier",
      "fast-all",
      "--add-plugin",
      ADDITIONAL_FIXTURE_PLUGIN,
      "--codex-home",
      codexHome,
    ],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(installEnvelope.ok, "packed package install failed");
  const activeRecordPath = join(stateRoot, "active.json");
  const activeRecord = decode(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    JSON.parse(await readFile(activeRecordPath, "utf8")),
    "the active installation record",
  );
  assert(
    activeRecord["profile"] === "high" &&
      activeRecord["tier"] === "fast-all" &&
      activeRecord["plan"] === undefined &&
      arrayProperty(activeRecord, "official_plugins")?.includes(ADDITIONAL_FIXTURE_PLUGIN) === true,
    "the active installation record must use the current profile field",
  );
  const selections = objectProperty(activeRecord, "optional_selections");
  assert(
    selections?.["computer_use"] === false &&
      selections["frontend"] === true &&
      selections["security"] === true &&
      selections["coding"] === true &&
      !Object.prototype.hasOwnProperty.call(selections, "work"),
    "the packed install record must retain the current optional capability selections",
  );
  const capabilityState = objectProperty(activeRecord, "capability_state");
  for (const [name, selected, status] of [
    ["computer_use", false, "disabled"],
    ["frontend", true, "healthy"],
    ["security", true, "healthy"],
  ] as const) {
    const state = objectProperty(capabilityState, name);
    assert(
      state?.["selected"] === selected &&
        state["status"] === status &&
        Array.isArray(state["plugin_ids"]),
      `the packed install record must include the ${name} capability state`,
    );
  }
  await assertPersistedContext7(
    activeRecord,
    installedRoot,
    bunEnvironment,
    commands,
    "packed install",
  );
  const managedConfigText = await readFile(join(codexHome, "config.toml"), "utf8");
  const managedConfig = parseConfig(managedConfigText);
  const managedRootInstructions = readTomlPath(managedConfig, "developer_instructions");
  const normalizedRootInstructions =
    typeof managedRootInstructions === "string" ? managedRootInstructions.toLowerCase() : "";
  assert(
    readTomlPath(managedConfig, "model") === "gpt-6-astra" &&
      managedConfigText.includes("context_management = true") &&
      !managedConfigText.includes("experimental_mode") &&
      !/\b(?:Sol|Terra)\b/u.test(managedConfigText),
    "the managed Codex configuration must use Astra and canonical scalar context management",
  );
  assert(
    typeof managedRootInstructions === "string" &&
      managedRootInstructions.includes("Dispatch every delegable action as a bounded Assignment") &&
      normalizedRootInstructions.includes("exact concrete registered role.task agent_type") &&
      ["explorer", "librarian", "worker", "reviewer", "labels"].every((term) =>
        normalizedRootInstructions.includes(term),
      ) &&
      normalizedRootInstructions.includes(
        "generic built-in agent_type values worker, explorer, reviewer, librarian are forbidden",
      ),
    "the packed high-profile Root configuration must preserve Astra-specific exact specialist dispatch",
  );
  const fixedPointReviewPosition = normalizedRootInstructions.indexOf(
    "reviewer.code reaches a fixed point",
  );
  const validationPosition = normalizedRootInstructions.indexOf("worker.validation runs");
  const integrationPosition = normalizedRootInstructions.indexOf("then root integrates");
  assert(
    fixedPointReviewPosition >= 0 &&
      validationPosition > fixedPointReviewPosition &&
      integrationPosition > validationPosition,
    "the packed high-profile Root configuration must place validation after fixed-point review",
  );
  if (process.platform === "win32") {
    const tooling = objectProperty(activeRecord, "tooling");
    const gitBash = objectProperty(tooling, "git_bash");
    assert(
      gitBash?.["status"] === "healthy" &&
        typeof gitBash["path"] === "string" &&
        /[\\/]bash\.exe$/iu.test(gitBash["path"]),
      "the packed Windows install record must retain a verified Git Bash executable",
    );
    assert(
      typeof managedRootInstructions === "string" &&
        managedRootInstructions.includes(windowsGitBashShellDirective(gitBash["path"] as string)),
      "the packed Windows Root configuration must project the verified Git Bash boundary",
    );
  }

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
  assert(
    pluginListEnvelope.installed.some((entry) => entry.pluginId === ADDITIONAL_FIXTURE_PLUGIN),
    "Codex plugin list did not report the explicitly selected additional plugin",
  );
  const installedPluginRoot = join(codexHome, "plugins/holycodex");
  for (const relativePath of [
    ".codex-plugin/plugin.json",
    "skills/plan/SKILL.md",
    "skills/grill-me/SKILL.md",
    "skills/writing-instructions/SKILL.md",
    "skills/babysit-ci/SKILL.md",
  ]) {
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
    installedPluginManifest.version === packed.canonicalVersion,
    "installed Codex plugin manifest version is not canonical",
  );
  const writingInstructions = await readFile(
    join(installedPluginRoot, "skills/writing-instructions/SKILL.md"),
    "utf8",
  );
  assert(
    !/GPT-5\.6|\b(?:Luna|Sol|Terra)\b|writing-for-agents|load before first dispatch|reload when lost|reuse while/iu.test(
      writingInstructions,
    ),
    "writing-instructions must target GPT-6 without obsolete context-residency rituals",
  );
  assert(
    !(await exists(join(installedPluginRoot, "skills/writing-for-agents"))),
    "the retired instruction skill alias must not ship",
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

  const currentUpgrade = await runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
  assert(currentUpgrade.ok, "packed package current upgrade command failed");
  if (currentUpgrade.ok) {
    assert(
      hasProperty(currentUpgrade.data, "status") && currentUpgrade.data["status"] === "current",
      "already-current upgrade must report current",
    );
  }

  const beforeCancellationConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  const beforeCancellationRecord = await readFile(activeRecordPath, "utf8");
  const cancelled = (await installedModule.runCli(["remove", "--codex-home", codexHome], {
    env: codexEnvironment,
    io: {
      stdoutIsTTY: true,
      stderrIsTTY: true,
      confirm: async () => "cancelled",
    },
  })) as { readonly envelope: typeof CliEnvelopeSchema.Type; readonly exitCode: number };
  assert(cancelled.exitCode === 0, "interactive remove cancellation must succeed");
  assert(cancelled.envelope.ok, "interactive remove cancellation must return success");
  if (cancelled.envelope.ok) {
    assert(
      hasProperty(cancelled.envelope.data, "cancelled") &&
        cancelled.envelope.data["cancelled"] === true,
      "interactive remove cancellation must be explicit",
    );
  }
  assert(
    (await readFile(join(codexHome, "config.toml"), "utf8")) === beforeCancellationConfig &&
      (await readFile(activeRecordPath, "utf8")) === beforeCancellationRecord,
    "interactive remove cancellation must not mutate the installation",
  );

  await rewriteActiveRecord(activeRecordPath, installedModule, (record) =>
    rewriteForLegacyContext(record, previousPatchVersion(version)),
  );
  const currentConfigForLegacy = await readFile(join(codexHome, "config.toml"), "utf8");
  const legacyConfig = currentConfigForLegacy
    .replace("context_management = true\n", "")
    .replace(
      '[agents."Explorer.lookup"]',
      '[features.context_management]\nexperimental_mode = true\n\n[agents."Explorer.lookup"]',
    );
  assert(
    legacyConfig !== currentConfigForLegacy,
    "legacy fixture could not locate the canonical context-management setting",
  );
  await writeFile(join(codexHome, "config.toml"), legacyConfig, {
    encoding: "utf8",
    mode: 0o600,
  });
  const dryRunBeforeConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  const dryRunBeforeRecord = await readFile(activeRecordPath, "utf8");
  const dryRun = await runInternalUpgrade(installedEntry, codexHome, codexEnvironment, true);
  assert(dryRun.ok, "packed package upgrade dry-run failed");
  if (dryRun.ok) {
    assert(
      hasProperty(dryRun.data, "status") && dryRun.data["status"] === "dry_run",
      "upgrade dry-run must report dry_run",
    );
    assert(
      hasProperty(dryRun.data, "changes") &&
        arrayProperty(dryRun.data, "changes")?.includes(
          "context-management configuration migration",
        ) === true,
      "upgrade dry-run must report legacy context migration",
    );
  }
  assert(
    (await readFile(join(codexHome, "config.toml"), "utf8")) === dryRunBeforeConfig &&
      (await readFile(activeRecordPath, "utf8")) === dryRunBeforeRecord,
    "upgrade dry-run must not mutate state",
  );
  const upgraded = await runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
  assert(upgraded.ok, "packed package legacy upgrade failed");
  if (upgraded.ok) {
    assert(
      hasProperty(upgraded.data, "status") && upgraded.data["status"] === "upgraded",
      "legacy upgrade must report upgraded",
    );
    const upgradedRecord = objectProperty(upgraded.data, "record");
    assert(
      upgradedRecord?.["profile"] === "high" &&
        upgradedRecord["tier"] === "fast-all" &&
        arrayProperty(upgradedRecord, "official_plugins")?.includes(ADDITIONAL_FIXTURE_PLUGIN) ===
          true,
      "upgrade must preserve profile, tier, and additional plugin selection",
    );
  }
  const migratedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(
    migratedConfig.includes("context_management = true") &&
      !migratedConfig.includes("experimental_mode") &&
      migratedConfig.includes('unrelated = "keep"'),
    "legacy upgrade must migrate the scalar context setting and preserve unrelated config",
  );
  await assertCodexAppServerReadback(
    codexFixture.executable,
    codexEnvironment,
    codexHome,
    resolvedCodexCliVersion,
  );

  await rewriteActiveRecord(activeRecordPath, installedModule, (record) => ({
    ...record,
    version: nextPatchVersion(version),
  }));
  const downgrade = await runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
  assert(!downgrade.ok, "downgrade upgrade must fail");
  assert(
    !downgrade.ok && downgrade.error.code === "upgrade_downgrade",
    "downgrade upgrade must return a semantic refusal",
  );
  await rewriteActiveRecord(activeRecordPath, installedModule, (record) => ({
    ...record,
    version: packed.baseVersion,
  }));

  for (const [name, status] of [
    ["preparing", "preparing"],
    ["conflicted", "conflicted"],
  ] as const) {
    const current = JSON.parse(await readFile(activeRecordPath, "utf8")) as Record<string, unknown>;
    await writeJson(join(stateRoot, `${name}.json`), {
      ...current,
      status,
      step: status === "preparing" ? "validated" : "conflicted",
    });
    const recovered = await runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
    assert(recovered.ok, `${name} transaction recovery failed`);
    assert(
      !(await exists(join(stateRoot, `${name}.json`))),
      `${name} transaction state must be cleared after recovery`,
    );
  }

  const notInstalledHome = join(temporaryRoot, "not-installed-codex-home");
  const notInstalled = await runInternalUpgrade(installedEntry, notInstalledHome, {
    ...codexEnvironment,
    CODEX_HOME: notInstalledHome,
  });
  assert(
    !notInstalled.ok && notInstalled.error.code === "not_installed",
    "upgrade without an installation must return not_installed",
  );

  const incompatibleHome = join(temporaryRoot, "incompatible-codex-home");
  await mkdir(incompatibleHome, { recursive: true });
  await writeFile(
    join(incompatibleHome, "config.toml"),
    '[features.context_management]\nexperimental_mode = false\nunrelated = "keep"\n',
    { encoding: "utf8", mode: 0o600 },
  );
  const incompatibleEvents: string[] = [];
  const incompatible = (await installedModule.runCli(
    ["install", "--yes", "--codex-home", incompatibleHome],
    {
      env: { ...codexEnvironment, CODEX_HOME: incompatibleHome },
      io: {
        stdoutIsTTY: true,
        stderrIsTTY: true,
        writeStderr: (message: string) => incompatibleEvents.push(message),
      },
    },
  )) as { readonly envelope: typeof CliEnvelopeSchema.Type; readonly exitCode: number };
  assert(incompatible.exitCode !== 0, "incompatible config install must fail");
  assert(
    !incompatible.envelope.ok && incompatible.envelope.error.code === "state_corrupt",
    "incompatible config install must return a semantic error",
  );
  assert(
    incompatibleEvents.some((message) => message.includes("Validating Codex target")) &&
      !incompatibleEvents.some((message) => message.includes("Installing subagent roles")),
    "failed install progress must stop at the real validation boundary",
  );

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
  const removedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(
    removedConfig.includes("context_management = true") &&
      removedConfig.includes('unrelated = "keep"') &&
      removedConfig.includes('approval_policy = "on-request"'),
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
  assert(
    !afterRemove.installed.some((entry) => entry.pluginId === ADDITIONAL_FIXTURE_PLUGIN),
    "remove retained the explicitly selected additional plugin",
  );
  const repeatedRemove = await runCli(
    installedEntry,
    ["remove", "--yes", "--json", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(repeatedRemove.ok, "repeated remove command failed");
  if (repeatedRemove.ok) {
    assert(
      hasProperty(repeatedRemove.data, "removed") &&
        Array.isArray(repeatedRemove.data["removed"]) &&
        repeatedRemove.data["removed"].length === 0,
      "repeated remove must report zero removed items",
    );
  }
  const repeatedRemovedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(
    repeatedRemovedConfig.includes("context_management = true") &&
      repeatedRemovedConfig.includes('unrelated = "keep"') &&
      repeatedRemovedConfig.includes('approval_policy = "on-request"'),
    "repeated remove must preserve unrelated Codex configuration",
  );
  const nonTtyRemove = await runCliResult(
    installedEntry,
    ["remove", "--json", "--codex-home", codexHome],
    installedRoot,
    commands,
    codexEnvironment,
  );
  assert(
    !nonTtyRemove.envelope.ok &&
      nonTtyRemove.envelope.error.code === "non_tty_confirmation_required",
    "non-TTY remove without --yes must return the confirmation error",
  );
  return {
    packageVersion: version,
    tarball: packed.tarball,
    tarballSha256: packed.tarballSha256,
    entries: packed.entries,
    commands,
  };
}

/** Assert that a package tarball contains exactly the expected entries. */
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

/** Compute the SHA-256 digest of a regular file. */
export async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Pack and verify the public package using the current generated Codex bindings. */
export async function runPackageVerification(): Promise<PackageVerificationResult> {
  return await withTemporaryDirectory("holycodex-package-verification", async (temporaryRoot) => {
    const generated = await ensureCodexGenerated();
    const packed = await packPublicPackage(temporaryRoot);
    return await verifyPublicPackage(packed, generated.codexCliVersion);
  });
}

async function verifyPreviousStableUpgrade(options: {
  readonly temporaryRoot: string;
  readonly currentCanonicalVersion: string;
  readonly currentVersion: string;
  readonly currentInstalledRoot: string;
  readonly currentInstalledPackageRoot: string;
  readonly currentEntry: string;
  readonly codexCliVersion: string;
  readonly bunEnvironment: Readonly<Record<string, string | undefined>>;
  readonly commands: string[];
}): Promise<void> {
  const previousVersion = previousPatchVersion(options.currentVersion);
  const previousInstalledRoot = join(options.temporaryRoot, "previous-installed");
  await mkdir(previousInstalledRoot, { recursive: true });
  const previousBunStateRoot = join(options.temporaryRoot, "previous-bun-state");
  const previousBunInstallRoot = join(previousBunStateRoot, "install");
  const previousBunTempRoot = join(previousBunStateRoot, "tmp");
  const previousBunEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    BUN_INSTALL: previousBunInstallRoot,
    BUN_TMPDIR: previousBunTempRoot,
    TEMP: previousBunTempRoot,
    TMP: previousBunTempRoot,
    TMPDIR: previousBunTempRoot,
    npm_execpath: process.execPath,
    npm_command: "exec",
    npm_config_user_agent: `bun/${Bun.version}`,
  });
  await mkdir(previousBunInstallRoot, { recursive: true });
  await mkdir(previousBunTempRoot, { recursive: true });
  previousBunEnvironment["PATH"] = [
    join(previousBunInstallRoot, "bin"),
    options.bunEnvironment["PATH"],
  ]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(delimiter);
  await writeJson(join(previousInstalledRoot, "package.json"), {
    name: "holycodex-previous-stable-verification",
    private: true,
    type: "module",
    dependencies: { holycodex: previousVersion },
  });
  const installCommand = ["bun", "install", "--ignore-scripts", "--no-progress"];
  options.commands.push(`${installCommand.join(" ")} (${previousVersion})`);
  await runChecked(installCommand, {
    cwd: previousInstalledRoot,
    env: previousBunEnvironment,
  });

  const previousPackageRoot = join(previousInstalledRoot, "node_modules/holycodex");
  const previousManifest = await readInstalledManifest(join(previousPackageRoot, "package.json"));
  assert(previousManifest.version === previousVersion, "the previous package version is not exact");
  assert(
    previousManifest.release?.channel === "stable" &&
      previousManifest.release.sourceSha === PREVIOUS_STABLE_SOURCE_SHA,
    "the previous package does not have the expected stable source identity",
  );
  const previousEntry = join(previousPackageRoot, "dist/index.js");
  const previousAgentEntry = join(previousPackageRoot, "dist/agent.js");
  assert(
    (await sha256File(previousEntry)) === PREVIOUS_STABLE_CLI_SHA256,
    "the previous stable CLI bytes do not match the published fixture identity",
  );
  assert(
    (await sha256File(previousAgentEntry)) === PREVIOUS_STABLE_AGENT_SHA256,
    "the previous stable agent bytes do not match the published fixture identity",
  );

  const proofRoot = join(options.temporaryRoot, "previous-upgrade-proof");
  const codexHome = join(proofRoot, "codex-home");
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    '[features]\nunrelated = "keep"\n\napproval_policy = "on-request"\n',
    { encoding: "utf8", mode: 0o600 },
  );
  const fixturePluginSource = join(codexHome, "fixture-plugin-source");
  await stageFixturePlugin(previousPackageRoot, fixturePluginSource);
  const codexFixture = await createCodexFixture(codexHome, options.codexCliVersion);
  const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
    CODEX_HOME: codexHome,
    PATH: [
      codexFixture.binDirectory,
      join(workspaceRoot, "node_modules/.bin"),
      previousBunEnvironment["PATH"],
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter),
    BUN_INSTALL: previousBunEnvironment["BUN_INSTALL"],
    BUN_TMPDIR: previousBunEnvironment["BUN_TMPDIR"],
    TEMP: previousBunEnvironment["TEMP"],
    TMP: previousBunEnvironment["TMP"],
    TMPDIR: previousBunEnvironment["TMPDIR"],
    npm_execpath: process.execPath,
    npm_command: "exec",
    npm_config_user_agent: `bun/${Bun.version}`,
    HOLYCODEX_DEBUG_INSTALLER: "1",
  });

  const previousInstall = await runCli(
    previousEntry,
    [
      "install",
      "--yes",
      "--json",
      "--profile",
      "high",
      "--tier",
      "fast-all",
      ...LEGACY_WORK_PROVIDER_PLUGINS.flatMap((pluginId) => ["--add-plugin", pluginId]),
      "--add-plugin",
      ADDITIONAL_FIXTURE_PLUGIN,
      "--codex-home",
      codexHome,
    ],
    previousInstalledRoot,
    options.commands,
    environment,
  );
  assert(previousInstall.ok, "the previous stable package install failed");
  const activeRecordPath = join(codexHome, "holycodex/active.json");
  const previousModule = (await import(pathToFileURL(previousEntry).href)) as InstalledCliModule;
  await rewriteActiveRecord(activeRecordPath, previousModule, rewriteForLegacyWork);
  const previousRecord = JSON.parse(await readFile(activeRecordPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert(previousRecord["version"] === previousVersion, "the previous install record is not exact");
  assert(
    objectProperty(previousRecord, "optional_selections")?.["work"] === true,
    "the previous package did not install the legacy Work capability",
  );

  await rm(fixturePluginSource, { recursive: true, force: true });
  await stageFixturePlugin(options.currentInstalledPackageRoot, fixturePluginSource);
  const beforeDryRun = await snapshotDirectoryBytes(codexHome);
  const dryRun = await runInternalUpgrade(options.currentEntry, codexHome, environment, true);
  assert(dryRun.ok, "the real previous-stable upgrade dry-run failed");
  if (dryRun.ok) {
    assert(
      hasProperty(dryRun.data, "status") && dryRun.data["status"] === "dry_run",
      "the real previous-stable upgrade dry-run did not report dry_run",
    );
  }
  assert(
    JSON.stringify(await snapshotDirectoryBytes(codexHome)) === JSON.stringify(beforeDryRun),
    "the real previous-stable upgrade dry-run changed isolated Codex-home bytes",
  );

  const upgraded = await runInternalUpgrade(options.currentEntry, codexHome, environment);
  assert(upgraded.ok, "the real previous-stable package upgrade failed");
  const upgradedRecord = JSON.parse(await readFile(activeRecordPath, "utf8")) as Record<
    string,
    unknown
  >;
  assert(
    upgradedRecord["version"] === options.currentVersion,
    "upgrade did not reach current version",
  );
  for (const key of [
    "optional_selections",
    "explicit_optional_selections",
    "capability_state",
  ] as const) {
    assert(
      !Object.prototype.hasOwnProperty.call(objectProperty(upgradedRecord, key) ?? {}, "work"),
      `upgrade retained legacy Work state in ${key}`,
    );
  }
  for (const key of ["official_plugins", "owned_plugins"] as const) {
    const plugins = arrayProperty(upgradedRecord, key) ?? [];
    assert(
      LEGACY_WORK_PROVIDER_PLUGINS.every((pluginId) => !plugins.includes(pluginId)),
      `upgrade retained legacy Work ownership in ${key}`,
    );
  }
  const tooling = objectProperty(upgradedRecord, "tooling");
  const context7 = objectProperty(tooling, "context7");
  assert(
    context7?.["manager"] === "bun" && context7["launcher"] === "bunx",
    "upgrade did not persist the injected Bun launcher identity for Context7",
  );
  await assertPersistedContext7(
    upgradedRecord,
    options.currentInstalledRoot,
    environment,
    options.commands,
    "previous stable upgrade",
  );
  const upgradedConfig = await readFile(join(codexHome, "config.toml"), "utf8");
  assert(
    upgradedConfig.includes("context_management = true") &&
      upgradedConfig.includes('unrelated = "keep"'),
    "upgrade did not publish canonical configuration while preserving unrelated config",
  );
  const pluginList = parseCodexPluginList(
    (
      await runChecked([codexFixture.executable, "plugin", "list", "--json"], {
        cwd: workspaceRoot,
        env: environment,
      })
    ).stdout,
  );
  assert(
    LEGACY_WORK_PROVIDER_PLUGINS.every((pluginId) =>
      pluginList.installed.some((entry) => entry.pluginId === pluginId),
    ),
    "upgrade removed shared plugins formerly selected through Work",
  );
  const installedPluginManifest = decode(
    InstalledPluginManifestSchema,
    JSON.parse(
      await readFile(join(codexHome, "plugins/holycodex/.codex-plugin/plugin.json"), "utf8"),
    ),
    "installed Codex plugin manifest",
  );
  assert(
    installedPluginManifest.version === options.currentCanonicalVersion,
    "upgrade did not publish the current HolyCodex plugin payload",
  );
  await assertCodexAppServerReadback(
    codexFixture.executable,
    environment,
    codexHome,
    options.codexCliVersion,
  );
  const doctor = await runCli(
    options.currentEntry,
    ["doctor", "--json", "--codex-home", codexHome],
    options.currentInstalledRoot,
    options.commands,
    environment,
  );
  assert(
    doctor.ok && hasProperty(doctor.data, "healthy") && doctor.data["healthy"] === true,
    "the real previous-stable upgrade did not end doctor-healthy",
  );

  if (options.currentVersion !== options.currentCanonicalVersion) {
    const currentModule = (await import(
      pathToFileURL(options.currentEntry).href
    )) as InstalledCliModule;
    await rewriteActiveRecord(activeRecordPath, currentModule, (record) => ({
      ...record,
      version: options.currentCanonicalVersion,
    }));
    const sameBaseReconciliation = await runInternalUpgrade(
      options.currentEntry,
      codexHome,
      environment,
    );
    assert(
      sameBaseReconciliation.ok &&
        sameBaseReconciliation.data["status"] === "upgraded" &&
        sameBaseReconciliation.data["from_version"] === options.currentCanonicalVersion &&
        sameBaseReconciliation.data["to_version"] === options.currentVersion,
      "a same-base development package must reconcile its stable install record",
    );
    const reconciledRecord = JSON.parse(await readFile(activeRecordPath, "utf8")) as Record<
      string,
      unknown
    >;
    assert(
      reconciledRecord["version"] === options.currentVersion,
      "same-base development reconciliation must record the running development artifact",
    );
  }
}

async function stageFixturePlugin(packageRoot: string, destination: string): Promise<void> {
  await cp(join(packageRoot, "dist/assets/plugin"), destination, {
    recursive: true,
    dereference: true,
  });
  await mkdir(join(destination, ".codex-plugin"), { recursive: true });
  await cp(join(destination, "plugin.json"), join(destination, ".codex-plugin/plugin.json"));
}

async function snapshotDirectoryBytes(
  root: string,
): Promise<readonly (readonly [string, string])[]> {
  const entries = await listPackageEntries(root);
  return await Promise.all(
    entries.map(
      async (entry) =>
        [entry, Buffer.from(await readFile(join(root, entry))).toString("base64")] as const,
    ),
  );
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
  const result = await runCliResult(entry, args, cwd, commands, environment);
  assert(
    result.exitCode === 0,
    `CLI command ${["bun", entry, ...args].join(" ")} failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
  );
  return result.envelope;
}

async function runCliResult(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>> = allowlistedEnvironment(
    DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  ),
): Promise<{
  readonly envelope: typeof CliEnvelopeSchema.Type;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const command = ["bun", entry, ...args];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: environment });
  return {
    envelope: parseEnvelope(result.stdout),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function rewriteActiveRecord(
  path: string,
  installedModule: InstalledCliModule,
  rewrite: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const rewritten = rewrite(current);
  const digestKeys = [
    "owner",
    "install_id",
    "version",
    "profile",
    "plan",
    "tier",
    "optional_selections",
    "explicit_optional_selections",
    "official_plugins",
    "capability_state",
    "managed_artifacts",
    "managed_config",
    "plugin_config",
    "provider_config",
    "plugin_snapshot",
    "owned_plugins",
    "tooling",
  ] as const;
  const digestInput = Object.fromEntries(
    digestKeys.flatMap((key) => (key in rewritten ? [[key, rewritten[key]] as const] : [])),
  );
  await writeJson(path, {
    ...rewritten,
    digest: await installedModule.installRecordDigest(digestInput),
  });
}

function rewriteForLegacyContext(
  record: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const managedConfig = objectProperty(record, "managed_config");
  const managed = objectProperty(managedConfig, "managed");
  const scalar = objectProperty(managed, "features.context_management");
  if (managedConfig === undefined || managed === undefined || scalar === undefined) {
    throw new Error("the active record does not contain scalar context-management ownership");
  }
  const legacy = {
    ...scalar,
    keyPath: "features.context_management.experimental_mode",
  };
  const nextManaged = { ...managed };
  delete nextManaged["features.context_management"];
  nextManaged["features.context_management.experimental_mode"] = legacy;
  return {
    ...record,
    version,
    managed_config: { ...managedConfig, managed: nextManaged },
  };
}

function rewriteForLegacyWork(record: Record<string, unknown>): Record<string, unknown> {
  const optionalSelections = objectProperty(record, "optional_selections");
  const explicitOptionalSelections = objectProperty(record, "explicit_optional_selections");
  const capabilityState = objectProperty(record, "capability_state");
  const officialPlugins = arrayProperty(record, "official_plugins") ?? [];
  const ownedPlugins = arrayProperty(record, "owned_plugins") ?? [];
  return {
    ...record,
    optional_selections: { ...optionalSelections, work: true },
    explicit_optional_selections: { ...explicitOptionalSelections, work: true },
    capability_state: {
      ...capabilityState,
      work: {
        selected: true,
        status: "healthy",
        plugin_ids: [...LEGACY_WORK_PROVIDER_PLUGINS],
      },
    },
    official_plugins: [...new Set([...officialPlugins, ...LEGACY_WORK_PROVIDER_PLUGINS])],
    owned_plugins: [...new Set([...ownedPlugins, ...LEGACY_WORK_PROVIDER_PLUGINS])],
  };
}

function previousPatchVersion(version: string): string {
  const [major, minor, patch] = baseVersionFromRelease(version).split(".");
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("the canonical package version is not a three-part number");
  }
  const patchNumber = BigInt(patch);
  return `${major}.${minor}.${patchNumber > 0n ? patchNumber - 1n : 0n}`;
}

function nextPatchVersion(version: string): string {
  const [major, minor, patch] = baseVersionFromRelease(version).split(".");
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error("the canonical package version is not a three-part number");
  }
  return `${major}.${minor}.${BigInt(patch) + 1n}`;
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

async function runInstalledAgentHelp(
  entry: string,
  cwd: string,
  commands: string[],
): Promise<void> {
  const helpPaths: readonly (readonly string[])[] = [
    [],
    ["intent"],
    ["intent", "create"],
    ["intent", "list"],
    ["intent", "current"],
    ["intent", "read"],
    ["intent", "select"],
    ["intent", "transition"],
    ["intent", "evidence"],
    ["intent", "complete"],
    ["intent", "abandon"],
    ["plan"],
    ["plan", "read"],
    ["plan", "revise"],
    ["assignment"],
    ["assignment", "create"],
    ["assignment", "list"],
    ["assignment", "read"],
    ["assignment", "start"],
    ["assignment", "result"],
  ];
  const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS);
  for (const path of helpPaths) {
    for (const option of ["-h", "--help"] as const) {
      const args = [...path, option];
      const command = ["bun", entry, ...args];
      commands.push(command.join(" "));
      const result = await runCommand(command, { cwd, env: environment });
      assert(
        result.exitCode === 0,
        `agent CLI help failed for ${args.join(" ")} with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
      );
      assert(result.stderr.length === 0, "agent CLI help wrote diagnostics to stderr");
      assert(!result.stdout.includes("\u001b"), "agent CLI help emitted ANSI");
      assert(result.stdout.includes("holycodex-agent"), "agent CLI help omitted its command name");
    }
  }
}

async function runInstalledOpenTuiProbe(
  cwd: string,
  entry: string,
  commands: string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const command = [process.execPath, "-e", 'await import("@opentui/core");'];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env });

  assert(
    result.exitCode === 0,
    `installed OpenTUI runtime could not resolve: ${redactDiagnostics(result.stderr || result.stdout, env)}`,
  );
  assert(result.stderr.length === 0, "installed OpenTUI runtime wrote diagnostics to stderr");

  const interactive = await runInstalledOpenTuiBehaviorProbe(cwd, entry, env);
  assert(interactive.exitCode === 0, "installed OpenTUI wizard behavior probe failed");
  assert(
    interactive.stderr.length === 0,
    `installed OpenTUI wizard behavior probe wrote diagnostics: ${interactive.stderr.slice(0, 512)}`,
  );

  const probeMarker = "__HOLYCODEX_OPENTUI_PROBE__";
  const markerIndex = interactive.stdout.lastIndexOf(probeMarker);
  assert(markerIndex >= 0, "installed OpenTUI wizard behavior probe omitted its result");

  const probePayload = interactive.stdout
    .slice(markerIndex + probeMarker.length)
    .split(/\r?\n/u, 1)[0];
  assert(
    probePayload !== undefined && probePayload.length > 0,
    "installed OpenTUI wizard behavior probe emitted an empty result",
  );

  const probe = JSON.parse(probePayload) as Record<string, unknown>;
  assert(probe["result"] === "cancel", "installed OpenTUI wizard did not support cancellation");
  assert(probe["review"] === true, "installed OpenTUI wizard did not reach review after Enter");
  assert(
    probe["tier"] === "fast",
    "installed OpenTUI wizard arrows did not change the service tier",
  );
  assert(
    probe["frontend"] === "disabled",
    "installed OpenTUI wizard Space did not toggle Frontend",
  );
  assert(probe["hints"] === true, "installed OpenTUI wizard omitted its navigation hints");
  assert(probe["noColor"] === true, "installed OpenTUI wizard ignored NO_COLOR");
}

async function runInstalledOpenTuiBehaviorProbe(
  cwd: string,
  entry: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const source = String.raw`
import { PassThrough, Writable } from "node:stream";
const realStdout = process.stdout;
const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => input;
const outputChunks = [];
let outputVersion = 0;
let outputWaiter;
const output = new Writable({
  write(chunk, _encoding, callback) {
    const bytes = Buffer.from(chunk);
    outputChunks.push(bytes);
    consumeOutput(bytes);
    outputVersion += 1;
    outputWaiter?.();
    outputWaiter = undefined;
    callback();
  },
});
output.isTTY = true;
output.columns = 100;
output.rows = 30;
const { runOpenTuiInstallWizard } = await import(${JSON.stringify(entry)});
const screen = Array.from({ length: output.rows }, () => Array(output.columns).fill(" "));
let screenRow = 0;
let screenColumn = 0;
let savedScreenRow = 0;
let savedScreenColumn = 0;
let parserState = "text";
let sequence = "";
const decoder = new TextDecoder();
const consumeOutput = (chunk) => {
  for (const character of decoder.decode(chunk, { stream: true })) {
    if (parserState === "text") {
      if (character === "\x1b") parserState = "escape";
      else if (character === "\r") screenColumn = 0;
      else if (character === "\n") screenRow = Math.min(screen.length - 1, screenRow + 1);
      else if (character === "\b") screenColumn = Math.max(0, screenColumn - 1);
      else if (character >= " " && character !== "\x7f") {
        if (screenRow >= 0 && screenRow < screen.length && screenColumn < output.columns) {
          screen[screenRow]![screenColumn] = character;
        }
        screenColumn += 1;
        if (screenColumn >= output.columns) {
          screenColumn = 0;
          screenRow = Math.min(screen.length - 1, screenRow + 1);
        }
      }
      continue;
    }
    if (parserState === "escape") {
      if (character === "[") {
        parserState = "csi";
        sequence = "";
      } else if (character === "]") {
        parserState = "osc";
      } else if (character === "P") {
        parserState = "dcs";
      } else if (character === "7") {
        savedScreenRow = screenRow;
        savedScreenColumn = screenColumn;
        parserState = "text";
      } else if (character === "8") {
        screenRow = savedScreenRow;
        screenColumn = savedScreenColumn;
        parserState = "text";
      } else {
        parserState = "text";
      }
      continue;
    }
    if (parserState === "osc" || parserState === "dcs") {
      if (character === "\x07") {
        parserState = "text";
      } else if (character === "\x1b") {
        parserState = parserState === "osc" ? "osc-escape" : "dcs-escape";
      }
      continue;
    }
    if (parserState === "osc-escape" || parserState === "dcs-escape") {
      parserState = "text";
      continue;
    }
    sequence += character;
    if (character < "@" || character > "~") continue;
    const parameters = sequence.slice(0, -1).replace(/^[>?]/u, "").split(";");
    const value = (index) => {
      const parsed = Number.parseInt(parameters[index] ?? "", 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    };
    switch (character) {
      case "A":
        screenRow = Math.max(0, screenRow - value(0));
        break;
      case "B":
      case "e":
        screenRow = Math.min(screen.length - 1, screenRow + value(0));
        break;
      case "C":
      case "a":
        screenColumn = Math.min(output.columns - 1, screenColumn + value(0));
        break;
      case "D":
        screenColumn = Math.max(0, screenColumn - value(0));
        break;
      case "E":
        screenRow = Math.min(screen.length - 1, screenRow + value(0));
        screenColumn = 0;
        break;
      case "F":
        screenRow = Math.max(0, screenRow - value(0));
        screenColumn = 0;
        break;
      case "G":
      case "\`":
        screenColumn = Math.min(output.columns - 1, value(0) - 1);
        break;
      case "H":
      case "f":
        screenRow = Math.min(screen.length - 1, value(0) - 1);
        screenColumn = Math.min(output.columns - 1, value(1) - 1);
        break;
      case "d":
        screenRow = Math.min(screen.length - 1, value(0) - 1);
        break;
      case "J": {
        const mode = Number.parseInt(parameters[0] ?? "0", 10);
        if (mode === 2 || mode === 3) {
          for (const line of screen) line.fill(" ");
        } else if (mode === 0) {
          screen[screenRow]!.fill(" ", screenColumn);
          for (let index = screenRow + 1; index < screen.length; index += 1) {
            screen[index]!.fill(" ");
          }
        }
        break;
      }
      case "K":
        screen[screenRow]!.fill(" ", screenColumn);
        break;
      case "s":
        savedScreenRow = screenRow;
        savedScreenColumn = screenColumn;
        break;
      case "u":
        screenRow = savedScreenRow;
        screenColumn = savedScreenColumn;
        break;
    }
    parserState = "text";
    sequence = "";
  }
};
const visibleOutput = () => screen.map((line) => line.join("")).join("\n");
const currentOutput = () => Buffer.concat(outputChunks).toString("utf8");
const configurationHint =
  "↑/↓ focus   ←/→ change choice   Space toggle   Enter review   Esc cancel";
const reviewHint = "↑/↓ choose   Enter confirm   Esc back";
const waitForOutput = async (afterVersion) => {
  while (outputVersion <= afterVersion) {
    await new Promise((resolve) => {
      outputWaiter = resolve;
      if (outputVersion > afterVersion) {
        outputWaiter = undefined;
        resolve();
      }
    });
  }
};
const waitForText = async (text) => {
  while (!currentOutput().includes(text)) {
    await waitForOutput(outputVersion);
  }
};
const pushUntilVisible = async (key, predicate) => {
  input.push(key);
  while (!predicate()) {
    await waitForOutput(outputVersion);
  }
};
const wizard = runOpenTuiInstallWizard({}, { stdin: input, stdout: output });

await waitForText("HolyCodex  ·  install");
await waitForText(configurationHint);
await pushUntilVisible("\x1b[B", () => visibleOutput().includes("❯ Service tier"));
await pushUntilVisible("\x1b[C", () => /Service tier\s+fast/u.test(visibleOutput()));
await pushUntilVisible("\x1b[B", () => visibleOutput().includes("❯ Frontend"));
await pushUntilVisible(" ", () => /Frontend\s+\[ \] disabled/u.test(visibleOutput()));
await pushUntilVisible(
  "\r",
  () => visibleOutput().includes("Review configuration") && visibleOutput().includes(reviewHint),
);
await pushUntilVisible("\x1b", () => visibleOutput().includes("❯ Frontend"));
await pushUntilVisible(
  "\r",
  () => visibleOutput().includes("Review configuration") && visibleOutput().includes(reviewHint),
);
await pushUntilVisible("\x1b[B", () => visibleOutput().includes("› Change options / Redo"));
await pushUntilVisible("\x1b[B", () => visibleOutput().includes("› Cancel"));
input.push("\r");

const result = await wizard;
const rendered = currentOutput();
const visible = visibleOutput();
realStdout.write(
  "__HOLYCODEX_OPENTUI_PROBE__" +
    JSON.stringify({
      result: result.action,
      review: visible.includes("Review configuration"),
      tier: visible.match(/Service tier:\s+(\S+)/u)?.[1],
      frontend: visible.match(/Frontend:\s+(\S+)/u)?.[1],
      hints: currentOutput().includes(configurationHint) && visible.includes(reviewHint),
      noColor: !/\x1b\[(?:1|2|36|1;36|32|33|31)m/u.test(rendered),
    }) +
    "\n",
);
`;
  const command = [process.execPath, "-e", source];
  const result = Bun.spawn(command, {
    cwd,
    env: { ...env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!(result.stdout instanceof ReadableStream) || !(result.stderr instanceof ReadableStream)) {
    throw new Error("the OpenTUI behavior probe did not expose bounded output streams");
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedStream(result.stdout, 256 * 1024),
    readBoundedStream(result.stderr, 256 * 1024),
    result.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error("OpenTUI behavior probe output exceeded its limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function assertPersistedContext7(
  record: Record<string, unknown>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  commands: string[],
  label: string,
): Promise<void> {
  assert(record["owner"] === "holycodex", `${label} record has the wrong installation owner`);
  const context7 = objectProperty(objectProperty(record, "tooling"), "context7");
  assert(context7 !== undefined, `${label} did not persist Context7 tooling state`);
  assert(
    context7["manager"] === "bun" && context7["launcher"] === "bunx",
    `${label} did not persist the Bun Context7 manager and launcher`,
  );
  assert(
    context7["ownership"] === "holycodex",
    `${label} did not persist HolyCodex Context7 ownership`,
  );
  assert(
    typeof context7["version"] === "string" &&
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(context7["version"]),
    `${label} did not persist a resolved Context7 version`,
  );
  assert(
    typeof context7["executable"] === "string" && context7["executable"].length > 0,
    `${label} did not persist the resolved Context7 executable`,
  );
  const version = context7["version"];
  const executable = context7["executable"];
  assert(typeof version === "string", `${label} Context7 version was lost during verification`);
  assert(
    typeof executable === "string",
    `${label} Context7 executable was lost during verification`,
  );
  const command = [executable, "--version"];
  commands.push(command.join(" "));
  const result = await runCommand(command, { cwd, env: environment });
  assert(
    result.exitCode === 0 && result.stderr.length === 0,
    `${label} Context7 executable could not be invoked: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
  );
  assert(
    result.stdout.includes(version),
    `${label} Context7 executable version does not match persisted state`,
  );
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
    assert(
      readback.config["model"] === "gpt-6-astra" &&
        readback.config["model_reasoning_effort"] === "high",
      "Codex App Server config readback changed the high-profile Root route",
    );
    const rootInstructions = readback.config["developer_instructions"];
    assert(
      typeof rootInstructions === "string" &&
        rootInstructions.toLowerCase().includes("bounded assignment") &&
        rootInstructions.toLowerCase().includes("exact concrete registered role.task agent_type"),
      "Codex App Server config readback changed the Astra-specific Root instruction projection",
    );
    if (process.platform === "win32") {
      const active = JSON.parse(
        await readFile(join(codexHome, "holycodex/active.json"), "utf8"),
      ) as {
        tooling?: { git_bash?: { path?: string } };
      };
      const verifiedShell = active.tooling?.git_bash?.path;
      assert(
        typeof verifiedShell === "string" &&
          typeof readback.config["developer_instructions"] === "string" &&
          readback.config["developer_instructions"].includes(
            windowsGitBashShellDirective(verifiedShell),
          ),
        "Codex App Server config readback changed the verified Git Bash executable",
      );
    }
    const agents = readback.config["agents"];
    assert(
      typeof agents === "object" && agents !== null && !Array.isArray(agents),
      "Codex App Server config readback omitted role registrations",
    );
    const agentTable = agents as Record<string, unknown>;
    const highProfile = PROFILE_CATALOG.find((profile) => profile.name === "high");
    assert(highProfile !== undefined, "the high profile is missing from the route catalog");
    for (const agentType of NATIVE_AGENT_TYPES) {
      const registration = agentTable[agentType];
      assert(
        typeof registration === "object" &&
          registration !== null &&
          !Array.isArray(registration) &&
          typeof (registration as Record<string, unknown>)["config_file"] === "string",
        `Codex App Server config readback omitted the ${agentType} registration`,
      );
      assert(
        typeof (registration as Record<string, unknown>)["name"] === "undefined",
        `Codex App Server config readback unexpectedly materialized ${agentType} metadata`,
      );
      const configuredPath = (registration as Record<string, string>)["config_file"]!;
      const readbackPath = isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(codexHome, configuredPath);
      const expectedPath = resolve(codexHome, "holycodex", "agents", `${agentType}.toml`);
      const comparableReadbackPath =
        process.platform === "win32" ? readbackPath.toLowerCase() : readbackPath;
      const comparableExpectedPath =
        process.platform === "win32" ? expectedPath.toLowerCase() : expectedPath;
      assert(
        comparableReadbackPath === comparableExpectedPath,
        `Codex App Server config readback resolved ${agentType} outside the installed role directory`,
      );
      const roleDocument = parseConfig(await readFile(readbackPath, "utf8"));
      const expectedRoute = highProfile.routes.find(
        (route) => `${route.role}.${route.task}` === agentType,
      );
      assert(expectedRoute !== undefined, `the high route catalog omitted ${agentType}`);
      assert(
        readTomlPath(roleDocument, "model") === "gpt-6-luna" &&
          readTomlPath(roleDocument, "model") === expectedRoute.model &&
          readTomlPath(roleDocument, "model_reasoning_effort") === expectedRoute.effort,
        `Codex App Server config readback changed the ${agentType} route TOML`,
      );
      if (process.platform === "win32") {
        const active = JSON.parse(
          await readFile(join(codexHome, "holycodex/active.json"), "utf8"),
        ) as { tooling?: { git_bash?: { path?: string } } };
        const verifiedShell = active.tooling?.git_bash?.path;
        const instructions = readTomlPath(roleDocument, "developer_instructions");
        assert(
          typeof verifiedShell === "string" &&
            typeof instructions === "string" &&
            instructions.includes(windowsGitBashShellDirective(verifiedShell)),
          `Codex App Server config readback changed the verified Git Bash boundary for ${agentType}`,
        );
      }
    }
  } catch (error: unknown) {
    const diagnostics = transport.diagnostics.join("; ");
    const configText = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => "");
    const shellIndex = configText.indexOf("developer_instructions");
    const configSnippet = configText
      .slice(shellIndex < 0 ? 0 : shellIndex, shellIndex < 0 ? 512 : shellIndex + 1024)
      .replaceAll(/\s+/gu, " ");
    const active = JSON.parse(await readFile(join(codexHome, "holycodex/active.json"), "utf8")) as {
      tooling?: { git_bash?: { path?: string } };
    };
    const verifiedShell = active.tooling?.git_bash?.path;
    const configProbe = `configShell=${verifiedShell !== undefined && configText.includes("On Windows, use Git for Windows Bash")} configDeveloper=${configText.includes("developer_instructions")} configSnippet=${configSnippet}`;
    const installerDebug = await readFile(join(codexHome, ".holycodex-debug.log"), "utf8").catch(
      () => "",
    );
    if (diagnostics.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} (${diagnostics}; ${configProbe}; ${installerDebug})`,
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} (${configProbe}; ${installerDebug})`,
    );
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
import { isAbsolute, join, resolve } from "node:path";

const HOME = process.env.CODEX_HOME;
const HOLY = "holycodex@holycodex";
const MARKETPLACE = "davidbasilefilho/holycodex";
const PROVIDERS = [
  "build-web-apps@openai-curated",
  "codex-security@openai-curated",
  "documents@openai-primary-runtime",
  "pdf@openai-primary-runtime",
  "presentations@openai-primary-runtime",
  "spreadsheets@openai-primary-runtime",
  "template-creator@openai-primary-runtime",
];
const ADDITIONAL = "additional@fixture";
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
    const known = new Set([HOLY, ...PROVIDERS, ADDITIONAL]);
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
      plugins: PROVIDERS.map((pluginId) => {
        const name = pluginId.slice(0, pluginId.lastIndexOf("@"));
        return { name, source: name };
      }),
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
  const visible = [
    ...PROVIDERS,
    ADDITIONAL,
    ...(state.marketplaces.includes(MARKETPLACE) ? [HOLY] : []),
  ];
  return {
    installed: state.installed.map((pluginId) => pluginEntry(pluginId, true)),
    available: visible
      .filter((pluginId) => !state.installed.includes(pluginId))
      .map((pluginId) => pluginEntry(pluginId, false)),
  };
}

async function addPlugin(pluginId) {
  const state = await readState();
  if (pluginId !== HOLY && !PROVIDERS.includes(pluginId) && pluginId !== ADDITIONAL) {
    fail("fixture rejected an unselected plugin");
  }
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
  } else if (
    pluginId !== ADDITIONAL &&
    !(await hasOfficialProvider(pluginId.slice(0, pluginId.lastIndexOf("@"))))
  ) {
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
  const active = JSON.parse(await readFile(join(HOME, "holycodex", "active.json"), "utf8"));
  const verifiedShell = active.tooling?.git_bash?.path;
  if (!text.includes("multi_agent = true") || !text.includes("multi_agent_v2 = false")) {
    fail("Codex config omitted the canonical Root multi-agent mode");
  }
  if (!text.includes("context_management = true")) fail("Codex config omitted scalar context management");
  if (text.includes("experimental_mode")) fail("Codex config retained legacy context management");
  function rootStringSetting(name) {
    const prefix = name + " = ";
    const line = text.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) fail("Codex config omitted " + name);
    const value = JSON.parse(line.slice(prefix.length));
    if (typeof value !== "string") fail("Codex config has an invalid " + name);
    return value;
  }
  const rootInstructions = rootStringSetting("developer_instructions").toLowerCase();
  if (!rootInstructions.includes("bounded assignment")) {
    fail("Codex config omitted the model-specific Root dispatch policy");
  }
  if (
    !rootInstructions.includes("exact concrete registered role.task agent_type") ||
    !["explorer", "librarian", "worker", "reviewer", "labels"].every((term) =>
      rootInstructions.includes(term),
    ) ||
    !rootInstructions.includes("generic built-in agent_type values worker, explorer, reviewer, librarian are forbidden")
  ) {
    fail("Codex config retained ambiguous specialist dispatch policy");
  }
  if (
    process.platform === "win32" &&
    (typeof verifiedShell !== "string" ||
      !rootStringSetting("developer_instructions").includes("On Windows, use Git for Windows Bash") ||
      !rootStringSetting("developer_instructions").includes(JSON.stringify(verifiedShell)))
  ) {
    fail("Codex config omitted the Windows Git Bash boundary");
  }
  const config = {
    model: rootStringSetting("model"),
    model_reasoning_effort: rootStringSetting("model_reasoning_effort"),
    service_tier: rootStringSetting("service_tier"),
    developer_instructions: rootStringSetting("developer_instructions"),
    features: { multi_agent: true, multi_agent_v2: false, context_management: true },
    agents: {},
  };
  const agentTypes = AGENT_TYPES_PLACEHOLDER;
  for (const agentType of agentTypes) {
    const marker = "[agents.\"" + agentType + "\"]";
    const sectionStart = text.indexOf(marker);
    if (sectionStart < 0) fail("Codex config omitted the " + agentType + " registration");
    const section = text.slice(sectionStart + marker.length).split(/\r?\n\r?\n/u, 1)[0];
    const configFileMatch = /^config_file = (".*")$/mu.exec(section);
    if (configFileMatch === null) fail("Codex config omitted the " + agentType + " path");
    const configFile = JSON.parse(configFileMatch[1]);
    if (typeof configFile !== "string") fail("Codex config has an invalid agent path");
    const rolePath = isAbsolute(configFile) ? resolve(configFile) : resolve(HOME, configFile);
    const expectedRolePath = resolve(HOME, "holycodex", "agents", agentType + ".toml");
    const comparableRolePath = process.platform === "win32" ? rolePath.toLowerCase() : rolePath;
    const comparableExpectedRolePath = process.platform === "win32" ? expectedRolePath.toLowerCase() : expectedRolePath;
    if (comparableRolePath !== comparableExpectedRolePath) {
      fail("Codex config points " + agentType + " outside the managed role directory");
    }
    const roleText = await readFile(rolePath, "utf8");
    if (!roleText.includes('model = "gpt-6-luna"')) {
      fail("Codex role file omitted the configured specialist routing model");
    }
    if (
      !roleText.includes("multi_agent = false") ||
      !roleText.includes("multi_agent_v2 = false") ||
      !roleText.includes("context_management = true")
    ) {
      fail("Codex role file omitted scalar context management");
    }
    for (const feature of ["computer_use = false", "browser_use = false", "in_app_browser = false"]) {
      if (!roleText.includes(feature)) {
        fail("Codex role file enabled a Root-only interactive capability");
      }
    }
    if (roleText.includes("tool_output_token_limit")) {
      fail("Codex role file contains the removed tool_output_token_limit");
    }
    const roleInstructionLine = roleText.split(/\r?\n/u).find((line) => line.startsWith("developer_instructions = "));
    const roleInstructions = roleInstructionLine === undefined
      ? ""
      : JSON.parse(roleInstructionLine.slice("developer_instructions = ".length));
    if (
      process.platform === "win32" &&
      (typeof verifiedShell !== "string" ||
        typeof roleInstructions !== "string" ||
        !roleInstructions.includes("On Windows, use Git for Windows Bash") ||
        !roleInstructions.includes(JSON.stringify(verifiedShell)))
    ) {
      fail("Codex role file omitted the Windows Git Bash boundary");
    }
    config.agents[agentType] = { config_file: configFile };
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
  return source
    .replace('"CODEX_VERSION_PLACEHOLDER"', JSON.stringify(codexCliVersion))
    .replace("AGENT_TYPES_PLACEHOLDER", JSON.stringify(NATIVE_AGENT_TYPES));
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

function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!hasProperty(value, key)) return undefined;
  const child = value[key];
  return typeof child === "object" && child !== null && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : undefined;
}

function arrayProperty(value: unknown, key: string): readonly unknown[] | undefined {
  if (!hasProperty(value, key)) return undefined;
  return Array.isArray(value[key]) ? value[key] : undefined;
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
