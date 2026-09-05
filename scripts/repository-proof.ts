// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { canonicalJsonUtf8, domainSeparatedSha256 } from "../packages/core/src/canonical.ts";
import { ensureCodexGenerated } from "./generate-codex-bindings.ts";
import { runChecked, runCommand } from "./process.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPaths = [
  "packages/agent/package.json",
  "packages/core/package.json",
  "packages/codex/package.json",
  "packages/plugin/package.json",
  "packages/cli/package.json",
] as const;

const ManifestSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  private: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  packageManager: Schema.optional(Schema.String),
  catalog: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  scripts: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  dependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  devDependencies: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});
type Manifest = typeof ManifestSchema.Type;

const AdapterInventorySchema = Schema.Struct({
  schema_epoch: Schema.Literal("validation-effect-promise-adapters-1"),
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String.pipe(Schema.minLength(1)),
      markers: Schema.Array(Schema.String.pipe(Schema.minLength(1))),
      reason: Schema.String.pipe(Schema.minLength(1)),
    }),
  ),
});

const adapterInventoryPath = resolve(workspaceRoot, "tests/fixtures/effect-promise-adapters.json");

const authoredCodeExtensions = new Set([".ts", ".yml", ".yaml"]);

export interface RepositoryProof {
  readonly checks: readonly string[];
  readonly generatedArtifactDigest: string;
  readonly generatedArtifactFiles: number;
}

