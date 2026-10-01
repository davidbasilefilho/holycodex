// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { canonicalJsonUtf8, domainSeparatedSha256 } from "../packages/core/src/canonical.ts";
import { PROFILE_CATALOG } from "../packages/core/src/catalog.ts";
import { NATIVE_AGENT_TYPES } from "../packages/core/src/routes.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import { runCheckedEffect, runCommandEffect } from "./process.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPaths = [
  "packages/agent/package.json",
  "packages/core/package.json",
  "packages/codex/package.json",
  "packages/plugin/package.json",
  "packages/cli/package.json",
] as const;

const ManifestSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  private: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type Manifest = typeof ManifestSchema.Type;

const AdapterInventorySchema = Schema.Struct({
  schema_epoch: Schema.Literals(["validation-effect-promise-adapters-1"]),
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1)),
      markers: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
      reason: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
});

const adapterInventoryPath = resolve(workspaceRoot, "tests/fixtures/effect-promise-adapters.json");

const authoredCodeExtensions = new Set([".ts", ".yml", ".yaml"]);

/** Evidence collected by the repository architecture and generated-artifact checks. */
export interface RepositoryProof {
  /** Names of the repository invariants that passed. */
  readonly checks: readonly string[];
  /** Digest identifying the generated Codex artifact set. */
  readonly generatedArtifactDigest: string;
  /** Number of generated Codex artifact files covered by the digest. */
  readonly generatedArtifactFiles: number;
}

