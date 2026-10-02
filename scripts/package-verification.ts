// SPDX-License-Identifier: Apache-2.0
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { parseConfig } from "../packages/cli/src/installer.ts";
import { currentModelCatalogJson } from "../packages/cli/src/model-catalog-fixture.ts";
import { modelSupportsExperimentalContext } from "../packages/cli/src/model-catalog.ts";
import type {
  NativeAgentProjection,
  RootAgentProjection,
} from "../packages/cli/src/native-agents.ts";
import { decodeStateText, writeAtomicState } from "../packages/cli/src/storage.ts";
import { AppServerClient, BunStdioTransport, readTomlPath } from "../packages/codex/src/index.ts";
import { PROFILE_CATALOG } from "../packages/core/src/catalog.ts";
import type { JsonValue } from "../packages/core/src/common.ts";
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
function externalTemporaryRoot(): string {
  const configuredTemporaryRoot = resolve(tmpdir());
  const configuredTemporaryRelativePath = relative(workspaceRoot, configuredTemporaryRoot);
  const configuredTemporaryRootIsWorkspaceLocal =
    configuredTemporaryRelativePath === "" ||
    (!isAbsolute(configuredTemporaryRelativePath) &&
      configuredTemporaryRelativePath !== ".." &&
      !configuredTemporaryRelativePath.startsWith(`..${sep}`));
  const temporaryRoot =
    process.platform === "win32"
      ? process.env["LOCALAPPDATA"] !== undefined
        ? join(process.env["LOCALAPPDATA"], "Temp")
        : join(process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "C:\\Windows", "Temp")
      : configuredTemporaryRootIsWorkspaceLocal
        ? "/tmp"
        : configuredTemporaryRoot;
  const temporaryRelativePath = relative(workspaceRoot, resolve(temporaryRoot));
  assert(
    temporaryRelativePath === ".." ||
      temporaryRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(temporaryRelativePath),
    "isolated Bun package state must be outside the repository",
  );
  return temporaryRoot;
}
const ReleaseStampSchema = Schema.Struct({
  schemaVersion: Schema.Literals(["holycodex-release-v1"]),
  channel: ReleaseChannelSchema,
  sourceSha: SourceShaSchema,
});
const PublicManifestSchema = Schema.Struct({
  name: Schema.Literals(["holycodex"]),
  version: ReleaseVersionSchema,
  bin: Schema.Record(Schema.String, Schema.String),
  files: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  type: Schema.Literals(["module"]),
  exports: Schema.Record(Schema.String, Schema.String),
  dependencies: Schema.Record(Schema.String, Schema.String),
  repository: Schema.Struct({ type: Schema.Literals(["git"]), url: Schema.String }),
  publishConfig: Schema.Struct({ access: Schema.Literals(["public"]) }),
  release: Schema.optional(ReleaseStampSchema),
});
const WorkspaceManifestSchema = Schema.Struct({
  catalog: Schema.Record(Schema.String, Schema.String),
});
const InstalledPluginManifestSchema = Schema.Struct({
  version: Schema.String.check(Schema.isMinLength(1)),
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
// upgrade proof. Update them only after verifying the exact published artifact.
const PREVIOUS_STABLE_VERSION = "0.16.9-2";
const PREVIOUS_STABLE_SOURCE_SHA = "7b803e5dbb5f7baaa570b6ba184166cecd764506";
const PREVIOUS_STABLE_CLI_SHA256 =
  "654152d5f955cbcb4d11878b37927ba2f32090bebd69675716d564bee9c728cd";
const PREVIOUS_STABLE_AGENT_SHA256 =
  "8ccec61622ae854a4da3c66b3f3f0fe6b76283459f5a1d4714825571c944d09c";
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
    request: {
      readonly dryRun?: boolean;
    },
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
type PreviousStableUpgradeOptions = Readonly<{
  readonly temporaryRoot: string;
  readonly currentCanonicalVersion: string;
  readonly currentVersion: string;
  readonly currentInstalledRoot: string;
  readonly currentInstalledPackageRoot: string;
  readonly currentEntry: string;
  readonly codexCliVersion: string;
  readonly bunEnvironment: Readonly<Record<string, string | undefined>>;
  readonly commands: string[];
}>;
type InternalUpgradeOutcome =
  | Readonly<{
      ok: true;
      data: Record<string, unknown>;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: string;
        message: string;
      }>;
    }>;
function verifyPublishedRouting(installed: InstalledCliModule): void {
  let projectedRoutes = 0;
  assert(
    JSON.stringify(PROFILE_CATALOG.map(({ name, root }) => [name, root.model, root.effort])) ===
      JSON.stringify([
        ["low", "gpt-6.1-sol", "low"],
        ["default", "gpt-6.1-sol", "medium"],
        ["high", "gpt-6.1-sol", "medium"],
      ]),
    "the packed profile catalog must preserve the canonical Root model and effort mapping",
  );
  for (const profile of PROFILE_CATALOG) {
    assert(
      String(profile.root.effort) !== "max" &&
        profile.routes.every((route) => String(route.effort) !== "max"),
      `the packed ${profile.name} live routes must not use max effort`,
    );
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
    for (const name of ["Reviewer.audit", "Reviewer.testing", "Reviewer.security"] as const) {
      const reviewer = standard.find((agent) => agent.name === name);
      assert(
        reviewer !== undefined && reviewer.permissions.sourceMutation,
        `the packed ${profile.name} projection omitted writable ${name}`,
      );
    }
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
    "the packed module did not verify all profile and specialist projections",
  );
}
/** Exercise the packed package's migration boundary without a public CLI command. */
function runInternalUpgrade(
  entry: string,
  codexHome: string,
  environment: Readonly<Record<string, string | undefined>>,
  dryRun = false,
): Effect.Effect<InternalUpgradeOutcome, unknown> {
  return Effect.gen(function* () {
    return yield* (() =>
      Effect.gen(function* () {
        const installed = (yield* Effect.tryPromise(
          () => import(pathToFileURL(entry).href),
        )) as InstalledCliModule;
        return yield* Effect.tryPromise({
          try: () => installed.upgradeHolyCodex({ paths: { codexHome } }, environment, { dryRun }),
          catch: (error) => error,
        });
      }))().pipe(
      Effect.match({
        onFailure: (error): InternalUpgradeOutcome => ({
          ok: false,
          error: {
            code:
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "string"
                ? error.code
                : "internal_error",
            message:
              error instanceof Error
                ? `${error.stack ?? error.message}${error.cause instanceof Error ? `\nCaused by: ${error.cause.stack ?? error.cause.message}` : ""}`
                : String(error),
          },
        }),
        onSuccess: (data): InternalUpgradeOutcome => ({ ok: true, data }),
      }),
    );
  });
}
/** Release metadata used when packing a channel-specific public package. */
export interface PackageReleaseOptions {
  /** Version to embed in the packed package. */
  readonly version: string;
  /** Release channel used to validate version and provenance metadata. */
  readonly channel: ReleaseChannel;
  /** Full source commit SHA recorded in package provenance. */
  readonly sourceSha: string;
}
/** Verified package tarball details produced by the release packer. */
export interface PackageVerificationResult {
  /** Version read back from the packaged manifest. */
  readonly packageVersion: string;
  /** Tarball filename produced by Bun's pack command. */
  readonly tarball: string;
  /** SHA-256 digest of the packed tarball. */
  readonly tarballSha256: string;
  /** Archive entries that passed the public package allowlist. */
  readonly entries: readonly string[];
  /** Commands executed while building and verifying the package. */
  readonly commands: readonly string[];
}
/** Packed public package identity and the verified tarball's filesystem location. */
export interface PackedPublicPackage {
  /** Canonical HolyCodex release version from the source manifest. */
  readonly canonicalVersion: string;
  /** Base version without any channel or numeric suffix. */
  readonly baseVersion: string;
  /** Version embedded in the generated tarball. */
  readonly packageVersion: string;
  /** Tarball filename. */
  readonly tarball: string;
  /** Absolute path to the generated tarball. */
  readonly tarballPath: string;
  /** SHA-256 digest of the generated tarball. */
  readonly tarballSha256: string;
  /** Archive entries accepted by the public package allowlist. */
  readonly entries: readonly string[];
}
/** Pack the public package into a verified tarball in a temporary directory. */
export function packPublicPackageEffect(
  temporaryRoot: string,
  options?: PackageReleaseOptions,
): Effect.Effect<PackedPublicPackage, unknown> {
  return Effect.gen(function* () {
    const manifest = yield* readPublicManifest();
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
    yield* requireFile(join(cliRoot, "dist/index.js"), "the packed CLI entry point");
    yield* requireFile(join(cliRoot, "dist/agent.js"), "the packed agent CLI entry point");
    const buildEntries = yield* Effect.tryPromise(() =>
      listSafeArtifactEntries(join(cliRoot, "dist"), "the build output"),
    );
    assertBuildUploadEntries(buildEntries);
    const packageRoot = join(temporaryRoot, "package");
    yield* Effect.tryPromise(() => mkdir(packageRoot, { recursive: true }));
    yield* Effect.tryPromise(() =>
      cp(join(cliRoot, "dist"), join(packageRoot, "dist"), {
        recursive: true,
        dereference: true,
      }),
    );
    const readme = join(cliRoot, "README.md");
    if (yield* exists(readme)) {
      yield* Effect.tryPromise(() => cp(readme, join(packageRoot, "README.md")));
    }
    const stagedManifest = release === undefined ? manifest : { ...manifest, version, release };
    yield* Effect.tryPromise(() => writeJson(join(packageRoot, "package.json"), stagedManifest));
    const entries = yield* listPackageEntries(packageRoot);
    assertPublicPackageEntries(entries);
    assertAllowedEntries(entries, stagedManifest);
    const tarball = `holycodex-${version}.tgz`;
    yield* Effect.tryPromise(() =>
      runChecked(["bun", "pm", "pack", "--destination", temporaryRoot, "--quiet"], {
        cwd: packageRoot,
        env: allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS),
      }),
    );
    const tarballPath = join(temporaryRoot, tarball);
    yield* requireFile(tarballPath, "the package tarball");
    yield* Effect.tryPromise(() =>
      assertSafeArtifactFile(tarballPath, tarball, "the package tarball"),
    );
    yield* assertPackedEntriesEffect(tarballPath, entries);
    const tarballSha256 = yield* sha256FileEffect(tarballPath);
    return {
      canonicalVersion,
      baseVersion,
      packageVersion: version,
      tarball,
      tarballPath,
      tarballSha256,
      entries,
    };
  });
}
/** Install and exercise a packed public package in an isolated environment. */
export function verifyPublicPackageEffect(
  packed: PackedPublicPackage,
  codexCliVersion?: string,
): Effect.Effect<PackageVerificationResult, unknown> {
  return Effect.gen(function* () {
    const resolvedCodexCliVersion =
      codexCliVersion ?? (yield* ensureCodexGenerated()).codexCliVersion;
    assert(
      /^codex-cli \d+\.\d+\.\d+$/u.test(resolvedCodexCliVersion),
      "the generated Codex version authority is not a stable CLI version",
    );
    const version = packed.packageVersion;
    const temporaryRoot = dirname(packed.tarballPath);
    const installedRoot = join(temporaryRoot, "installed");
    yield* Effect.tryPromise(() => mkdir(installedRoot, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeJson(join(installedRoot, "package.json"), {
        name: "holycodex-package-verification",
        private: true,
        type: "module",
        dependencies: { holycodex: `file:${packed.tarballPath.replaceAll("\\", "/")}` },
      }),
    );
    const bunStateRoot = join(temporaryRoot, "bun-state");
    const bunHomeRoot = join(bunStateRoot, "home");
    const bunInstallRoot = join(bunHomeRoot, ".bun");
    const bunGlobalDirectory = join(bunInstallRoot, "install/global");
    const bunGlobalBinDirectory = join(bunInstallRoot, "bin");
    const bunTempRoot = join(bunStateRoot, "tmp");
    const bunEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      HOME: bunHomeRoot,
      USERPROFILE: bunHomeRoot,
      APPDATA: join(bunHomeRoot, "AppData/Roaming"),
      LOCALAPPDATA: join(bunHomeRoot, "AppData/Local"),
      BUN_INSTALL: bunInstallRoot,
      BUN_INSTALL_GLOBAL_DIR: bunGlobalDirectory,
      BUN_INSTALL_BIN: bunGlobalBinDirectory,
      XDG_CONFIG_HOME: join(bunHomeRoot, "config"),
      BUN_TMPDIR: bunTempRoot,
      TEMP: bunTempRoot,
      TMP: bunTempRoot,
      TMPDIR: bunTempRoot,
      npm_execpath: process.execPath,
      npm_command: "exec",
      npm_config_user_agent: `bun/${Bun.version}`,
    });
    yield* Effect.tryPromise(() => mkdir(bunHomeRoot, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(bunInstallRoot, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(bunGlobalDirectory, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(bunGlobalBinDirectory, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(bunTempRoot, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        join(bunHomeRoot, ".bunfig.toml"),
        `[install]\nglobalDir = ${JSON.stringify(bunGlobalDirectory.replaceAll("\\", "/"))}\nglobalBinDir = ${JSON.stringify(bunGlobalBinDirectory.replaceAll("\\", "/"))}\n`,
        { encoding: "utf8" },
      ),
    );
    bunEnvironment["PATH"] = [bunGlobalBinDirectory, bunEnvironment["PATH"]]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter);
    const preexistingContext7 = yield* findCommandOnPath("ctx7", bunEnvironment["PATH"]).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    );
    const expectedContext7Ownership = preexistingContext7 ? "user" : "holycodex";
    yield* Effect.tryPromise(() =>
      runChecked(["bun", "install", "--no-save", "--ignore-scripts", "--no-progress"], {
        cwd: installedRoot,
        env: bunEnvironment,
      }),
    );
    const installedPackageRoot = join(installedRoot, "node_modules/holycodex");
    const installedEntry = join(installedPackageRoot, "dist/index.js");
    const installedAgentEntry = join(installedPackageRoot, "dist/agent.js");
    yield* requireFile(installedEntry, "the installed package entry point");
    yield* requireFile(installedAgentEntry, "the installed agent CLI entry point");
    yield* requireFile(
      join(installedPackageRoot, "dist/assets/plugin/plugin.json"),
      "the installed plugin payload source",
    );
    for (const relativePath of [
      "skills/visual-loop/SKILL.md",
      "skills/dev-server/SKILL.md",
      "skills/grill-me/SKILL.md",
      "skills/writing-instructions/SKILL.md",
      "skills/babysit-ci/SKILL.md",
    ]) {
      yield* requireFile(
        join(installedPackageRoot, "dist/assets/plugin", relativePath),
        `the installed plugin asset ${relativePath}`,
      );
    }
    const installedManifest = yield* readInstalledManifest(
      join(installedPackageRoot, "package.json"),
    );
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
    yield* runInstalledOpenTuiProbe(installedRoot, installedEntry, commands, bunEnvironment);
    const stateRoot = join(codexHome, "holycodex");
    yield* Effect.tryPromise(() => mkdir(codexHome, { recursive: true }));
    const unrelatedConfig =
      '[features]\nunrelated = "keep"\n\n[features.context_management]\nexperimental_mode = true\n\napproval_policy = "on-request"\n';
    yield* Effect.tryPromise(() =>
      writeFile(join(codexHome, "config.toml"), unrelatedConfig, {
        encoding: "utf8",
        mode: 0o600,
      }),
    );
    // Exercise Codex discovery, App Server bootstrap, and plugin readback with
    // an isolated executable.  No local marketplace is pre-seeded and no
    // network or user Codex state can affect this package proof.
    const fixturePluginSource = join(codexHome, "fixture-plugin-source");
    yield* Effect.tryPromise(() =>
      cp(join(installedPackageRoot, "dist/assets/plugin"), fixturePluginSource, {
        recursive: true,
        dereference: true,
      }),
    );
    // The npm payload keeps the manifest at the asset root; Codex's native
    // plugin manager reads the canonical .codex-plugin location.
    yield* Effect.tryPromise(() =>
      mkdir(join(fixturePluginSource, ".codex-plugin"), { recursive: true }),
    );
    yield* Effect.tryPromise(() =>
      cp(
        join(fixturePluginSource, "plugin.json"),
        join(fixturePluginSource, ".codex-plugin/plugin.json"),
      ),
    );
    const codexFixture = yield* createCodexFixture(codexHome, resolvedCodexCliVersion);
    const codexEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      CODEX_HOME: codexHome,
      HOME: bunEnvironment["HOME"],
      USERPROFILE: bunEnvironment["USERPROFILE"],
      APPDATA: bunEnvironment["APPDATA"],
      LOCALAPPDATA: bunEnvironment["LOCALAPPDATA"],
      XDG_CONFIG_HOME: bunEnvironment["XDG_CONFIG_HOME"],
      PATH: [
        codexFixture.binDirectory,
        join(workspaceRoot, "node_modules/.bin"),
        bunEnvironment["PATH"],
      ]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(delimiter),
      BUN_INSTALL: bunInstallRoot,
      BUN_INSTALL_GLOBAL_DIR: bunGlobalDirectory,
      BUN_INSTALL_BIN: bunGlobalBinDirectory,
      BUN_TMPDIR: bunTempRoot,
      TEMP: bunTempRoot,
      TMP: bunTempRoot,
      TMPDIR: bunTempRoot,
      npm_execpath: process.execPath,
      npm_command: "exec",
      npm_config_user_agent: `bun/${Bun.version}`,
    });
    const installedModule = (yield* Effect.tryPromise(
      () => import(pathToFileURL(installedEntry).href),
    )) as InstalledCliModule;
    verifyPublishedRouting(installedModule);
    yield* verifyPreviousStableUpgrade({
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
    const versionEnvelope = yield* runCli(
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
    const removedUpgrade = yield* runCliResult(
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
    yield* runInstalledAgentHelp(installedAgentEntry, installedRoot, commands);
    const executable = yield* findInstalledExecutable(installedRoot);
    const executableEnvelope = yield* runInstalledExecutable(
      executable,
      installedRoot,
      commands,
      codexEnvironment,
    );
    assert(executableEnvelope.ok, "installed executable bin failed");
    if (executableEnvelope.ok) {
      const executableData = executableEnvelope.data;
      assert(hasProperty(executableData, "version"), "installed executable data is invalid");
      assert(
        executableData["version"] === version,
        "installed executable version is not canonical",
      );
    }
    const installEnvelope = yield* runCli(
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
    const reinstallEnvelope = yield* runCli(
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
    assert(
      reinstallEnvelope.ok,
      "packed package reinstall failed to refresh and verify its existing marketplace",
    );
    const activeRecordPath = join(stateRoot, "active.toml");
    const activeRecord = decode(
      Schema.Record(Schema.String, Schema.Unknown),
      parseInstallRecord(yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8"))),
      "the active installation record",
    );
    assert(
      activeRecord["profile"] === "high" &&
        activeRecord["tier"] === "fast-all" &&
        activeRecord["plan"] === undefined &&
        arrayProperty(activeRecord, "official_plugins")?.includes(ADDITIONAL_FIXTURE_PLUGIN) ===
          true,
      "the active installation record must use the current profile field",
    );
    const selections = objectProperty(activeRecord, "optional_selections");
    assert(
      selections?.["sites"] === true &&
        selections["browser_use"] === true &&
        selections["computer_use"] === false &&
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
    yield* assertPersistedContext7(
      activeRecord,
      installedRoot,
      bunEnvironment,
      commands,
      "packed install",
      expectedContext7Ownership,
    );
    const managedConfigText = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    const managedConfig = parseConfig(managedConfigText);
    const managedCatalogPath = readTomlPath(managedConfig, "model_catalog_json");
    assert(
      typeof managedCatalogPath === "string",
      "the managed Codex configuration must point to its current model catalog",
    );
    const managedCatalogRaw: unknown = JSON.parse(
      yield* Effect.tryPromise(() => readFile(managedCatalogPath, "utf8")),
    );
    const supportsExperimentalContext = modelSupportsExperimentalContext(
      managedCatalogRaw,
      "gpt-6.1-sol",
    );
    const experimentalContextEnabled =
      readTomlPath(managedConfig, "features.context_management.experimental_mode") === true;
    const managedRootInstructions = readTomlPath(managedConfig, "developer_instructions");
    const normalizedRootInstructions =
      typeof managedRootInstructions === "string" ? managedRootInstructions.toLowerCase() : "";
    assert(
      readTomlPath(managedConfig, "model") === "gpt-6.1-sol" &&
        experimentalContextEnabled === supportsExperimentalContext &&
        !/\bTerra\b/u.test(managedConfigText),
      "the managed context-management setting must follow the current Root model's advertised support",
    );
    assert(
      typeof managedRootInstructions === "string" &&
        managedRootInstructions.includes(
          "Dispatch each Assignment to its exact concrete registered Role.task agent_type",
        ) &&
        normalizedRootInstructions.includes("exact concrete registered role.task agent_type") &&
        ["explorer", "librarian", "worker", "reviewer", "labels"].every((term) =>
          normalizedRootInstructions.includes(term),
        ) &&
        normalizedRootInstructions.includes(
          "generic built-in agent_type values default, worker, explorer, reviewer, librarian are forbidden",
        ),
      "the packed high-profile Root configuration must preserve exact specialist dispatch",
    );
    assert(
      normalizedRootInstructions.includes("reviewer.code fixed point") &&
        normalizedRootInstructions.includes("current relevant validation") &&
        normalizedRootInstructions.includes("review and validation may overlap") &&
        normalizedRootInstructions.includes("reuse worker proof"),
      "the packed Root configuration must retain acceptance gates without redundant serial proof",
    );
    const pluginListEnvelope = parseCodexPluginList(
      (yield* Effect.tryPromise(() =>
        runChecked([codexFixture.executable, "plugin", "list", "--json"], {
          cwd: workspaceRoot,
          env: codexEnvironment,
        }),
      )).stdout,
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
      "skills/visual-loop/SKILL.md",
      "skills/grill-me/SKILL.md",
      "skills/writing-instructions/SKILL.md",
      "skills/babysit-ci/SKILL.md",
    ]) {
      yield* requireFile(
        join(installedPluginRoot, relativePath),
        `installed Codex plugin asset ${relativePath}`,
      );
    }
    const installedPluginManifest = decode(
      InstalledPluginManifestSchema,
      JSON.parse(
        yield* Effect.tryPromise(() =>
          readFile(join(installedPluginRoot, ".codex-plugin/plugin.json"), "utf8"),
        ),
      ),
      "installed Codex plugin manifest",
    );
    assert(
      installedPluginManifest.version === packed.canonicalVersion,
      "installed Codex plugin manifest version is not canonical",
    );
    const writingInstructions = yield* Effect.tryPromise(() =>
      readFile(join(installedPluginRoot, "skills/writing-instructions/SKILL.md"), "utf8"),
    );
    assert(
      !/GPT-5\.6|\b(?:Luna|Sol|Terra)\b|writing-for-agents|load before first dispatch|reload when lost|reuse while/iu.test(
        writingInstructions,
      ),
      "writing-instructions must target GPT-6 without obsolete context-residency rituals",
    );
    assert(
      !(yield* exists(join(installedPluginRoot, "skills/writing-for-agents"))),
      "the retired instruction skill alias must not ship",
    );
    yield* assertCodexAppServerReadback(
      codexFixture.executable,
      codexEnvironment,
      codexHome,
      resolvedCodexCliVersion,
    );
    // The fixture intentionally has a closed command surface.  Prove an
    // unexpected command is rejected without exposing process environment data.
    const rejected = yield* Effect.tryPromise(() =>
      runCommand([codexFixture.executable, "unexpected-command"], {
        cwd: workspaceRoot,
        env: codexEnvironment,
      }),
    );
    assert(rejected.exitCode !== 0, "the Codex fixture accepted an unexpected command");
    const doctorEnvelope = yield* runCli(
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
    const currentUpgrade = yield* runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
    assert(currentUpgrade.ok, "packed package current upgrade command failed");
    if (currentUpgrade.ok) {
      assert(
        hasProperty(currentUpgrade.data, "status") && currentUpgrade.data["status"] === "current",
        `already-current upgrade must report current (${JSON.stringify({
          status: currentUpgrade.data["status"],
          from_version: currentUpgrade.data["from_version"],
          to_version: currentUpgrade.data["to_version"],
          changes: currentUpgrade.data["changes"],
        })})`,
      );
    }
    const beforeCancellationConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    const beforeCancellationRecord = yield* Effect.tryPromise(() =>
      readFile(activeRecordPath, "utf8"),
    );
    const cancelled = (yield* Effect.tryPromise(() =>
      installedModule.runCli(["remove", "--codex-home", codexHome], {
        env: codexEnvironment,
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          // The packed CLI IO interface is a third-party Promise callback boundary.
          confirm: () => Promise.resolve("cancelled"),
        },
      }),
    )) as {
      readonly envelope: typeof CliEnvelopeSchema.Type;
      readonly exitCode: number;
    };
    assert(
      cancelled.exitCode === 1,
      `interactive remove cancellation must return its documented nonzero status: ${JSON.stringify(cancelled.envelope)}`,
    );
    assert(cancelled.envelope.ok, "interactive remove cancellation must return success");
    if (cancelled.envelope.ok) {
      assert(
        hasProperty(cancelled.envelope.data, "cancelled") &&
          cancelled.envelope.data["cancelled"] === true,
        "interactive remove cancellation must be explicit",
      );
    }
    assert(
      (yield* Effect.tryPromise(() => readFile(join(codexHome, "config.toml"), "utf8"))) ===
        beforeCancellationConfig &&
        (yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8"))) ===
          beforeCancellationRecord,
      "interactive remove cancellation must not mutate the installation",
    );
    yield* rewriteActiveRecord(activeRecordPath, installedModule, (record) => ({
      ...record,
      version: previousPatchVersion(version),
    }));
    const dryRunBeforeConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    const dryRunBeforeRecord = yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8"));
    const dryRun = yield* runInternalUpgrade(installedEntry, codexHome, codexEnvironment, true);
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
          ) !== true,
        "upgrade dry-run must preserve current experimental context-management configuration",
      );
    }
    assert(
      (yield* Effect.tryPromise(() => readFile(join(codexHome, "config.toml"), "utf8"))) ===
        dryRunBeforeConfig &&
        (yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8"))) === dryRunBeforeRecord,
      "upgrade dry-run must not mutate state",
    );
    const upgraded = yield* runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
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
    const migratedConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    assert(
      migratedConfig.includes("[features.context_management]") &&
        migratedConfig.includes("experimental_mode = true") &&
        migratedConfig.includes('unrelated = "keep"'),
      "upgrade must preserve experimental context management and unrelated config",
    );
    yield* assertCodexAppServerReadback(
      codexFixture.executable,
      codexEnvironment,
      codexHome,
      resolvedCodexCliVersion,
    );
    yield* rewriteActiveRecord(activeRecordPath, installedModule, (record) => ({
      ...record,
      version: nextPatchVersion(version),
    }));
    const downgrade = yield* runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
    assert(!downgrade.ok, "downgrade upgrade must fail");
    assert(
      !downgrade.ok && downgrade.error.code === "upgrade_downgrade",
      "downgrade upgrade must return a semantic refusal",
    );
    yield* rewriteActiveRecord(activeRecordPath, installedModule, (record) => ({
      ...record,
      version: packed.baseVersion,
    }));
    for (const [name, status] of [
      ["preparing", "preparing"],
      ["conflicted", "conflicted"],
    ] as const) {
      const current = parseInstallRecord(
        yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8")),
      ) as Record<string, unknown>;
      yield* Effect.tryPromise(() =>
        writeJson(join(stateRoot, `${name}.json`), {
          ...current,
          status,
          step: status === "preparing" ? "validated" : "conflicted",
        }),
      );
      const recovered = yield* runInternalUpgrade(installedEntry, codexHome, codexEnvironment);
      assert(
        recovered.ok,
        `${name} transaction recovery failed${recovered.ok ? "" : ` (${recovered.error.code}: ${recovered.error.message})`}`,
      );
      assert(
        !(yield* exists(join(stateRoot, `${name}.json`))),
        `${name} transaction state must be cleared after recovery`,
      );
    }
    const notInstalledHome = join(temporaryRoot, "not-installed-codex-home");
    const notInstalled = yield* runInternalUpgrade(installedEntry, notInstalledHome, {
      ...codexEnvironment,
      CODEX_HOME: notInstalledHome,
    });
    assert(
      !notInstalled.ok && notInstalled.error.code === "not_installed",
      "upgrade without an installation must return not_installed",
    );
    const invalidConfigHome = join(temporaryRoot, "invalid-config-codex-home");
    yield* Effect.tryPromise(() => mkdir(invalidConfigHome, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        join(invalidConfigHome, "config.toml"),
        "[features.context_management]\nexperimental_mode =\n",
        { encoding: "utf8", mode: 0o600 },
      ),
    );
    const invalidConfigEvents: string[] = [];
    const invalidConfigInstall = (yield* Effect.tryPromise(() =>
      installedModule.runCli(["install", "--yes", "--codex-home", invalidConfigHome], {
        env: { ...codexEnvironment, CODEX_HOME: invalidConfigHome },
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          writeStderr: (message: string) => invalidConfigEvents.push(message),
        },
      }),
    )) as {
      readonly envelope: typeof CliEnvelopeSchema.Type;
      readonly exitCode: number;
    };
    assert(invalidConfigInstall.exitCode !== 0, "invalid config install must fail");
    assert(
      !invalidConfigInstall.envelope.ok &&
        invalidConfigInstall.envelope.error.code === "state_corrupt",
      "invalid config install must return a semantic error",
    );
    assert(
      invalidConfigEvents.some((message) => message.includes("Validating Codex target")) &&
        !invalidConfigEvents.some((message) => message.includes("Installing subagent roles")),
      "failed install progress must stop at the real validation boundary",
    );
    const removeEnvelope = yield* runCli(
      installedEntry,
      ["remove", "--yes", "--json", "--codex-home", codexHome],
      installedRoot,
      commands,
      codexEnvironment,
    );
    assert(removeEnvelope.ok, "packed package remove command failed");
    assert(
      !(yield* exists(join(stateRoot, "active.toml"))),
      "remove left the active install record",
    );
    assert(
      !(yield* exists(join(stateRoot, "conflicted.toml"))),
      "remove left the conflicted install record",
    );
    const removedConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    assert(
      removedConfig.includes("[features.context_management]") &&
        removedConfig.includes("experimental_mode = true") &&
        removedConfig.includes('unrelated = "keep"') &&
        removedConfig.includes('approval_policy = "on-request"'),
      "remove did not restore unrelated Codex configuration",
    );
    const afterRemove = parseCodexPluginList(
      (yield* Effect.tryPromise(() =>
        runChecked([codexFixture.executable, "plugin", "list", "--json"], {
          cwd: workspaceRoot,
          env: codexEnvironment,
        }),
      )).stdout,
    );
    assert(
      !afterRemove.installed.some((entry) => entry.pluginId === CODEX_HOLYCODEX_PLUGIN),
      "Codex plugin list retained HolyCodex after removal",
    );
    assert(
      !afterRemove.installed.some((entry) => entry.pluginId === ADDITIONAL_FIXTURE_PLUGIN),
      "remove retained the explicitly selected additional plugin",
    );
    const repeatedRemove = yield* runCli(
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
    const repeatedRemovedConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    assert(
      repeatedRemovedConfig.includes("[features.context_management]") &&
        repeatedRemovedConfig.includes("experimental_mode = true") &&
        repeatedRemovedConfig.includes('unrelated = "keep"') &&
        repeatedRemovedConfig.includes('approval_policy = "on-request"'),
      "repeated remove must preserve unrelated Codex configuration",
    );
    const nonTtyRemove = yield* runCliResult(
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
  });
}
/** Assert that a package tarball contains exactly the expected entries. */
export function assertPackedEntriesEffect(
  tarballPath: string,
  expectedEntries: readonly string[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const actualEntries = listTarEntries(
      gunzipSync(yield* Effect.tryPromise(() => readFile(tarballPath))),
    )
      .map((entry) => entry.replace(/^\.\//u, ""))
      .filter((entry) => entry !== "package" && entry !== "package/")
      .map((entry) => (entry.startsWith("package/") ? entry.slice("package/".length) : entry))
      .sort();
    const expected = [...expectedEntries].sort();
    assert(
      JSON.stringify(actualEntries) === JSON.stringify(expected),
      `the package tarball entries are not allowlisted: ${JSON.stringify(actualEntries)}`,
    );
  });
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
export function sha256FileEffect(path: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise(() => readFile(path));
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = yield* Effect.tryPromise(() => crypto.subtle.digest("SHA-256", copy));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}
/** Pack and verify the public package using the current generated Codex bindings. */
export function runPackageVerificationEffect(): Effect.Effect<PackageVerificationResult, unknown> {
  return Effect.gen(function* () {
    return yield* withVerificationDirectory("holycodex-package-verification", (temporaryRoot) =>
      Effect.gen(function* () {
        const generated = yield* ensureCodexGenerated();
        const packed = yield* packPublicPackageEffect(temporaryRoot);
        return yield* verifyPublicPackageEffect(packed, generated.codexCliVersion);
      }),
    );
  });
}
function verifyPreviousStableUpgrade(
  options: PreviousStableUpgradeOptions,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const temporaryRoot = externalTemporaryRoot();
    yield* Effect.tryPromise(() => mkdir(temporaryRoot, { recursive: true }));
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp(join(temporaryRoot, "holycodex-previous-stable-bun-state-"))),
      (bunStateRoot) => verifyPreviousStableUpgradeWithBunState({ ...options, bunStateRoot }),
      (bunStateRoot) => Effect.tryPromise(() => rm(bunStateRoot, { recursive: true, force: true })),
    );
  });
}
function verifyPreviousStableUpgradeWithBunState(
  options: PreviousStableUpgradeOptions & {
    readonly bunStateRoot: string;
  },
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const previousVersion = PREVIOUS_STABLE_VERSION;
    const previousInstalledRoot = join(options.temporaryRoot, "previous-installed");
    yield* Effect.tryPromise(() => mkdir(previousInstalledRoot, { recursive: true }));
    const previousBunStateRoot = options.bunStateRoot;
    const previousBunHomeRoot = join(previousBunStateRoot, "home");
    const previousBunInstallRoot = join(previousBunHomeRoot, ".bun");
    const previousBunGlobalDirectory = join(previousBunInstallRoot, "install/global");
    const previousBunGlobalBinDirectory = join(previousBunInstallRoot, "bin");
    const previousBunTempRoot = join(previousBunStateRoot, "tmp");
    const previousBunEnvironment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      HOME: previousBunHomeRoot,
      USERPROFILE: previousBunHomeRoot,
      APPDATA: join(previousBunHomeRoot, "AppData/Roaming"),
      LOCALAPPDATA: join(previousBunHomeRoot, "AppData/Local"),
      BUN_INSTALL: previousBunInstallRoot,
      BUN_INSTALL_GLOBAL_DIR: previousBunGlobalDirectory,
      BUN_INSTALL_BIN: previousBunGlobalBinDirectory,
      XDG_CONFIG_HOME: join(previousBunHomeRoot, "config"),
      BUN_TMPDIR: previousBunTempRoot,
      TEMP: previousBunTempRoot,
      TMP: previousBunTempRoot,
      TMPDIR: previousBunTempRoot,
      npm_execpath: process.execPath,
      npm_command: "exec",
      npm_config_user_agent: `bun/${Bun.version}`,
    });
    yield* Effect.tryPromise(() => mkdir(previousBunHomeRoot, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(previousBunInstallRoot, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(previousBunGlobalDirectory, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(previousBunGlobalBinDirectory, { recursive: true }));
    yield* Effect.tryPromise(() => mkdir(previousBunTempRoot, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        join(previousBunHomeRoot, ".bunfig.toml"),
        `[install]\nglobalDir = ${JSON.stringify(previousBunGlobalDirectory.replaceAll("\\", "/"))}\nglobalBinDir = ${JSON.stringify(previousBunGlobalBinDirectory.replaceAll("\\", "/"))}\n`,
        { encoding: "utf8" },
      ),
    );
    previousBunEnvironment["PATH"] = [previousBunGlobalBinDirectory, options.bunEnvironment["PATH"]]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(delimiter);
    const bunxLauncher = yield* findCommandOnPath("bunx", previousBunEnvironment["PATH"]);
    yield* Effect.tryPromise(() =>
      writeJson(join(previousInstalledRoot, "package.json"), {
        name: "holycodex-previous-stable-verification",
        private: true,
        type: "module",
        dependencies: { holycodex: previousVersion },
      }),
    );
    const installCommand = ["bun", "install", "--ignore-scripts", "--no-progress"];
    options.commands.push(`${installCommand.join(" ")} (${previousVersion})`);
    yield* Effect.tryPromise(() =>
      runChecked(installCommand, {
        cwd: previousInstalledRoot,
        env: previousBunEnvironment,
      }),
    );
    const previousPackageRoot = join(previousInstalledRoot, "node_modules/holycodex");
    const previousManifest = yield* readInstalledManifest(
      join(previousPackageRoot, "package.json"),
    );
    assert(
      previousManifest.version === previousVersion,
      "the previous package version is not exact",
    );
    assert(
      previousManifest.release?.channel === "stable" &&
        previousManifest.release.sourceSha === PREVIOUS_STABLE_SOURCE_SHA,
      "the previous package does not have the expected stable source identity",
    );
    const previousEntry = join(previousPackageRoot, "dist/index.js");
    const previousAgentEntry = join(previousPackageRoot, "dist/agent.js");
    assert(
      (yield* sha256FileEffect(previousEntry)) === PREVIOUS_STABLE_CLI_SHA256,
      "the previous stable CLI bytes do not match the published fixture identity",
    );
    assert(
      (yield* sha256FileEffect(previousAgentEntry)) === PREVIOUS_STABLE_AGENT_SHA256,
      "the previous stable agent bytes do not match the published fixture identity",
    );
    const proofRoot = join(options.temporaryRoot, "previous-upgrade-proof");
    const codexHome = join(proofRoot, "codex-home");
    yield* Effect.tryPromise(() => mkdir(codexHome, { recursive: true }));
    yield* Effect.tryPromise(() =>
      writeFile(
        join(codexHome, "config.toml"),
        '[features]\nunrelated = "keep"\n\napproval_policy = "on-request"\n',
        { encoding: "utf8", mode: 0o600 },
      ),
    );
    const fixturePluginSource = join(codexHome, "fixture-plugin-source");
    yield* stageFixturePlugin(previousPackageRoot, fixturePluginSource);
    const codexFixture = yield* createCodexFixture(codexHome, options.codexCliVersion);
    // Legacy `bun add -g` can still discover an ancestor repository from a nested CWD.
    const systemTemporaryRoot = externalTemporaryRoot();
    yield* Effect.tryPromise(() => mkdir(systemTemporaryRoot, { recursive: true }));
    const previousCliWorkingDirectory = yield* Effect.tryPromise(() =>
      mkdtemp(join(systemTemporaryRoot, "holycodex-previous-stable-command-")),
    );
    const previousBunGlobalInstallWorkingDirectory = yield* Effect.tryPromise(() =>
      mkdtemp(join(systemTemporaryRoot, "holycodex-previous-stable-bun-global-")),
    );
    const environment = allowlistedEnvironment(DEFAULT_COMMAND_ENVIRONMENT_KEYS, {
      CODEX_HOME: codexHome,
      HOME: previousBunEnvironment["HOME"],
      USERPROFILE: previousBunEnvironment["USERPROFILE"],
      APPDATA: previousBunEnvironment["APPDATA"],
      LOCALAPPDATA: previousBunEnvironment["LOCALAPPDATA"],
      XDG_CONFIG_HOME: previousBunEnvironment["XDG_CONFIG_HOME"],
      PWD: previousCliWorkingDirectory,
      PATH: [
        codexFixture.binDirectory,
        join(workspaceRoot, "node_modules/.bin"),
        previousBunEnvironment["PATH"],
      ]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(delimiter),
      BUN_INSTALL: previousBunEnvironment["BUN_INSTALL"],
      BUN_INSTALL_GLOBAL_DIR: previousBunEnvironment["BUN_INSTALL_GLOBAL_DIR"],
      BUN_INSTALL_BIN: previousBunEnvironment["BUN_INSTALL_BIN"],
      BUN_TMPDIR: previousBunEnvironment["BUN_TMPDIR"],
      TEMP: previousBunEnvironment["TEMP"],
      TMP: previousBunEnvironment["TMP"],
      TMPDIR: previousBunEnvironment["TMPDIR"],
      // The previous stable package predates direct Bun runtime detection and requires the
      // launcher identity that real `bunx holycodex` execution supplies.
      npm_execpath: bunxLauncher,
      npm_command: "exec",
      npm_config_user_agent: `bun/${Bun.version}`,
      HOLYCODEX_DEBUG_INSTALLER: "1",
    });
    let previousInstall: typeof CliEnvelopeSchema.Type;
    previousInstall = yield* runWithCleanup(
      () =>
        Effect.gen(function* () {
          // Bun needs a package manifest for `pm view`, but a global add from that package CWD
          // resolves locally. Seed the isolated global installation from a manifest-free directory.
          yield* Effect.tryPromise(() =>
            runChecked(["bun", "add", "--global", "ctx7@latest"], {
              cwd: previousBunGlobalInstallWorkingDirectory,
              env: {
                ...previousBunEnvironment,
                PWD: previousBunGlobalInstallWorkingDirectory,
              },
            }),
          );
          const previousCommandBunConfigPath = join(previousCliWorkingDirectory, "bunfig.toml");
          yield* Effect.tryPromise(() =>
            writeFile(
              previousCommandBunConfigPath,
              `[install]\nglobalDir = ${JSON.stringify(previousBunGlobalDirectory.replaceAll("\\", "/"))}\nglobalBinDir = ${JSON.stringify(previousBunGlobalBinDirectory.replaceAll("\\", "/"))}\n`,
              { encoding: "utf8" },
            ),
          );
          const previousCommandBunConfig = Bun.TOML.parse(
            yield* Effect.tryPromise(() => readFile(previousCommandBunConfigPath, "utf8")),
          );
          const previousCommandInstallConfig = objectProperty(previousCommandBunConfig, "install");
          assert(
            previousCommandInstallConfig?.["globalDir"] ===
              previousBunGlobalDirectory.replaceAll("\\", "/") &&
              previousCommandInstallConfig["globalBinDir"] ===
                previousBunGlobalBinDirectory.replaceAll("\\", "/"),
            "the previous stable CLI Bun config does not isolate global install paths",
          );
          yield* Effect.tryPromise(() =>
            writeJson(join(previousCliWorkingDirectory, "package.json"), {
              name: "holycodex-previous-stable-command",
              private: true,
            }),
          );
          yield* Effect.tryPromise(() =>
            writeJson(join(previousCliWorkingDirectory, "bun.lock"), {
              lockfileVersion: 2,
              configVersion: 1,
              workspaces: { "": { name: "holycodex-previous-stable-command" } },
              packages: {},
            }),
          );
          return yield* runCli(
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
            previousCliWorkingDirectory,
            options.commands,
            environment,
          );
        }),
      () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            rm(previousCliWorkingDirectory, { recursive: true, force: true }),
          );
          yield* Effect.tryPromise(() =>
            rm(previousBunGlobalInstallWorkingDirectory, { recursive: true, force: true }),
          );
        }),
    );
    assert(previousInstall.ok, "the previous stable package install failed");
    let activeRecordPath = join(codexHome, "holycodex/active.json");
    const previousModule = (yield* Effect.tryPromise(
      () => import(pathToFileURL(previousEntry).href),
    )) as InstalledCliModule;
    const previousHighRoot = previousModule.projectRootAgent("high", "fast-all");
    const legacyConfigMarker = join(codexHome, ".holycodex-legacy-config");
    yield* Effect.tryPromise(() => writeFile(legacyConfigMarker, "1\n", { encoding: "utf8" }));
    yield* runWithCleanup(
      () =>
        Effect.gen(function* () {
          yield* assertCodexAppServerReadback(
            codexFixture.executable,
            environment,
            codexHome,
            options.codexCliVersion,
            previousHighRoot.model,
            true,
          );
        }),
      () =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() => rm(legacyConfigMarker, { force: true }));
        }),
    );
    const genuinePreviousRecord = parseInstallRecord(
      yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8")),
    );
    assert(
      objectProperty(genuinePreviousRecord, "optional_selections")?.["coding"] === true,
      "the previous stable coding selection is invalid",
    );
    const genuinePreviousDryRun = yield* runInternalUpgrade(
      options.currentEntry,
      codexHome,
      environment,
      true,
    );
    assert(
      genuinePreviousDryRun.ok,
      `the unmodified previous-stable record failed upgrade dry-run (${genuinePreviousDryRun.ok ? "unexpected success" : genuinePreviousDryRun.error.message})`,
    );
    activeRecordPath = join(codexHome, "holycodex/active.toml");
    yield* rewriteActiveRecord(activeRecordPath, previousModule, rewriteForLegacyWork);
    const previousRecord = parseInstallRecord(
      yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8")),
    ) as Record<string, unknown>;
    // The PATH executable may be the previous managed installation, so derive upgrade ownership
    // from the persisted record rather than treating every PATH match as user-owned.
    const previousContext7 = objectProperty(objectProperty(previousRecord, "tooling"), "context7");
    const expectedContext7Ownership = previousContext7?.["ownership"];
    assert(
      expectedContext7Ownership === "holycodex" || expectedContext7Ownership === "user",
      "the previous package did not persist Context7 ownership",
    );
    assert(
      previousRecord["version"] === previousVersion,
      "the previous install record is not exact",
    );
    assert(
      objectProperty(previousRecord, "optional_selections")?.["work"] === true,
      "the previous package did not install the legacy Work capability",
    );
    yield* Effect.tryPromise(() => rm(fixturePluginSource, { recursive: true, force: true }));
    yield* stageFixturePlugin(options.currentInstalledPackageRoot, fixturePluginSource);
    const beforeDryRun = yield* snapshotDirectoryBytes(codexHome);
    const dryRun = yield* runInternalUpgrade(options.currentEntry, codexHome, environment, true);
    assert(
      dryRun.ok,
      `the real previous-stable upgrade dry-run failed (${dryRun.ok ? "unexpected success" : `${dryRun.error.code}: ${dryRun.error.message}`})`,
    );
    if (dryRun.ok) {
      assert(
        hasProperty(dryRun.data, "status") && dryRun.data["status"] === "dry_run",
        "the real previous-stable upgrade dry-run did not report dry_run",
      );
    }
    assert(
      JSON.stringify(yield* snapshotDirectoryBytes(codexHome)) === JSON.stringify(beforeDryRun),
      "the real previous-stable upgrade dry-run changed isolated Codex-home bytes",
    );
    const upgraded = yield* runInternalUpgrade(options.currentEntry, codexHome, environment);
    assert(
      upgraded.ok,
      `the real previous-stable package upgrade failed (${upgraded.ok ? "unexpected success" : `${upgraded.error.code}: ${upgraded.error.message}`})`,
    );
    activeRecordPath = join(codexHome, "holycodex/active.toml");
    const upgradedRecord = parseInstallRecord(
      yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8")),
    ) as Record<string, unknown>;
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
    const previousContext7Executable = previousContext7?.["executable"];
    const upgradedContext7Executable = context7?.["executable"];
    const expectedUpgradeContext7Ownership =
      expectedContext7Ownership === "holycodex" &&
      previousContext7?.["manager"] === context7?.["manager"] &&
      typeof previousContext7?.["identity"] === "string" &&
      /^[0-9a-f]{64}$/u.test(previousContext7["identity"]) &&
      typeof previousContext7Executable === "string" &&
      typeof upgradedContext7Executable === "string" &&
      (yield* sameVerificationFile(previousContext7Executable, upgradedContext7Executable))
        ? "holycodex"
        : "user";
    assert(
      context7?.["manager"] === "bun" && context7["launcher"] === "bunx",
      "upgrade did not persist the injected Bun launcher identity for Context7",
    );
    yield* assertPersistedContext7(
      upgradedRecord,
      options.currentInstalledRoot,
      environment,
      options.commands,
      "previous stable upgrade",
      expectedUpgradeContext7Ownership,
    );
    const upgradedConfig = yield* Effect.tryPromise(() =>
      readFile(join(codexHome, "config.toml"), "utf8"),
    );
    assert(
      upgradedConfig.includes("[features.context_management]") &&
        upgradedConfig.includes("experimental_mode = true") &&
        upgradedConfig.includes('unrelated = "keep"'),
      "upgrade did not publish canonical configuration while preserving unrelated config",
    );
    const pluginList = parseCodexPluginList(
      (yield* Effect.tryPromise(() =>
        runChecked([codexFixture.executable, "plugin", "list", "--json"], {
          cwd: workspaceRoot,
          env: environment,
        }),
      )).stdout,
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
        yield* Effect.tryPromise(() =>
          readFile(join(codexHome, "plugins/holycodex/.codex-plugin/plugin.json"), "utf8"),
        ),
      ),
      "installed Codex plugin manifest",
    );
    assert(
      installedPluginManifest.version === options.currentCanonicalVersion,
      "upgrade did not publish the current HolyCodex plugin payload",
    );
    yield* assertCodexAppServerReadback(
      codexFixture.executable,
      environment,
      codexHome,
      options.codexCliVersion,
    );
    const doctor = yield* runCli(
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
      const currentModule = (yield* Effect.tryPromise(
        () => import(pathToFileURL(options.currentEntry).href),
      )) as InstalledCliModule;
      yield* rewriteActiveRecord(activeRecordPath, currentModule, (record) => ({
        ...record,
        version: options.currentCanonicalVersion,
      }));
      const sameBaseReconciliation = yield* runInternalUpgrade(
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
      const reconciledRecord = parseInstallRecord(
        yield* Effect.tryPromise(() => readFile(activeRecordPath, "utf8")),
      ) as Record<string, unknown>;
      assert(
        reconciledRecord["version"] === options.currentVersion,
        "same-base development reconciliation must record the running development artifact",
      );
    }
  });
}
function stageFixturePlugin(
  packageRoot: string,
  destination: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      cp(join(packageRoot, "dist/assets/plugin"), destination, {
        recursive: true,
        dereference: true,
      }),
    );
    yield* Effect.tryPromise(() => mkdir(join(destination, ".codex-plugin"), { recursive: true }));
    yield* Effect.tryPromise(() =>
      cp(join(destination, "plugin.json"), join(destination, ".codex-plugin/plugin.json")),
    );
  });
}
function snapshotDirectoryBytes(
  root: string,
): Effect.Effect<readonly (readonly [string, string])[], unknown> {
  return Effect.gen(function* () {
    const entries = yield* listPackageEntries(root);
    return yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.tryPromise(() => readFile(join(root, entry))).pipe(
          Effect.map((bytes) => [entry, Buffer.from(bytes).toString("base64")] as const),
        ),
      { concurrency: "unbounded" },
    );
  });
}
function runCli(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>> = allowlistedEnvironment(
    DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  ),
): Effect.Effect<typeof CliEnvelopeSchema.Type, unknown> {
  return Effect.gen(function* () {
    const result = yield* runCliResult(entry, args, cwd, commands, environment);
    assert(
      result.exitCode === 0,
      `CLI command ${["bun", entry, ...args].join(" ")} failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
    );
    return result.envelope;
  });
}
function runCliResult(
  entry: string,
  args: readonly string[],
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>> = allowlistedEnvironment(
    DEFAULT_COMMAND_ENVIRONMENT_KEYS,
  ),
): Effect.Effect<
  {
    readonly envelope: typeof CliEnvelopeSchema.Type;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  unknown
> {
  return Effect.gen(function* () {
    const command = ["bun", entry, ...args];
    commands.push(command.join(" "));
    const result = yield* Effect.tryPromise(() => runCommand(command, { cwd, env: environment }));
    return {
      envelope: parseEnvelope(result.stdout),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}
function parseInstallRecord(source: string): Record<string, unknown> {
  return decodeStateText(source, Schema.Record(Schema.String, Schema.Unknown));
}
function rewriteActiveRecord(
  path: string,
  installedModule: InstalledCliModule,
  rewrite: (record: Record<string, unknown>) => Record<string, unknown>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const current = parseInstallRecord(yield* Effect.tryPromise(() => readFile(path, "utf8")));
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
    const record = {
      ...rewritten,
      digest: yield* Effect.tryPromise(() => installedModule.installRecordDigest(digestInput)),
    };
    if (path.endsWith(".json")) yield* Effect.tryPromise(() => writeJson(path, record));
    else yield* Effect.tryPromise(() => writeAtomicState(path, record as JsonValue));
  });
}
function rewriteForLegacyWork(record: Record<string, unknown>): Record<string, unknown> {
  const optionalSelections = objectProperty(record, "optional_selections");
  const explicitOptionalSelections = objectProperty(record, "explicit_optional_selections");
  const capabilityState = objectProperty(record, "capability_state");
  const officialPlugins = arrayProperty(record, "official_plugins") ?? [];
  const ownedPlugins = arrayProperty(record, "owned_plugins") ?? [];
  return {
    ...record,
    optional_selections: {
      frontend: false,
      security: false,
      ...optionalSelections,
      coding: true,
      work: true,
    },
    explicit_optional_selections: { ...explicitOptionalSelections, work: true },
    capability_state: {
      frontend: { selected: false, status: "disabled", plugin_ids: [] },
      security: { selected: false, status: "disabled", plugin_ids: [] },
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
function runInstalledExecutable(
  executable: string,
  cwd: string,
  commands: string[],
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<typeof CliEnvelopeSchema.Type, unknown> {
  return Effect.gen(function* () {
    const args = ["version", "--json"];
    const command = [executable, ...args];
    commands.push(command.join(" "));
    const result = yield* Effect.tryPromise(() => runCommand(command, { cwd, env: environment }));
    assert(
      result.exitCode === 0,
      `executable bin failed with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
    );
    return parseEnvelope(result.stdout);
  });
}
function runInstalledAgentHelp(
  entry: string,
  cwd: string,
  commands: string[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
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
        const result = yield* Effect.tryPromise(() =>
          runCommand(command, { cwd, env: environment }),
        );
        assert(
          result.exitCode === 0,
          `agent CLI help failed for ${args.join(" ")} with exit ${result.exitCode}: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
        );
        assert(result.stderr.length === 0, "agent CLI help wrote diagnostics to stderr");
        assert(!result.stdout.includes("\u001b"), "agent CLI help emitted ANSI");
        assert(
          result.stdout.includes("holycodex-agent"),
          "agent CLI help omitted its command name",
        );
      }
    }
  });
}
function runInstalledOpenTuiProbe(
  cwd: string,
  entry: string,
  commands: string[],
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const command = [process.execPath, "-e", 'await import("@opentui/core");'];
    commands.push(command.join(" "));
    const result = yield* Effect.tryPromise(() => runCommand(command, { cwd, env }));
    assert(
      result.exitCode === 0,
      `installed OpenTUI runtime could not resolve: ${redactDiagnostics(result.stderr || result.stdout, env)}`,
    );
    assert(result.stderr.length === 0, "installed OpenTUI runtime wrote diagnostics to stderr");
    const interactive = yield* runInstalledOpenTuiBehaviorProbe(cwd, entry, env);
    assert(
      interactive.exitCode === 0,
      `installed OpenTUI wizard behavior probe failed: ${redactDiagnostics(interactive.stderr || interactive.stdout, env)}`,
    );
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
    assert(probe["hints"] === true, "installed OpenTUI wizard omitted its navigation hints");
    assert(probe["noColor"] === true, "installed OpenTUI wizard ignored NO_COLOR");
  });
}
function runInstalledOpenTuiBehaviorProbe(
  cwd: string,
  entry: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<
  {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  unknown
> {
  return Effect.gen(function* () {
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
const probeTimeout = setTimeout(() => {
  process.stderr.write("OpenTUI probe timed out. Visible screen:\n" + visibleOutput());
  process.exit(2);
}, 120000);
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
await pushUntilVisible(
  "\r",
  () => visibleOutput().includes("Review configuration") && visibleOutput().includes(reviewHint),
);
input.push(Buffer.from([3]));

const result = await wizard;
clearTimeout(probeTimeout);
const rendered = currentOutput();
const visible = visibleOutput();
realStdout.write(
  "__HOLYCODEX_OPENTUI_PROBE__" +
    JSON.stringify({
      result: result.action,
      review: visible.includes("Review configuration"),
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
    return yield* Effect.all(
      [
        readBoundedStreamEffect(result.stdout, 256 * 1024),
        readBoundedStreamEffect(result.stderr, 256 * 1024),
        Effect.tryPromise(() => result.exited),
      ],
      { concurrency: 3 },
    ).pipe(Effect.map(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr })));
  });
}
function readBoundedStreamEffect(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Effect.Effect<string, unknown> {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const next = yield* Effect.tryPromise(() => reader.read());
          if (next.done) break;
          total += next.value.byteLength;
          if (total > limit) {
            return yield* Effect.fail(
              new Error("OpenTUI behavior probe output exceeded its limit"),
            );
          }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder().decode(bytes);
      }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  );
}
function sameVerificationFile(left: string, right: string): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const resolvedLeft = resolve(left);
    const resolvedRight = resolve(right);
    const samePath = (leftPath: string, rightPath: string): boolean =>
      process.platform === "win32"
        ? resolve(leftPath).toLowerCase() === resolve(rightPath).toLowerCase()
        : resolve(leftPath) === resolve(rightPath);
    if (samePath(resolvedLeft, resolvedRight)) return true;
    return yield* Effect.all(
      [Effect.tryPromise(() => realpath(left)), Effect.tryPromise(() => realpath(right))],
      {
        concurrency: 2,
      },
    ).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: ([canonicalLeft, canonicalRight]) => samePath(canonicalLeft, canonicalRight),
      }),
    );
  });
}
function assertPersistedContext7(
  record: Record<string, unknown>,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  commands: string[],
  label: string,
  expectedOwnership: "holycodex" | "user" = "holycodex",
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    assert(record["owner"] === "holycodex", `${label} record has the wrong installation owner`);
    const context7 = objectProperty(objectProperty(record, "tooling"), "context7");
    assert(context7 !== undefined, `${label} did not persist Context7 tooling state`);
    assert(
      context7["manager"] === "bun" && context7["launcher"] === "bunx",
      `${label} did not persist the Bun Context7 manager and launcher`,
    );
    assert(
      context7["ownership"] === expectedOwnership,
      `${label} did not persist the expected Context7 ownership (${expectedOwnership})`,
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
    const result = yield* Effect.tryPromise(() => runCommand(command, { cwd, env: environment }));
    assert(
      result.exitCode === 0 && result.stderr.length === 0,
      `${label} Context7 executable could not be invoked: ${redactDiagnostics(result.stderr || result.stdout, environment)}`,
    );
    assert(
      result.stdout.includes(version),
      `${label} Context7 executable version does not match persisted state`,
    );
  });
}
function createCodexFixture(
  codexHome: string,
  codexCliVersion: string,
): Effect.Effect<
  Readonly<{
    binDirectory: string;
    executable: string;
  }>,
  unknown
> {
  return Effect.gen(function* () {
    const binDirectory = join(dirname(codexHome), "fake-codex-bin");
    yield* Effect.tryPromise(() => mkdir(binDirectory, { recursive: true }));
    const programPath = join(binDirectory, "fake-codex.mjs");
    yield* Effect.tryPromise(() =>
      writeFile(programPath, fakeCodexProgram(codexCliVersion), {
        encoding: "utf8",
        mode: 0o600,
      }),
    );
    if (process.platform === "win32") {
      const executable = join(binDirectory, "codex.exe");
      yield* Effect.tryPromise(() =>
        runChecked(
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
        ),
      );
      return { binDirectory, executable };
    }
    const executable = join(binDirectory, "codex");
    yield* Effect.tryPromise(() =>
      writeFile(executable, `#!/usr/bin/env bun\n${fakeCodexProgram(codexCliVersion)}`, {
        encoding: "utf8",
        mode: 0o700,
      }),
    );
    yield* Effect.tryPromise(() => chmod(executable, 0o700));
    return { binDirectory, executable };
  });
}
function assertCodexAppServerReadback(
  executable: string,
  environment: Readonly<Record<string, string | undefined>>,
  codexHome: string,
  codexCliVersion: string,
  expectedRootModel?: string,
  legacyRootOnly = false,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const transport = new BunStdioTransport({ executablePath: executable, environment });
    const client = new AppServerClient(transport, { requestTimeoutMs: 120000 });
    const verification = Effect.gen(function* () {
      const initialize = yield* Effect.tryPromise(() => client.initialize());
      assert(
        initialize.userAgent === codexCliVersion,
        "Codex App Server returned a version different from generated provenance",
      );
      assert(
        initialize.protocolVersion ===
          `codex-app-server-${codexCliVersion.slice("codex-cli ".length)}`,
        "Codex App Server returned a protocol version different from generated provenance",
      );
      const readback = yield* Effect.tryPromise(() =>
        client.readConfig({ includeLayers: true, cwd: codexHome }),
      );
      const highProfile = PROFILE_CATALOG.find((profile) => profile.name === "high");
      assert(highProfile !== undefined, "the high profile is missing from the route catalog");
      assert(
        readback.config["model"] === (expectedRootModel ?? highProfile.root.model) &&
          readback.config["model_reasoning_effort"] ===
            (legacyRootOnly ? "high" : highProfile.root.effort),
        `Codex App Server config readback changed the high-profile Root route (expected ${JSON.stringify(expectedRootModel ?? highProfile.root.model)}/${legacyRootOnly ? "high" : highProfile.root.effort}, received ${JSON.stringify(readback.config["model"])}/${JSON.stringify(readback.config["model_reasoning_effort"])})`,
      );
      if (legacyRootOnly) return;
      const features = readback.config["features"];
      assert(
        typeof features === "object" && features !== null && !Array.isArray(features),
        "Codex App Server config readback omitted managed Root features",
      );
      const rootFeatures = features as Record<string, unknown>;
      const multiAgentV2 = rootFeatures["multi_agent_v2"];
      assert(
        rootFeatures["multi_agent"] === true &&
          typeof multiAgentV2 === "object" &&
          multiAgentV2 !== null &&
          !Array.isArray(multiAgentV2) &&
          (multiAgentV2 as Record<string, unknown>)["enabled"] === false &&
          rootFeatures["agent_message_board"] === false,
        "Codex App Server config readback omitted the managed Root V1 selection",
      );
      const agents = readback.config["agents"];
      assert(
        typeof agents === "object" &&
          agents !== null &&
          !Array.isArray(agents) &&
          (agents as Record<string, unknown>)["enabled"] === true &&
          (agents as Record<string, unknown>)["max_depth"] === 1 &&
          (agents as Record<string, unknown>)["max_concurrent_threads_per_session"] === 21,
        "Codex App Server config readback omitted the managed Root specialist depth and concurrency limits",
      );
      const modelCatalogPath = readback.config["model_catalog_json"];
      assert(
        typeof modelCatalogPath === "string",
        "Codex App Server config readback omitted the managed model catalog path",
      );
      const modelCatalog = JSON.parse(
        yield* Effect.tryPromise(() =>
          readFile(
            isAbsolute(modelCatalogPath) ? modelCatalogPath : resolve(codexHome, modelCatalogPath),
            "utf8",
          ),
        ),
      ) as { models?: readonly { slug?: string; multi_agent_version?: string }[] };
      const rootModels = modelCatalog.models?.filter(
        (model) => model.slug === (expectedRootModel ?? highProfile.root.model),
      );
      assert(
        rootModels?.length === 1 && rootModels[0]?.multi_agent_version === "v1",
        "Codex App Server config readback did not resolve the managed Root model to V1",
      );
      const rootInstructions = readback.config["developer_instructions"];
      assert(
        typeof rootInstructions === "string" &&
          rootInstructions.toLowerCase().includes("bounded assignment") &&
          rootInstructions.toLowerCase().includes("exact concrete registered role.task agent_type"),
        "Codex App Server config readback changed the high-profile Root instruction projection",
      );
      assert(
        typeof agents === "object" && agents !== null && !Array.isArray(agents),
        "Codex App Server config readback omitted role registrations",
      );
      const agentTable = agents as Record<string, unknown>;
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
        const active = parseInstallRecord(
          yield* Effect.tryPromise(() =>
            readFile(join(codexHome, "holycodex/active.toml"), "utf8"),
          ),
        ) as {
          managed_artifacts?: readonly {
            path: string;
          }[];
        };
        const expectedReference = active.managed_artifacts?.find((artifact) =>
          artifact.path.endsWith(`/${agentType}.toml`),
        )?.path;
        assert(
          typeof expectedReference === "string" &&
            /^holycodex\/agents\/[a-f0-9]{20}\//u.test(expectedReference) &&
            configuredPath === expectedReference,
          `Codex App Server config readback changed the active ${agentType} artifact reference`,
        );
        const expectedPath = isAbsolute(expectedReference)
          ? resolve(expectedReference)
          : resolve(codexHome, expectedReference);
        const comparableReadbackPath =
          process.platform === "win32" ? readbackPath.toLowerCase() : readbackPath;
        const comparableExpectedPath =
          process.platform === "win32" ? expectedPath.toLowerCase() : expectedPath;
        assert(
          comparableReadbackPath === comparableExpectedPath,
          `Codex App Server config readback resolved ${agentType} outside the active installed generation`,
        );
        const roleDocument = parseConfig(
          yield* Effect.tryPromise(() => readFile(readbackPath, "utf8")),
        );
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
      }
    });
    const withDiagnostics = verification.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const diagnostics = transport.diagnostics.join("; ");
          const configText = yield* Effect.tryPromise(() =>
            readFile(join(codexHome, "config.toml"), "utf8"),
          ).pipe(Effect.match({ onFailure: () => "", onSuccess: (text) => text }));
          const shellIndex = configText.indexOf("developer_instructions");
          const configSnippet = configText
            .slice(shellIndex < 0 ? 0 : shellIndex, shellIndex < 0 ? 512 : shellIndex + 1024)
            .replaceAll(/\s+/gu, " ");
          const configProbe = `configDeveloper=${configText.includes("developer_instructions")} configSnippet=${configSnippet}`;
          const installerDebug = yield* Effect.tryPromise(() =>
            readFile(join(codexHome, ".holycodex-debug.log"), "utf8"),
          ).pipe(Effect.match({ onFailure: () => "", onSuccess: (text) => text }));
          const suffix =
            diagnostics.length > 0
              ? `${diagnostics}; ${configProbe}; ${installerDebug}`
              : `${configProbe}; ${installerDebug}`;
          return yield* Effect.fail(new Error(`${Cause.pretty(cause)} (${suffix})`));
        }),
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.succeed(undefined),
      () => withDiagnostics,
      () => Effect.tryPromise(() => client.close()),
    );
  });
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
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
const BUNDLED_PROVIDERS = ["browser@openai-bundled", "sites@openai-bundled"];
const ADDITIONAL = "additional@fixture";
const STATE_PATH = HOME === undefined ? "" : join(HOME, "fixture-codex-state.json");
const SNAPSHOT_ROOT = HOME === undefined ? "" : join(HOME, "plugins", "openai-plugins");
const SNAPSHOT_PATH = join(SNAPSHOT_ROOT, "marketplace.json");
const BUNDLED_MODEL_CATALOG = BUNDLED_MODEL_CATALOG_PLACEHOLDER;

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
    const known = new Set([HOLY, ...PROVIDERS, ...BUNDLED_PROVIDERS, ADDITIONAL]);
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