export async function runRepositoryProof(): Promise<RepositoryProof> {
  await ensureCodexGenerated();
  const rootManifest = await readManifest("package.json");
  const mise = await readText("mise.toml");
  const lockfile = await readText("bun.lock");
  const packageBuild = await readText("scripts/package-build.ts");
  const notices = await readText("THIRD-PARTY-NOTICES.md");
  const cliContract = await readText("docs/CLI.md");
  const behaviorContract = await readText("docs/BEHAVIOR.md");
  const configurationContract = await readText("docs/CONFIGURATION.md");
  const installationContract = await readText("docs/INSTALLATION.md");
  const workflowFiles = await listFiles(".github/workflows");

  assert(rootManifest.packageManager === "bun@1.4.1", "root packageManager must resolve Bun 1.4.1");
  assert(mise.includes('bun = "1.4"'), "mise must select the Bun 1.4 line");
  assert(mise.includes('node = "26"'), "mise must select the Node 26 line");
  assert(
    rootManifest.scripts?.["validate"] === "bun scripts/validate.ts",
    "validate must be the repository gate",
  );
  assert(!rootManifest.scripts?.["publish"], "the root scripts must not declare publication");
  assert(!rootManifest.scripts?.["deploy"], "the root scripts must not declare deployment");
  assert(
    !Object.values(rootManifest.scripts ?? {}).some((script) => /\b(?:vp|vitest)\b/iu.test(script)),
    "root scripts must not invoke Vite+ or Vitest",
  );
  for (const [dependency, range] of Object.entries(rootManifest.catalog ?? {})) {
    assert(
      /^(?:\^[1-9]\d*\.\d+\.\d+|~0\.\d+\.\d+)$/u.test(range),
      `${dependency} must use a compatibility-line range`,
    );
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
    behaviorContract.includes("gpt-6-astra") && behaviorContract.includes("gpt-5.6-luna"),
    "behavior must record the canonical Astra/Luna routes",
  );
  assert(
    configurationContract.includes("manages `features.context_management.experimental_mode`") &&
      configurationContract.includes("writes\n`true`"),
    "configuration must explicitly manage context experimental mode",
  );
  assert(
    installationContract.includes("Existing serialized `plan` fields") &&
      installationContract.includes("Legacy `go`"),
    "installation docs must define deterministic legacy profile migration",
  );

  const manifests = await Promise.all(packageManifestPaths.map((path) => readManifest(path)));
  for (const manifest of manifests) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    assert(!("arktype" in dependencies), `${manifest.name} must not depend on ArkType`);
    assert(
      !("@effect/schema" in dependencies),
      `${manifest.name} must not depend on @effect/schema`,
    );
  }

  const packageSources = await listFiles("packages");
  for (const path of packageSources.filter((candidate) => candidate.startsWith("packages/"))) {
    if (!path.endsWith(".ts") || path.includes("/generated/")) {
      continue;
    }
    const source = await readText(path);
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
    const source = (await listFiles(owner))
      .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"))
      .map((path) => readText(path));
    const contents = (await Promise.all(source)).join("\n");
    assert(
      contents.includes('from "effect/Schema"'),
      `${owner} must use Effect Schema at its boundary`,
    );
  }

  const authoredFiles = (await listFiles("."))
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
    const content = await readText(path);
    assert(
      content.startsWith("// SPDX-License-Identifier: Apache-2.0") ||
        content.startsWith("# SPDX-License-Identifier: Apache-2.0"),
      `${path} is missing its SPDX header`,
    );
  }

  const adapterInventory = await readAdapterInventory();
  const inventoryPaths = new Set(adapterInventory.entries.map((entry) => entry.path));
  const adapterMarkers = /Effect\.(?:runPromise|runPromiseExit|tryPromise)/u;
  for (const path of packageSources.filter((candidate) => candidate.endsWith(".ts"))) {
    if (path.endsWith(".test.ts") || path.includes("/generated/")) {
      continue;
    }
    const source = await readText(path);
    if (adapterMarkers.test(source)) {
      assert(inventoryPaths.has(path), `${path} has an unreviewed Effect-to-Promise adapter`);
    }
  }
  for (const entry of adapterInventory.entries) {
    const source = await readText(entry.path);
    for (const marker of entry.markers) {
      assert(
        source.includes(marker),
        `${entry.path} no longer contains inventory marker ${marker}`,
      );
    }
  }

  assert(workflowFiles.length > 0, "at least one checked-in GitHub Actions workflow is required");
  for (const path of workflowFiles) {
    const workflow = await readText(path);
    assert(workflow.includes("contents: read"), `${path} must use least-read permissions`);
    if (path === ".github/workflows/publish.yml") {
      assert(workflow.includes("push:"), `${path} must publish from push events`);
      assert(workflow.includes("main"), `${path} must include the main development channel`);
      assert(workflow.includes("tags:"), `${path} must include the stable tag channel`);
      assert(workflow.includes('"v*.*.*"'), `${path} must filter stable version tags`);
      assert(workflow.includes('"!v*.*.*-*"'), `${path} must exclude prerelease tags`);
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
      assert(workflow.includes("--tag dev"), `${path} must publish development versions under dev`);
      assert(
        workflow.includes("--tag latest"),
        `${path} must publish stable versions under latest`,
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
      assert(workflow.includes("pull_request:"), `${path} must preserve pull request validation`);
      assert(workflow.includes("workflow_dispatch:"), `${path} must preserve dispatch validation`);
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
        await assertRepositoryLocalReference(path, reference);
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
  const generated = await verifyGeneratedArtifactPortable();
  await verifyIgnoreContract();
  await runChecked(["git", "diff", "--check"], { cwd: workspaceRoot });
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
}

async function verifyIgnoreContract(): Promise<void> {
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
    const result = await runCommand(["git", "check-ignore", "--no-index", "--quiet", path], {
      cwd: workspaceRoot,
    });
    assert(result.exitCode === 0, `${path} must be ignored`);
  }
  for (const path of mustTrack) {
    const result = await runCommand(["git", "check-ignore", "--no-index", "--quiet", path], {
      cwd: workspaceRoot,
    });
    assert(result.exitCode === 1, `${path} must remain trackable`);
  }
  const ignoredTracked = await runChecked(["git", "ls-files", "-ci", "--exclude-standard"], {
    cwd: workspaceRoot,
  });
  assert(ignoredTracked.stdout.trim() === "", "tracked files must not match .gitignore");
}

const generatedArtifactRoot = resolve(workspaceRoot, "packages/codex/generated");
const Sha256Schema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
const GeneratedProvenanceSchema = Schema.Struct({
  schema_version: Schema.Literal("holycodex-generated-v2"),
  artifact_root: Schema.Literal("packages/codex/generated"),
  codex_cli_version: Schema.String.pipe(Schema.pattern(/^codex-cli \d+\.\d+\.\d+$/u)),
  codex_cli_digest: Sha256Schema,
  protocol_epoch: Schema.String.pipe(Schema.pattern(/^codex-app-server-\d+\.\d+\.\d+$/u)),
  generator: Schema.Struct({
    command: Schema.Tuple(Schema.Literal("app-server"), Schema.Literal("generate-ts")),
    supported_surface: Schema.Literal("codex app-server generators"),
  }),
  typescript_root: Schema.Literal("typescript"),
  files: Schema.Struct({
    count: Schema.Number.pipe(Schema.int(), Schema.positive()),
    digest: Sha256Schema,
  }),
});

export async function verifyGeneratedArtifactPortable(
  artifactRoot: string = generatedArtifactRoot,
): Promise<{
  readonly inventory: { readonly count: number; readonly digest: string };
}> {
  const resolvedArtifactRoot = resolve(artifactRoot);
  await assertNoSymlinkBoundary(resolvedArtifactRoot);
  const provenanceRaw: unknown = JSON.parse(
    await readFile(join(resolvedArtifactRoot, "provenance.json"), "utf8"),
  );
  const parsed = Schema.decodeUnknownEither(GeneratedProvenanceSchema, {
    onExcessProperty: "preserve",
  })(provenanceRaw);
  if (Either.isLeft(parsed)) {
    throw new Error(`Generated artifact provenance is invalid: ${String(parsed.left)}`);
  }
  const files: Array<{ readonly path: string; readonly size: number; readonly sha256: string }> =
    [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("Generated artifacts may not contain symlinks.");
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Generated artifacts contain a non-file entry.");
      }
      if (entry.name === "provenance.json") {
        continue;
      }
      const relativePath = relative(resolvedArtifactRoot, absolute).split("\\").join("/");
      if (!relativePath.startsWith("typescript/")) {
        throw new Error(`Generated artifact file is outside its declared roots: ${relativePath}`);
      }
      if (metadata.size <= 0 || metadata.size > 4 * 1024 * 1024) {
        throw new Error(`Generated artifact file has an invalid size: ${relativePath}`);
      }
      const bytes = await readFile(absolute);
      files.push({ path: relativePath, size: bytes.byteLength, sha256: await sha256(bytes) });
    }
  };
  await visit(resolvedArtifactRoot);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const digest = await domainSeparatedSha256("codex-schema-output", [canonicalJsonUtf8(files)]);
  if (files.length !== parsed.right.files.count || digest !== parsed.right.files.digest) {
    throw new Error("Generated artifact provenance does not match its portable inventory digest.");
  }
  return { inventory: { count: files.length, digest } };
}