/** Run repository architecture, workflow, and generated-artifact proof checks. */
export function runRepositoryProof(): Effect.Effect<RepositoryProof, unknown> {
  return Effect.gen(function* () {
    yield* ensureCodexGenerated();
    const rootManifest = yield* readManifest("package.json");
    const mise = yield* readText("mise.toml");
    const lockfile = yield* readText("bun.lock");
    const packageBuild = yield* readText("scripts/package-build.ts");
    const notices = yield* readText("THIRD-PARTY-NOTICES.md");
    const cliContract = yield* readText("docs/CLI.md");
    const behaviorContract = yield* readText("docs/BEHAVIOR.md");
    const configurationContract = yield* readText("docs/CONFIGURATION.md");
    const installationContract = yield* readText("docs/INSTALLATION.md");
    const readme = yield* readText("README.md");
    const packageVerification = yield* readText("scripts/package-verification.ts");
    const workflowFiles = yield* listFiles(".github/workflows");

    assert(
      rootManifest.packageManager === "bun@1.4.2",
      "root packageManager must resolve Bun 1.4.2",
    );
    assert(mise.includes('bun = "1.4"'), "mise must select the Bun 1.4 line");
    assert(!/\bnode\s*=|npm:@openai\/codex/u.test(mise), "mise must manage Bun only");
    assert(
      rootManifest.devDependencies?.["@openai/codex"] !== undefined,
      "the root development dependencies must own Codex generation",
    );
    const codexRange = rootManifest.devDependencies["@openai/codex"]!;
    const lockedCodexVersion =
      /^    "@openai\/codex": \["@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)"/mu.exec(lockfile)?.[1];
    assert(
      codexRange === "latest" && lockedCodexVersion !== undefined,
      "bun.lock must resolve the root-owned Codex dependency declared with the latest dist-tag",
    );
    assert(
      rootManifest.scripts?.["validate"] === "bun scripts/validate.ts",
      "validate must be the repository gate",
    );
    assert(!rootManifest.scripts?.["publish"], "the root scripts must not declare publication");
    assert(!rootManifest.scripts?.["deploy"], "the root scripts must not declare deployment");
    assert(
      !Object.values(rootManifest.scripts ?? {}).some((script) =>
        /\b(?:vp|vitest)\b/iu.test(script),
      ),
      "root scripts must not invoke Vite+ or Vitest",
    );
    for (const [dependency, range] of Object.entries(rootManifest.catalog ?? {})) {
      assert(/^\^\d+\.\d+\.\d+$/u.test(range), `${dependency} must use a compatibility-line range`);
    }
    assert(packageBuild.includes("Bun.build"), "package build must use Bun.build");
    assert(packageBuild.includes('"@opentui/core"'), "package build must externalize OpenTUI");
    assert(
      packageBuild.includes("packages/agent/src/index.ts"),
      "package build must include agent CLI",
    );
    assert(!lockfile.includes("arktype"), "the lockfile must not retain ArkType packages");
    assert(!/\n\s+"vitest": \[/u.test(lockfile), "the lockfile must not retain Vitest");
    assert(
      !/\n\s+"vite-plus": \[/u.test(lockfile),
      "the lockfile must not retain Vite+ as a package",
    );
    assert(cliContract.includes("--profile <name>"), "the public CLI must expose --profile");
    assert(!cliContract.includes("--plan <name>"), "the public CLI must not expose --plan");
    assert(
      /The live profiles are\s+`low`, `default`, and `high`/u.test(behaviorContract),
      "behavior must define only the live low/default/high profiles",
    );
    assert(
      behaviorContract.includes("low = gpt-6.1-sol/low") &&
        behaviorContract.includes("default = gpt-6.1-sol/medium") &&
        behaviorContract.includes("high = gpt-6.1-sol/medium") &&
        behaviorContract.includes("gpt-6-luna"),
      "behavior must record the canonical GPT-6.1 Sol profile mapping and Luna specialist route",
    );
    assert(
      PROFILE_CATALOG.every(
        (profile) =>
          String(profile.root.effort) !== "max" &&
          profile.routes.every((route) => String(route.effort) !== "max"),
      ),
      "live Root and specialist routes must not use max effort",
    );
    assert(
      behaviorContract.includes("No live Root or specialist route uses `xhigh` or `max` effort"),
      "behavior must document that live Root and specialist routes use neither xhigh nor max effort",
    );
    assert(
      behaviorContract.includes("every Root `collaboration.wait_agent` call uses") &&
        behaviorContract.includes("`timeout_ms = 600000` (10 minutes)") &&
        behaviorContract.includes("regardless of the situation") &&
        behaviorContract.includes("including 10 seconds, are forbidden"),
      "behavior must require the exact ten-minute timeout for every Root wait_agent call",
    );
    assert(
      behaviorContract.includes(
        "it does not message, poll, request status from, or follow up with a running",
      ) &&
        behaviorContract.includes("does not use `sleep` or status loops") &&
        behaviorContract.includes("prefers a suitable warm specialist") &&
        behaviorContract.includes("already-known independent Assignments before waiting"),
      "behavior must define report-driven Root coordination, exact wait discipline, and warm reuse",
    );
    assert(
      behaviorContract.includes(
        "shared specialist baseline automatically projects all-tool efficiency",
      ) &&
        behaviorContract.includes("no arbitrary output cap") &&
        behaviorContract.includes("Complete mergeable work and required proof"),
      "behavior must define automatic shared specialist efficiency guidance without weakening proof",
    );
    assert(
      configurationContract.includes("features.context_management.experimental_mode = true") &&
        configurationContract.includes("Removal restores the recorded prior value") &&
        behaviorContract.includes("The package migration recognizes owned") &&
        behaviorContract.includes("historical state only when ownership evidence is safe"),
      "configuration and behavior must define nested context-management ownership and safe migration",
    );
    assert(
      behaviorContract.includes("Worker.validation") &&
        behaviorContract.includes("features.context_management.experimental_mode = true"),
      "behavior must define validation and nested context-management contracts",
    );
    for (const agentType of NATIVE_AGENT_TYPES) {
      assert(
        behaviorContract.includes(`\`${agentType}\``),
        `behavior must document canonical route ${agentType}`,
      );
      assert(
        readme.includes(`\`${agentType}\``),
        `README must document canonical route ${agentType}`,
      );
      assert(
        installationContract.includes(`\`${agentType}\``),
        `installation must document canonical route ${agentType}`,
      );
    }
    assert(
      !/eleven canonical|eleven leaf/iu.test(
        `${behaviorContract}\n${installationContract}\n${cliContract}`,
      ),
      "route prose must not retain stale canonical leaf counts",
    );
    assert(
      !cliContract.includes("holycodex upgrade") &&
        cliContract.includes("`--dry-run` is available only with `version`"),
      "CLI contract must exclude the removed public upgrade command and scope dry-run to version",
    );
    assert(
      packageVerification.includes("[features.context_management]") &&
        packageVerification.includes("experimental_mode = true") &&
        packageVerification.includes("NATIVE_AGENT_TYPES") &&
        packageVerification.includes("upgrade") &&
        packageVerification.includes("non_tty_confirmation_required"),
      "package proof must exercise nested context-management configuration, upgrade, and confirmation boundaries",
    );
    assert(
      installationContract.includes("Existing serialized `plan` fields") &&
        installationContract.includes("Legacy `go`"),
      "installation docs must define deterministic legacy profile migration",
    );

    const manifests = yield* Effect.all(
      packageManifestPaths.map((path) => readManifest(path)),
      { concurrency: 4 },
    );
    for (const manifest of manifests) {
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      assert(!("arktype" in dependencies), `${manifest.name} must not depend on ArkType`);
      assert(
        !("@effect/schema" in dependencies),
        `${manifest.name} must not depend on @effect/schema`,
      );
    }

    const packageSources = yield* listFiles("packages");
    for (const path of packageSources.filter((candidate) => candidate.startsWith("packages/"))) {
      if (!path.endsWith(".ts") || path.includes("/generated/")) {
        continue;
      }
      const source = yield* readText(path);
      assert(
        !/arktype|@effect\/schema/iu.test(source),
        `${path} contains a forbidden validator artifact`,
      );
    }

    const schemaOwners = [
      "packages/core/src",
      "packages/codex/src",
      "packages/plugin/src",
      "packages/cli/src",
    ] as const;
    for (const owner of schemaOwners) {
      const source = (yield* listFiles(owner))
        .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
        .map((path) => readText(path));
      const contents = (yield* Effect.all(source, { concurrency: 4 })).join("\n");
      assert(
        contents.includes('from "effect/Schema"'),
        `${owner} must use Effect Schema at its boundary`,
      );
    }

    const authoredFiles = (yield* listFiles("."))
      .filter((path) => authoredCodeExtensions.has(extension(path)))
      .filter(
        (path) =>
          path.startsWith("scripts/") ||
          path.startsWith("tests/") ||
          (path.startsWith("packages/") && path.includes("/src/")) ||
          path.startsWith(".github/workflows/"),
      )
      .filter((path) => !isGeneratedOrTransient(path));
    for (const path of authoredFiles) {
      const content = yield* readText(path);
      assert(
        content.startsWith("// SPDX-License-Identifier: Apache-2.0") ||
          content.startsWith("# SPDX-License-Identifier: Apache-2.0"),
        `${path} is missing its SPDX header`,
      );
    }

    const adapterInventory = yield* readAdapterInventory();
    const inventoryPaths = new Set(adapterInventory.entries.map((entry) => entry.path));
    const adapterMarkers = /Effect\.(?:runPromise|runPromiseExit|tryPromise)/u;
    for (const path of packageSources.filter((candidate) => candidate.endsWith(".ts"))) {
      if (path.endsWith(".test.ts") || path.includes("/generated/")) {
        continue;
      }
      const source = yield* readText(path);
      if (adapterMarkers.test(source)) {
        assert(inventoryPaths.has(path), `${path} has an unreviewed Effect-to-Promise adapter`);
      }
    }
    for (const entry of adapterInventory.entries) {
      const source = yield* readText(entry.path);
      for (const marker of entry.markers) {
        assert(
          source.includes(marker),
          `${entry.path} no longer contains inventory marker ${marker}`,
        );
      }
    }

    assert(workflowFiles.length > 0, "at least one checked-in GitHub Actions workflow is required");
    for (const path of workflowFiles) {
      const workflow = yield* readText(path);
      assert(workflow.includes("contents: read"), `${path} must use least-read permissions`);
      if (path === ".github/workflows/publish.yml") {
        assert(workflow.includes("push:"), `${path} must publish from push events`);
        assert(
          workflow.includes("pull_request:"),
          `${path} must package development builds for pull requests`,
        );
        assert(
          workflow.includes(
            'elif [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then\n            CHANNEL=dev',
          ),
          `${path} must resolve pull requests to the development channel`,
        );
        assert(
          workflow.includes("SOURCE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}"),
          `${path} must validate and package the exact pull request head SHA`,
        );
        assert(workflow.includes("main"), `${path} must include the main development channel`);
        assert(workflow.includes("tags:"), `${path} must include the stable tag channel`);
        assert(workflow.includes('"v*.*.*"'), `${path} must filter stable version tags`);
        assert(
          workflow.includes('"!v*.*.*-dev.*"'),
          `${path} must exclude generated development tags`,
        );
        assert(workflow.includes("workflow_dispatch:"), `${path} must preserve dispatch control`);
        assert(
          workflow.includes("./.github/workflows/validation.yml"),
          `${path} must reuse the repository validation gate`,
        );
        assert(
          workflow.includes("bunx npm@12 publish") &&
            !/bunx npm@\d+\.\d+(?:\.\d+)?\s+publish/u.test(workflow),
          `${path} must publish through the current-major trusted-publishing npm CLI`,
        );
        assert(!workflow.includes("bun publish"), `${path} must not publish through Bun`);
        assert(
          workflow.includes('if [ "$RELEASE_CHANNEL" = dev ]') &&
            /if \[ "\$RELEASE_CHANNEL" = dev \]; then\s+NPM_TAG=dev\s+else\s+NPM_TAG=latest\s+fi[\s\S]*--tag "\$NPM_TAG"/u.test(
              workflow,
            ),
          `${path} must publish dev under dev and stable under latest using the selected npm tag`,
        );
        assert(
          workflow.includes("--prerelease"),
          `${path} must mark development releases prerelease`,
        );
        assert(workflow.includes("--verify-tag"), `${path} must verify stable tags before release`);
        assert(workflow.includes("--generate-notes"), `${path} must generate release notes`);
        assert(workflow.includes("check-npm"), `${path} must prove npm retry identity`);
        assert(workflow.includes("check-github"), `${path} must prove GitHub retry identity`);
        assert(
          workflow.includes('git rev-parse "${GITHUB_REF}^{commit}"'),
          `${path} must verify tag ancestry`,
        );
        assert(
          workflow.includes("needs: [prepare, validation]"),
          `${path} must gate publication jobs`,
        );
        assert(
          workflow.includes(
            "if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
          ),
          `${path} must restrict PR publication to same-repository heads`,
        );
        assert(
          workflow.includes("contents: write"),
          `${path} must grant release write access explicitly`,
        );
        assert(workflow.includes("id-token: write"), `${path} must request npm OIDC permissions`);
        assert(!workflow.includes("NPM_TOKEN"), `${path} must not use an npm token secret`);
        assert(
          !workflow.includes("NPM_CONFIG_TOKEN"),
          `${path} must not gate npm publication on a token`,
        );
        assert(
          !workflow.includes("Report unavailable npm publishing credentials"),
          `${path} must not warn about unavailable npm credentials`,
        );
        assert(
          !/\bnpm\s+(?:install|ci|test|run)\b/u.test(workflow),
          `${path} must not use npm outside final publication`,
        );
        const publishNpmStart = workflow.indexOf("  publish_npm:");
        const publishGithubStart = workflow.indexOf("  publish_github:");
        const publishNpm = workflow.slice(publishNpmStart, publishGithubStart);
        assert(
          !workflow.slice(0, publishNpmStart).includes("id-token: write"),
          `${path} must scope OIDC access to npm publication`,
        );
        assert(
          publishNpm.includes("contents: read"),
          `${path} npm publication must retain read access`,
        );
        assert(
          publishNpm.includes("id-token: write"),
          `${path} npm publication must have OIDC access`,
        );
        assert(
          !workflow.slice(publishGithubStart).includes("id-token: write"),
          `${path} GitHub publication must not receive OIDC access`,
        );
      } else if (path === ".github/workflows/validation.yml") {
        assert(
          workflow.includes("push:\n    branches-ignore:\n      - main"),
          `${path} must leave main pushes to the release workflow`,
        );
        assert(
          !/^  pull_request:\s*$/mu.test(workflow),
          `${path} must leave pull request validation to the release workflow`,
        );
        assert(
          workflow.includes("workflow_dispatch:"),
          `${path} must preserve dispatch validation`,
        );
        assert(workflow.includes("workflow_call:"), `${path} must expose reusable validation`);
        assert(
          workflow.includes("needs: validate"),
          `${path} release packaging must require validation`,
        );
        assert(
          workflow.includes("package-release.ts create"),
          `${path} must create the exact artifact`,
        );
        assert(
          workflow.includes("actions/upload-artifact@"),
          `${path} must upload the exact artifact`,
        );
        assert(
          workflow.includes("actions/download-artifact@"),
          `${path} must reuse the validated build`,
        );
      } else {
        assert(
          !/\b(?:bun\s+publish|gh\s+release\s+create|deploy|trusted publishing)\b/iu.test(workflow),
          `${path} declares an excluded external job`,
        );
      }
      const checkoutBlocks = workflow.split("uses: actions/checkout@").slice(1);
      assert(checkoutBlocks.length > 0, `${path} must check out its source explicitly`);
      for (const block of checkoutBlocks) {
        assert(block.includes("ref:"), `${path} must pin every checkout to the triggering SHA`);
      }
      for (const action of workflow.matchAll(/uses:\s*([^\s#]+)/gu)) {
        const reference = action[1] ?? "";
        if (reference.startsWith("./")) {
          yield* assertRepositoryLocalReference(path, reference);
          continue;
        }
        assert(
          reference.startsWith("actions/checkout@") ||
            reference.startsWith("actions/upload-artifact@") ||
            reference.startsWith("actions/download-artifact@") ||
            reference.startsWith("jdx/mise-action@"),
          `${path} uses an unapproved third-party action ${reference}`,
        );
        assert(/@[0-9a-f]{40}$/u.test(reference), `${path} must pin actions to an immutable SHA`);
      }
    }

    assert(notices.includes("effect"), "third-party notices must include Effect attribution");
    const generated = yield* verifyGeneratedArtifactPortable();
    yield* verifyIgnoreContract();
    yield* runCheckedEffect(["git", "diff", "--check"], { cwd: workspaceRoot });
    return {
      checks: [
        "dependency graph",
        "Effect Schema ownership",
        "SPDX headers",
        "Effect-to-Promise adapter inventory",
        "GitHub Actions shape",
        "license notices",
        "generated provenance and digest",
        "ignore contract",
        "clean diff whitespace",
      ],
      generatedArtifactDigest: generated.inventory.digest,
      generatedArtifactFiles: generated.inventory.count,
    };
  });
}

function verifyIgnoreContract(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const mustIgnore = [
      "node_modules/example.js",
      "packages/cli/dist/index.js",
      ".tmp/session/output.json",
      ".marketplace/marketplace.json",
      "release-artifacts/holycodex.tgz",
      ".holycodex/example-intent/intent.toon",
      ".env.local",
      ".npmrc",
      ".pypirc",
      ".aws/credentials",
      ".ssh/id_rsa",
      ".kube/config",
      ".terraform/terraform.tfstate",
      "terraform/production.tfstate",
      "packages/codex/generated/typescript/index.ts",
      "packages/codex/generated/provenance.json",
    ] as const;
    const mustTrack = [
      "packages/core/src/auth/provider.ts",
      "packages/core/src/private/types.ts",
      ".env.example",
      ".npmrc.example",
      ".pypirc.example",
      ".aws.example",
      ".ssh.example",
      ".kube.example",
      ".tfstate.example",
    ] as const;

    for (const path of mustIgnore) {
      const result = yield* runCommandEffect(
        ["git", "check-ignore", "--no-index", "--quiet", path],
        {
          cwd: workspaceRoot,
        },
      );
      assert(result.exitCode === 0, `${path} must be ignored`);
    }
    for (const path of mustTrack) {
      const result = yield* runCommandEffect(
        ["git", "check-ignore", "--no-index", "--quiet", path],
        {
          cwd: workspaceRoot,
        },
      );
      assert(result.exitCode === 1, `${path} must remain trackable`);
    }
    const ignoredTracked = yield* runCheckedEffect(
      ["git", "ls-files", "-ci", "--exclude-standard"],
      {
        cwd: workspaceRoot,
      },
    );
    assert(ignoredTracked.stdout.trim() === "", "tracked files must not match .gitignore");
  });
}

const generatedArtifactRoot = resolve(workspaceRoot, "packages/codex/generated");
const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const GeneratedProvenanceSchema = Schema.Struct({
  schema_version: Schema.Literals(["holycodex-generated-v2"]),
  artifact_root: Schema.Literals(["packages/codex/generated"]),
  codex_cli_version: Schema.String.check(Schema.isPattern(/^codex-cli \d+\.\d+\.\d+$/u)),
  codex_cli_digest: Sha256Schema,
  protocol_epoch: Schema.String.check(Schema.isPattern(/^codex-app-server-\d+\.\d+\.\d+$/u)),
  generator: Schema.Struct({
    command: Schema.Tuple([Schema.Literals(["app-server"]), Schema.Literals(["generate-ts"])]),
    supported_surface: Schema.Literals(["codex app-server generators"]),
  }),
  typescript_root: Schema.Literals(["typescript"]),
  files: Schema.Struct({
    count: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
    digest: Sha256Schema,
  }),
});

/** Verify that generated Codex artifacts remain portable across supported runtimes. */
export function verifyGeneratedArtifactPortable(
  artifactRoot: string = generatedArtifactRoot,
): Effect.Effect<
  {
    readonly inventory: { readonly count: number; readonly digest: string };
  },
  unknown
> {
  const resolvedArtifactRoot = resolve(artifactRoot);
  return Effect.gen(function* () {
    yield* assertNoSymlinkBoundary(resolvedArtifactRoot);
    const parsed = yield* readJson(
      GeneratedProvenanceSchema,
      join(resolvedArtifactRoot, "provenance.json"),
    );
    const files: Array<{ readonly path: string; readonly size: number; readonly sha256: string }> =
      [];
    const visit = (directory: string): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        for (const entry of yield* io(() => readdir(directory, { withFileTypes: true }))) {
          const absolute = join(directory, entry.name);
          const metadata = yield* io(() => lstat(absolute));
          if (metadata.isSymbolicLink()) {
            return yield* Effect.fail(new Error("Generated artifacts may not contain symlinks."));
          }
          if (metadata.isDirectory()) {
            yield* visit(absolute);
            continue;
          }
          if (!metadata.isFile()) {
            return yield* Effect.fail(new Error("Generated artifacts contain a non-file entry."));
          }
          if (entry.name === "provenance.json") {
            continue;
          }
          const relativePath = relative(resolvedArtifactRoot, absolute).split("\\").join("/");
          if (!relativePath.startsWith("typescript/")) {
            return yield* Effect.fail(
              new Error(`Generated artifact file is outside its declared roots: ${relativePath}`),
            );
          }
          if (metadata.size <= 0 || metadata.size > 4 * 1024 * 1024) {
            return yield* Effect.fail(
              new Error(`Generated artifact file has an invalid size: ${relativePath}`),
            );
          }
          const bytes = yield* io(() => readFile(absolute));
          files.push({ path: relativePath, size: bytes.byteLength, sha256: yield* sha256(bytes) });
        }
      });
    yield* visit(resolvedArtifactRoot);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const digest = yield* io(() =>
      domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(files)]),
    );
    if (files.length !== parsed.files.count || digest !== parsed.files.digest) {
      return yield* Effect.fail(
        new Error("Generated artifact provenance does not match its portable inventory digest."),
      );
    }
    return { inventory: { count: files.length, digest } };
  });
}