async function writeObservedPluginState(pluginId, enabled) {
  const separator = pluginId.lastIndexOf("@");
  const name = pluginId.slice(0, separator);
  const marketplace = pluginId.slice(separator + 1);
  const versionRoot = join(HOME, "plugins", "cache", marketplace, name, "fixture");
  if (enabled) {
    await mkdir(join(versionRoot, ".codex-plugin"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(versionRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name, version: "fixture" }) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
  } else {
    await rm(join(HOME, "plugins", "cache", marketplace, name), { recursive: true, force: true });
  }
  const configPath = join(HOME, "config.toml");
  let config = await readFile(configPath, "utf8");
  const header = "[plugins." + JSON.stringify(pluginId) + "]";
  const start = config.indexOf(header);
  if (start < 0) {
    config += "\n" + header + "\nenabled = " + enabled + "\n";
  } else {
    const next = config.indexOf("\n[", start + header.length);
    const end = next < 0 ? config.length : next;
    const section = config.slice(start, end);
    const updated = /(^|\n)enabled\s*=\s*(?:true|false)/u.test(section)
      ? section.replace(/(^|\n)enabled\s*=\s*(?:true|false)/u, "$1enabled = " + enabled)
      : section + "\nenabled = " + enabled;
    config = config.slice(0, start) + updated + config.slice(end);
  }
  await writeFile(configPath, config, "utf8");
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
    ...BUNDLED_PROVIDERS,
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

async function listMarketplaces() {
  const state = await readState();
  return {
    marketplaces: state.marketplaces.includes(MARKETPLACE)
      ? [
          {
            name: "holycodex",
            root: join(HOME, "plugins", "marketplaces", "holycodex"),
            marketplaceSource: { sourceType: "git", source: MARKETPLACE },
          },
        ]
      : [],
  };
}

async function addPlugin(pluginId) {
  const state = await readState();
  if (
    pluginId !== HOLY &&
    !PROVIDERS.includes(pluginId) &&
    !BUNDLED_PROVIDERS.includes(pluginId) &&
    pluginId !== ADDITIONAL
  ) {
    fail("fixture rejected an unselected plugin");
  }
  if (pluginId === HOLY) {
    if (!state.marketplaces.includes(MARKETPLACE)) fail("HolyCodex marketplace was not registered");
    const source = join(HOME, "fixture-plugin-source");
    const manifest = JSON.parse(await readFile(join(source, ".codex-plugin", "plugin.json"), "utf8"));
    if (manifest.name !== "holycodex" || typeof manifest.version !== "string") fail("HolyCodex plugin manifest is invalid");
    const skills = await readdir(join(source, "skills"), { withFileTypes: true });
    const skill = skills.find((entry) => entry.isDirectory());
    if (skill === undefined) fail("HolyCodex plugin source has no skills");
    await readFile(join(source, "skills", skill.name, "SKILL.md"), "utf8");
    const destination = join(HOME, "plugins", "holycodex");
    await rm(destination, { recursive: true, force: true });
    await mkdir(join(HOME, "plugins"), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, dereference: true });
  } else if (
    !BUNDLED_PROVIDERS.includes(pluginId) &&
    pluginId !== ADDITIONAL &&
    !(await hasOfficialProvider(pluginId.slice(0, pluginId.lastIndexOf("@"))))
  ) {
    fail("selected official provider is absent from Codex startup snapshot");
  }
  if (!state.installed.includes(pluginId)) state.installed.push(pluginId);
  await writeObservedPluginState(pluginId, true);
  await saveState(state);
  process.stdout.write(JSON.stringify({ pluginId, installedPath: pluginId === HOLY ? join(HOME, "plugins", "holycodex") : undefined }) + "\n");
}

async function removePlugin(pluginId) {
  const state = await readState();
  if (!state.installed.includes(pluginId)) fail("plugin is not installed");
  state.installed = state.installed.filter((candidate) => candidate !== pluginId);
  await writeObservedPluginState(pluginId, false);
  if (pluginId === HOLY) await rm(join(HOME, "plugins", "holycodex"), { recursive: true, force: true });
  await saveState(state);
  process.stdout.write(JSON.stringify({ pluginId, removed: true }) + "\n");
}

function readFeatureBoolean(document, table, key) {
  let current = document;
  for (const part of [...table.split("."), key]) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

async function configRead() {
  const text = await readFile(join(HOME, "config.toml"), "utf8");
  const rootDocument = Bun.TOML.parse(text);
  const rootFeature = (key) =>
    key === "multi_agent_v2"
      ? readFeatureBoolean(rootDocument, "features.multi_agent_v2", "enabled")
      : readFeatureBoolean(rootDocument, "features", key);
  const activeToml = await readFile(join(HOME, "holycodex", "active.toml"), "utf8").catch(() => undefined);
  const active = activeToml === undefined
    ? JSON.parse(await readFile(join(HOME, "holycodex", "active.json"), "utf8"))
    : Bun.TOML.parse(activeToml).record;
  const allowLegacyConfig =
    (await readFile(join(HOME, ".holycodex-legacy-config"), "utf8").catch(() => "")) === "1\n";
  function rootStringSetting(name) {
    const prefix = name + " = ";
    const line = text.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
    if (line === undefined) fail("Codex config omitted " + name);
    const value = JSON.parse(line.slice(prefix.length));
    if (typeof value !== "string") fail("Codex config has an invalid " + name);
    return value;
  }
  if (allowLegacyConfig) {
    return {
      config: {
        model: rootStringSetting("model"),
        model_reasoning_effort: rootStringSetting("model_reasoning_effort"),
      },
      origins: {},
      layers: null,
    };
  }
  if (rootFeature("multi_agent") !== true) {
    fail("Codex config omitted the canonical Root multi-agent mode");
  }
  if (rootFeature("default_mode_request_user_input") !== true) {
    fail("Codex config omitted Root request_user_input support: " + JSON.stringify(rootDocument.features));
  }
  if (rootFeature("multi_agent_v2") !== false) {
    fail("Codex config omitted the intended Root multi-agent v1 selection");
  }
  if (rootFeature("agent_message_board") !== false) {
    fail("Codex config omitted terminal-only specialist messaging enforcement");
  }
  const rootAgents = rootDocument.agents;
  if (
    typeof rootAgents !== "object" ||
    rootAgents === null ||
    rootAgents.enabled !== true ||
    rootAgents.max_depth !== 1 ||
    rootAgents.max_concurrent_threads_per_session !== 21
  ) {
    fail("Codex config omitted the canonical Root specialist depth and concurrency limits");
  }
  const experimentalContextManagement =
    readFeatureBoolean(rootDocument, "features.context_management", "experimental_mode") === true;
  const modelCatalogPath = rootStringSetting("model_catalog_json");
  const modelCatalog = JSON.parse(
    await readFile(isAbsolute(modelCatalogPath) ? modelCatalogPath : resolve(HOME, modelCatalogPath), "utf8"),
  );
  const rootModelMatches = Array.isArray(modelCatalog?.models)
    ? modelCatalog.models.filter((model) => model?.slug === rootStringSetting("model"))
    : [];
  if (
    rootModelMatches.length !== 1 ||
    rootModelMatches[0]?.supports_experimental_context !== experimentalContextManagement ||
    rootModelMatches[0]?.multi_agent_version !== "v1"
  ) {
    fail("Codex config model catalog does not match the current Root capabilities and V1 selection");
  }
  if (/thread_tools/u.test(text)) {
    fail("Codex config contains an unsupported feature setting");
  }
  const rootInstructions = rootStringSetting("developer_instructions").toLowerCase();
  if (
    !rootInstructions.includes("delegate all delegable work") ||
    !rootInstructions.includes("through bounded assignments") ||
    !rootInstructions.includes("exact concrete registered role.task agent_type") ||
    !rootInstructions.includes("root uses visual-loop") ||
    !rootInstructions.includes("use dev-server")
  ) {
    fail("Codex config omitted the Root orchestration boundaries");
  }
  if (
    !rootInstructions.includes("multi_agent_v1.wait_agent") ||
    !rootInstructions.includes("use timeout_ms=600000 exactly") ||
    !rootInstructions.includes("never sleep or busy-poll for specialist coordination") ||
    !rootInstructions.includes("do not inspect, message, poll, request status from, or follow up with a running specialist") ||
    !rootInstructions.includes("prefer compatible warm reuse only when the exact predicate allows it") ||
    !rootInstructions.includes("dispatch every ready scheduling-independent assignment before waiting")
  ) {
    fail("Codex config omitted V1 report-driven Root coordination and warm specialist reuse");
  }
  if (
    !rootInstructions.includes("exact concrete registered role.task agent_type") ||
    !["explorer", "librarian", "worker", "reviewer", "labels"].every((term) =>
      rootInstructions.includes(term),
    ) ||
    !rootInstructions.includes("generic built-in agent_type values") ||
    !["default", "worker", "explorer", "reviewer", "librarian"].every((agentType) =>
      rootInstructions.includes(agentType),
    ) ||
    !rootInstructions.includes("are forbidden")
  ) {
    fail("Codex config retained ambiguous specialist dispatch policy");
  }
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
    const managedArtifacts = Array.isArray(active.managed_artifacts)
      ? active.managed_artifacts
      : [];
    const roleArtifact = managedArtifacts.find(
      (artifact) => artifact?.path === configFile,
    );
    const roleSegments = configFile.split("/");
    if (
      roleArtifact === undefined ||
      roleSegments.length !== 4 ||
      roleSegments[0] !== "holycodex" ||
      roleSegments[1] !== "agents" ||
      !/^[a-f0-9]{20}$/u.test(roleSegments[2] ?? "") ||
      roleSegments[3] !== agentType + ".toml"
    ) {
      fail("Codex config points " + agentType + " outside the active managed generation");
    }
    const roleText = await readFile(rolePath, "utf8");
    const roleDocument = Bun.TOML.parse(roleText);
    if (!roleText.includes('model = "gpt-6-luna"')) {
      fail("Codex role file omitted the configured specialist routing model");
    }
    if (/thread_tools|computer_use|browser_use|in_app_browser/u.test(roleText)) {
      fail("Codex role file contains an unsupported feature setting");
    }
    if (
      roleDocument.features?.multi_agent !== undefined ||
      roleDocument.features?.multi_agent_v2 !== undefined ||
      roleDocument.features?.agent_message_board !== undefined
    ) {
      fail("Codex role file contains unsupported shadow specialist enforcement settings");
    }
    if (roleText.includes("tool_output_token_limit")) {
      fail("Codex role file contains the removed tool_output_token_limit");
    }
    const roleInstructionLine = roleText.split(/\r?\n/u).find((line) => line.startsWith("developer_instructions = "));
    const roleInstructions = roleInstructionLine === undefined
      ? ""
      : JSON.parse(roleInstructionLine.slice("developer_instructions = ".length));
    if (
      typeof roleInstructions !== "string" ||
      !roleInstructions.toLowerCase().includes("batch scheduling-independent operations") ||
      !roleInstructions.toLowerCase().includes("avoid duplicate reads, tool calls, and model boundaries") ||
      !roleInstructions.toLowerCase().includes("without truncating required evidence") ||
      !roleInstructions.toLowerCase().includes("combine deterministic capability discovery with the operation when safe") ||
      !roleInstructions.toLowerCase().includes("return exactly one compact, evidence-first terminal outcome") ||
      !roleInstructions.toLowerCase().includes("do not report progress before the terminal result")
    ) {
      fail("Codex role file omitted terminal-only specialist reporting boundaries");
    }
  }
  return { config: rootDocument, origins: {}, layers: null };
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
          try {
            process.stdout.write(JSON.stringify({ id: message.id, result: await configRead() }) + "\n");
          } catch (error) {
            process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "fixture config read failed" } }) + "\n");
          }
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
  if (
    args.length === 3 &&
    args[0] === "debug" &&
    args[1] === "models" &&
    args[2] === "--bundled"
  ) {
    process.stdout.write(JSON.stringify(BUNDLED_MODEL_CATALOG) + "\n");
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
  if (
    args.length === 4 &&
    args[0] === "plugin" &&
    args[1] === "marketplace" &&
    args[2] === "list" &&
    args[3] === "--json"
  ) {
    process.stdout.write(JSON.stringify(await listMarketplaces()) + "\n");
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
  if (args.length === 4 && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "upgrade") {
    if (args[3] !== "holycodex") fail("fixture rejected an unexpected marketplace refresh");
    const state = await readState();
    if (!state.marketplaces.includes(MARKETPLACE)) fail("HolyCodex marketplace was not registered");
    process.stdout.write("Upgraded marketplace holycodex.\n");
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
    .replace("AGENT_TYPES_PLACEHOLDER", JSON.stringify(NATIVE_AGENT_TYPES))
    .replace(
      "BUNDLED_MODEL_CATALOG_PLACEHOLDER",
      JSON.stringify(JSON.parse(currentModelCatalogJson())),
    );
}
function readPublicManifest(): Effect.Effect<PublicManifest, unknown> {
  return Effect.gen(function* () {
    const raw: unknown = JSON.parse(
      yield* Effect.tryPromise(() => readFile(join(cliRoot, "package.json"), "utf8")),
    );
    const parsed = Schema.decodeUnknownResult(PublicManifestSchema, {
      onExcessProperty: "ignore",
    })(raw);
    if (Result.isFailure(parsed)) {
      throw new Error(`The public package manifest is invalid: ${String(parsed.failure)}`);
    }
    const workspaceRaw: unknown = JSON.parse(
      yield* Effect.tryPromise(() => readFile(join(workspaceRoot, "package.json"), "utf8")),
    );
    const workspace = Schema.decodeUnknownResult(WorkspaceManifestSchema, {
      onExcessProperty: "ignore",
    })(workspaceRaw);
    if (Result.isFailure(workspace)) {
      throw new Error(`The workspace manifest is invalid: ${String(workspace.failure)}`);
    }
    const dependencies: Record<string, string> = {};
    for (const [name, version] of Object.entries(parsed.success.dependencies)) {
      if (version !== "catalog:") {
        dependencies[name] = version;
        continue;
      }
      const catalogVersion = workspace.success.catalog[name];
      if (catalogVersion === undefined) {
        throw new Error(`The workspace catalog is missing ${name}.`);
      }
      dependencies[name] = catalogVersion;
    }
    return { ...parsed.success, dependencies };
  });
}
function readInstalledManifest(path: string): Effect.Effect<PublicManifest, unknown> {
  return Effect.gen(function* () {
    const raw: unknown = JSON.parse(yield* Effect.tryPromise(() => readFile(path, "utf8")));
    const parsed = Schema.decodeUnknownResult(PublicManifestSchema, {
      onExcessProperty: "ignore",
    })(raw);
    if (Result.isFailure(parsed)) {
      throw new Error(`The installed package manifest is invalid: ${String(parsed.failure)}`);
    }
    return parsed.success;
  });
}
function listPackageEntries(
  root: string,
  current = root,
): Effect.Effect<readonly string[], unknown> {
  return Effect.gen(function* () {
    const files: string[] = [];
    for (const entry of yield* Effect.tryPromise(() => readdir(current, { withFileTypes: true }))) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`The staged package may not contain symlinks: ${absolute}`);
      }
      if (entry.isDirectory()) {
        files.push(...(yield* listPackageEntries(root, absolute)));
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).split("\\").join("/"));
      } else {
        throw new Error(`The staged package contains a non-file entry: ${absolute}`);
      }
    }
    return files.sort();
  });
}
function assertAllowedEntries(entries: readonly string[], manifest: PublicManifest): void {
  for (const entry of entries) {
    const allowed =
      entry === "package.json" ||
      manifest.files.some((root) => entry === root || entry.startsWith(`${root}/`));
    assert(allowed, `the staged package contains an undeclared entry: ${entry}`);
  }
}
function findInstalledExecutable(installedRoot: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    for (const candidate of [
      join(installedRoot, "node_modules/.bin/holycodex"),
      join(installedRoot, "node_modules/.bin/holycodex.cmd"),
      join(installedRoot, "node_modules/.bin/holycodex.exe"),
    ]) {
      if (yield* exists(candidate)) {
        return candidate;
      }
    }
    throw new Error("the installed executable bin is missing");
  });
}
function findCommandOnPath(
  name: string,
  searchPath: string | undefined,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const directory of (searchPath ?? "").split(delimiter)) {
      for (const extension of extensions) {
        const candidate = join(directory, `${name}${extension}`);
        if (yield* exists(candidate)) return candidate;
      }
    }
    return yield* Effect.fail(
      new Error(`the ${name} launcher is missing from the package verification PATH`),
    );
  });
}
function createReleaseStamp(options: PackageReleaseOptions): typeof ReleaseStampSchema.Type {
  const parsed = Schema.decodeUnknownResult(ReleaseStampSchema)({
    schemaVersion: "holycodex-release-v1",
    channel: options.channel,
    sourceSha: options.sourceSha,
  });
  if (Result.isFailure(parsed)) {
    throw new Error(`The release stamp is invalid: ${String(parsed.failure)}`);
  }
  return parsed.success;
}
function parseEnvelope(stdout: string): typeof CliEnvelopeSchema.Type {
  const raw: unknown = JSON.parse(stdout);
  const parsed = Schema.decodeUnknownResult(CliEnvelopeSchema)(raw);
  if (Result.isFailure(parsed)) {
    throw new Error(
      `CLI package verification envelope failed validation: ${String(parsed.failure)}`,
    );
  }
  return parsed.success;
}
function decode<A>(schema: Schema.Decoder<A>, value: unknown, label: string): A {
  const parsed = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(parsed)) {
    throw new Error(`${label} is invalid: ${String(parsed.failure)}`);
  }
  return parsed.success;
}
function requireFile(path: string, label: string): Effect.Effect<void, unknown> {
  return Effect.tryPromise(() => access(path)).pipe(
    Effect.mapError(() => new Error(label + " is missing: " + path)),
  );
}
function exists(path: string): Effect.Effect<boolean, unknown> {
  return Effect.tryPromise(() => access(path)).pipe(
    Effect.match({ onFailure: () => false, onSuccess: () => true }),
  );
}
function runWithCleanup<A>(
  action: () => Effect.Effect<A, unknown>,
  cleanup: () => Effect.Effect<void, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.acquireUseRelease(Effect.succeed(undefined), action, cleanup);
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
const VerificationObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const VerificationArraySchema = Schema.Array(Schema.Unknown);
function hasProperty(value: unknown, key: string): value is Record<string, unknown> {
  const parsed = Schema.decodeUnknownResult(VerificationObjectSchema)(value);
  return Result.isSuccess(parsed) && Object.hasOwn(parsed.success, key);
}
function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!hasProperty(value, key)) return undefined;
  const parsed = Schema.decodeUnknownResult(VerificationObjectSchema)(value[key]);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}