async function assertNoSymlinkBoundary(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error("Generated artifacts may not contain symlinked roots.");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readAdapterInventory(): Promise<typeof AdapterInventorySchema.Type> {
  const raw: unknown = JSON.parse(await readFile(adapterInventoryPath, "utf8"));
  const parsed = Schema.decodeUnknownEither(AdapterInventorySchema, {
    onExcessProperty: "error",
  })(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`Effect-to-Promise adapter inventory is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

async function readManifest(path: string): Promise<Manifest> {
  const raw: unknown = JSON.parse(await readFile(resolve(workspaceRoot, path), "utf8"));
  const parsed = Schema.decodeUnknownEither(ManifestSchema)(raw);
  if (Either.isLeft(parsed)) {
    throw new Error(`${path} is invalid: ${String(parsed.left)}`);
  }
  return parsed.right;
}

async function readText(path: string): Promise<string> {
  return await readFile(resolve(workspaceRoot, path), "utf8");
}

async function listFiles(path: string): Promise<readonly string[]> {
  const absolute = resolve(workspaceRoot, path);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error: unknown) {
    if (isFsCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    const relativePath = relative(workspaceRoot, child).split("\\").join("/");
    if (entry.isDirectory()) {
      if (!shouldSkipDirectory(relativePath)) {
        files.push(...(await listFiles(relativePath)));
      }
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function assertRepositoryLocalReference(
  workflowPath: string,
  reference: string,
): Promise<void> {
  const localPath = reference.slice(2);
  const absolute = resolve(workspaceRoot, localPath);
  const relativePath = relative(workspaceRoot, absolute).split("\\").join("/");
  assert(
    localPath.length > 0 &&
      !localPath.includes("\\") &&
      !/^(?:\.\.(?:\/|$)|\/|[A-Za-z]:\/)/u.test(relativePath),
    `${workflowPath} uses an invalid repository-local reference ${reference}`,
  );
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch {
    metadata = undefined;
  }
  assert(
    metadata !== undefined &&
      !metadata.isSymbolicLink() &&
      (metadata.isFile() || metadata.isDirectory()),
    `${workflowPath} uses a missing or non-local repository reference ${reference}`,
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
  try {
    const result = await runRepositoryProof();
    console.log(JSON.stringify({ status: "verified", ...result }));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "repository proof failed",
      }),
    );
    process.exitCode = 1;
  }
}