function assertNoSymlinkBoundary(path: string): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    let current = resolve(path);
    while (true) {
      const metadata = yield* io(() => lstat(current));
      if (metadata.isSymbolicLink())
        return yield* Effect.fail(
          new Error("Generated artifacts may not contain symlinked roots."),
        );
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  });
}

function sha256(bytes: Uint8Array): Effect.Effect<string, unknown> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return io(() => crypto.subtle.digest("SHA-256", copy.buffer)).pipe(
    Effect.map((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
}

function readAdapterInventory(): Effect.Effect<typeof AdapterInventorySchema.Type, unknown> {
  return readJson(AdapterInventorySchema, adapterInventoryPath);
}

function readManifest(path: string): Effect.Effect<Manifest, unknown> {
  return readJson(ManifestSchema, resolve(workspaceRoot, path)).pipe(
    Effect.mapError((error) => new Error(`${path} is invalid: ${String(error)}`)),
  );
}

function readText(path: string): Effect.Effect<string, unknown> {
  return io(() => readFile(resolve(workspaceRoot, path), "utf8"));
}

function readJson<A>(schema: Schema.Decoder<A>, path: string): Effect.Effect<A, unknown> {
  return io(() => readFile(path, "utf8")).pipe(
    Effect.flatMap((text) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)),
  );
}

function io<A>(operation: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (error) => error });
}