function arrayProperty(value: unknown, key: string): readonly unknown[] | undefined {
  if (!hasProperty(value, key)) return undefined;
  const parsed = Schema.decodeUnknownResult(VerificationArraySchema)(value[key]);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}
if (import.meta.main) {
  await Effect.runPromise(
    runPackageVerificationEffect().pipe(
      Effect.match({
        onFailure: (error) => {
          console.error(
            JSON.stringify({
              status: "failed",
              message: error instanceof Error ? error.message : "package verification failed",
            }),
          );
          process.exitCode = 1;
        },
        onSuccess: (result) => console.log(JSON.stringify({ status: "verified", ...result })),
      }),
    ),
  );
}

/** Promise adapter for the published package-verification API boundary. */
export function packPublicPackage(
  temporaryRoot: string,
  options?: PackageReleaseOptions,
): Promise<PackedPublicPackage> {
  return Effect.runPromise(packPublicPackageEffect(temporaryRoot, options));
}

/** Promise adapter for the published package-verification API boundary. */
export function verifyPublicPackage(
  packed: PackedPublicPackage,
  codexCliVersion?: string,
): Promise<PackageVerificationResult> {
  return Effect.runPromise(verifyPublicPackageEffect(packed, codexCliVersion));
}

/** Promise adapter for the published package-verification API boundary. */
export function assertPackedEntries(
  tarballPath: string,
  expectedEntries: readonly string[],
): Promise<void> {
  return Effect.runPromise(assertPackedEntriesEffect(tarballPath, expectedEntries));
}

/** Promise adapter for the published package-verification API boundary. */
export function sha256File(path: string): Promise<string> {
  return Effect.runPromise(sha256FileEffect(path));
}

/** Promise adapter for the published package-verification API boundary. */
export function runPackageVerification(): Promise<PackageVerificationResult> {
  return Effect.runPromise(runPackageVerificationEffect());
}

function withVerificationDirectory<A>(
  prefix: string,
  use: (path: string) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.acquireUseRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), prefix + "-"))),
    use,
    (path) => Effect.tryPromise(() => rm(path, { recursive: true, force: true })),
  );
}