function listFiles(path: string): Effect.Effect<readonly string[], unknown> {
  const absolute = resolve(workspaceRoot, path);
  return Effect.gen(function* () {
    const entries = yield* io(() => readdir(absolute, { withFileTypes: true })).pipe(
      Effect.catch((error) =>
        isFsCode(error, "ENOENT") ? Effect.succeed([]) : Effect.fail(error),
      ),
    );
    const files: string[] = [];
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      const relativePath = relative(workspaceRoot, child).split("\\").join("/");
      if (entry.isDirectory()) {
        if (!shouldSkipDirectory(relativePath)) files.push(...(yield* listFiles(relativePath)));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
    return files.sort();
  });
}

function assertRepositoryLocalReference(
  workflowPath: string,
  reference: string,
): Effect.Effect<void, unknown> {
  const localPath = reference.slice(2);
  const absolute = resolve(workspaceRoot, localPath);
  const relativePath = relative(workspaceRoot, absolute).split("\\").join("/");
  assert(
    localPath.length > 0 &&
      !localPath.includes("\\") &&
      !/^(?:\.\.(?:\/|$)|\/|[A-Za-z]:\/)/u.test(relativePath),
    `${workflowPath} uses an invalid repository-local reference ${reference}`,
  );
  return io(() => lstat(absolute)).pipe(
    Effect.flatMap((metadata) =>
      metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())
        ? Effect.fail(
            new Error(
              `${workflowPath} uses a missing or non-local repository reference ${reference}`,
            ),
          )
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.fail(
        new Error(
          `${workflowPath} uses a missing or non-local repository reference ${reference}: ${String(error)}`,
        ),
      ),
    ),
  );
}

function shouldSkipDirectory(path: string): boolean {
  return (
    path === ".git" ||
    path === "node_modules" ||
    path.startsWith(".git/") ||
    path.startsWith("node_modules/") ||
    path.startsWith("dist/") ||
    path.startsWith("coverage/") ||
    path.startsWith("tmp/") ||
    path.startsWith("temp/") ||
    path === ".holycodex" ||
    path.startsWith(".holycodex/") ||
    path.startsWith(".vite/") ||
    path.startsWith(".vp/")
  );
}

function isGeneratedOrTransient(path: string): boolean {
  return (
    path === "bun.lock" ||
    path.startsWith("node_modules/") ||
    path.startsWith("packages/codex/generated/") ||
    /^(?:dist|coverage|tmp|temp|scratch|out|build|\.git|\.vite|\.vp|\.cache|\.holycodex)\//u.test(
      path,
    )
  );
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index);
}

function isFsCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

if (import.meta.main) {
  await Effect.runPromise(
    runRepositoryProof().pipe(
      Effect.tap((result) =>
        Effect.sync(() => console.log(JSON.stringify({ status: "verified", ...result }))),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error(
            JSON.stringify({
              status: "failed",
              message: Cause.pretty(cause),
            }),
          );
          process.exitCode = 1;
        }),
      ),
    ),
  );
}
