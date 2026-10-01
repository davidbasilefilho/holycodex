// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

import { canonicalJsonUtf8, domainSeparatedSha256 } from "@holycodex/core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  Context7Manager,
  Context7ToolState,
  InstallerFileSystem,
  InstallerPlatform,
  InstallerProcessResult,
  InstallerRuntime,
} from "./types.ts";

/** Public CLI value for context7 spec. */
export const CONTEXT7_SPEC = "ctx7@latest";

type Context7StateWithIdentity = Context7ToolState & {
  readonly identity?: string | undefined;
};

type Context7Inspection = Readonly<{
  readonly version: string;
  readonly executable: string;
  readonly identity: string;
}>;

const execFileAsync = promisify(execFile);
const promiseEffect = <A>(operation: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: operation, catch: (error) => error });
const run = (
  runtime: InstallerRuntime,
  executable: string,
  args: readonly string[],
): Effect.Effect<InstallerProcessResult, unknown> =>
  Effect.tryPromise({ try: () => runtime.run(executable, args), catch: (error) => error });
const ProcessErrorOutputSchema = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
const Context7PackageSchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.optional(Schema.String),
    bin: Schema.optional(
      Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const nodeFiles: InstallerFileSystem = {
  access,
  readText: (path) => readFile(path, "utf8"),
  realpath,
};

/** Create the injectable platform/process boundary used by optional tooling management. */
export function createInstallerRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InstallerRuntime {
  return {
    platform: process.platform as InstallerPlatform,
    environment,
    processPath: process.execPath,
    files: nodeFiles,
    run: (executable, args) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                execFileAsync(executable, [...args], {
                  encoding: "utf8",
                  windowsHide: true,
                  env: { ...process.env, ...environment },
                  timeout: 120_000,
                  maxBuffer: 4 * 1024 * 1024,
                }),
              catch: (error) => error,
            }),
          );
          if (result._tag === "Success")
            return { exitCode: 0, stdout: result.success.stdout, stderr: result.success.stderr };
          const errorOutput = Schema.decodeUnknownResult(ProcessErrorOutputSchema)(result.failure);
          const details = Result.isSuccess(errorOutput) ? errorOutput.success : {};
          return {
            exitCode: typeof details.code === "number" ? details.code : 1,
            stdout: details.stdout ?? "",
            stderr:
              details.stderr ??
              (result.failure instanceof Error ? result.failure.message : "process failed"),
          };
        }),
      ),
  };
}

/** Resolve the launcher's package-manager family without using registry-origin heuristics. */
export function detectContext7Manager(
  environment: Readonly<Record<string, string | undefined>>,
): Context7Manager | undefined {
  const execPath = normalize(environment["npm_execpath"] ?? "");
  const command = (environment["npm_command"] ?? "").toLowerCase();
  const agent = (environment["npm_config_user_agent"] ?? "").toLowerCase();
  if (execPath.includes("yarn") || execPath.includes("corepack") || agent.startsWith("yarn/")) {
    return undefined;
  }
  if (isExecutable(execPath, "pnpm") && command === "dlx") {
    return { launcher: "pnpm dlx", family: "pnpm", executable: "pnpm" };
  }
  if (isExecutable(execPath, "bunx") || (isExecutable(execPath, "bun") && command === "exec")) {
    return { launcher: "bunx", family: "bun", executable: "bun" };
  }
  if (
    isExecutable(execPath, "npx") ||
    execPath.endsWith("/npx-cli.js") ||
    (isExecutable(execPath, "npm") && command === "exec") ||
    (execPath.endsWith("/npm-cli.js") && command === "exec")
  ) {
    return { launcher: "npx", family: "npm", executable: "npm" };
  }
  return undefined;
}

/** Use a working PATH ctx7, installing a managed copy only when needed. */
export function ensureContext7(
  runtime: InstallerRuntime,
  mutate: boolean,
  previous?: Context7ToolState,
): Promise<Context7ToolState> {
  return Effect.runPromise(ensureContext7Effect(runtime, mutate, previous));
}

function ensureContext7Effect(
  runtime: InstallerRuntime,
  mutate: boolean,
  previous?: Context7ToolState,
): Effect.Effect<Context7ToolState, unknown> {
  return Effect.gen(function* () {
    const available = yield* inspectPathContext7(runtime);
    if (available !== undefined) {
      const manager =
        detectContext7Manager(runtime.environment) ??
        ({
          launcher: "bunx",
          family: "bun",
          executable: "bun",
        } as const);
      const retainedOwnership =
        previous?.ownership === "holycodex" &&
        typeof previous.identity === "string" &&
        (yield* sameInstallerFileEffect(runtime, previous.executable, available.executable));
      return {
        manager: manager.family,
        launcher: manager.launcher,
        version: available.version,
        executable: available.executable,
        ownership: retainedOwnership ? "holycodex" : "user",
        ...(retainedOwnership ? { identity: previous.identity } : {}),
      };
    }
    if (isBunRuntime(runtime)) {
      return yield* ensureBunGlobalContext7(runtime, mutate, previous);
    }
    // Injected runtimes from legacy launchers can use their own global package manager.
    return yield* ensureContext7ViaLauncher(runtime, mutate, previous);
  });
}

/** Inspect the available Context7 executable without registry access or managed changes. */
export function inspectContext7ReadOnly(
  runtime: InstallerRuntime,
  previous?: Context7ToolState,
): Promise<Context7ToolState> {
  return Effect.runPromise(inspectContext7ReadOnlyEffect(runtime, previous));
}

function inspectContext7ReadOnlyEffect(
  runtime: InstallerRuntime,
  previous?: Context7ToolState,
): Effect.Effect<Context7ToolState, unknown> {
  return Effect.gen(function* () {
    const available = yield* inspectPathContext7(runtime);
    if (available !== undefined) {
      const manager =
        detectContext7Manager(runtime.environment) ??
        ({ launcher: "bunx", family: "bun", executable: "bun" } as const);
      const retainedOwnership =
        previous?.ownership === "holycodex" &&
        typeof previous.identity === "string" &&
        (yield* sameInstallerFileEffect(runtime, previous.executable, available.executable));
      return {
        manager: manager.family,
        launcher: manager.launcher,
        version: available.version,
        executable: available.executable,
        ownership: retainedOwnership ? "holycodex" : "user",
        ...(retainedOwnership ? { identity: previous.identity } : {}),
      };
    }

    const manager = isBunRuntime(runtime)
      ? ({ launcher: "bunx", family: "bun", executable: "bun" } as const)
      : detectContext7Manager(runtime.environment);
    if (manager === undefined) {
      throw new ToolingError(
        "context7_manager_unknown",
        "No usable PATH Context7 executable or supported package manager is available.",
      );
    }
    const inspected =
      manager.family === "bun" && isBunRuntime(runtime)
        ? yield* inspectBunGlobalContext7(runtime)
        : yield* inspectContext7(runtime, manager);
    if (inspected === undefined) {
      throw new ToolingError(
        "context7_unavailable",
        "No usable managed Context7 executable is available.",
      );
    }
    return {
      manager: manager.family,
      launcher: manager.launcher,
      version: inspected.version,
      executable: inspected.executable,
      ownership: context7Ownership(previous, manager, inspected),
      identity: inspected.identity,
    } as Context7ToolState;
  });
}

function inspectPathContext7(
  runtime: InstallerRuntime,
): Effect.Effect<Pick<Context7Inspection, "version" | "executable"> | undefined, unknown> {
  return Effect.gen(function* () {
    const executable = yield* resolvePathExecutableEffect(
      runtime.environment,
      runtime.platform,
      runtime.files ?? nodeFiles,
    );
    if (executable === undefined) return undefined;
    const result = yield* run(runtime, executable, ["--version"]);
    const version = result.exitCode === 0 ? parseVersion(result.stdout) : undefined;
    return version === undefined ? undefined : { version, executable };
  });
}

/** Verify that the exact package-manager global installation can be inspected before mutation. */
export function preflightContext7(runtime: InstallerRuntime): Promise<void> {
  return Effect.runPromise(preflightContext7Effect(runtime));
}

function preflightContext7Effect(runtime: InstallerRuntime): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    // An executable already available to the process is sufficient. Do not require a
    // package-manager identity or registry access to preserve a working PATH tool.
    if ((yield* inspectPathContext7(runtime)) !== undefined) return;
    if (isBunRuntime(runtime)) {
      yield* preflightBunGlobalContext7(runtime);
      return;
    }
    const manager = detectContext7Manager(runtime.environment);
    if (manager === undefined) {
      throw new ToolingError(
        "context7_manager_unknown",
        "HolyCodex must be launched with bunx, npx, or pnpm dlx so Context7 can use the same package manager.",
      );
    }
    const result = yield* run(
      runtime,
      manager.executable,
      manager.family === "npm"
        ? ["prefix", "--global"]
        : manager.family === "pnpm"
          ? ["bin", "--global"]
          : ["pm", "bin", "-g"],
    );
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      throw new ToolingError(
        "context7_unavailable",
        `The ${manager.family} global installation could not be inspected before managed changes.`,
        { stderr: result.stderr.slice(0, 512) },
      );
    }
  });
}

function preflightBunGlobalContext7(runtime: InstallerRuntime): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const files = runtime.files ?? nodeFiles;
    const binResult = yield* run(runtime, runtime.processPath, ["pm", "bin", "-g"]);
    if (binResult.exitCode !== 0 || binResult.stdout.trim().length === 0) {
      // Bun creates its global project on the first `bun add -g`. Until then the
      // location query reports the missing project even though the exact global
      // installation remains the managed mutation's responsibility.
      if (isMissingBunGlobalProject(binResult.stderr)) return;
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed global installation could not be located before managed changes.",
        { stderr: binResult.stderr.slice(0, 512) },
      );
    }

    const pathApi = pathFor(runtime.platform);
    const binRoot = binResult.stdout.trim();
    const projectRoot = pathApi.join(pathApi.dirname(binRoot), "install", "global");
    const packageRoot = pathApi.join(projectRoot, "node_modules", "ctx7");
    const packageJsonPath = pathApi.join(packageRoot, "package.json");
    const shim = pathApi.join(binRoot, runtime.platform === "win32" ? "ctx7.exe" : "ctx7");

    const globalPaths = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => files.access(binRoot), catch: (error) => error });
        yield* Effect.tryPromise({ try: () => files.access(projectRoot), catch: (error) => error });
      }),
    );
    if (globalPaths._tag === "Failure") {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed global location or project is unavailable before managed changes.",
        { reason: safeToolingErrorMessage(globalPaths.failure) },
      );
    }

    const packageAccess = yield* Effect.result(
      Effect.tryPromise({ try: () => files.access(packageRoot), catch: (error) => error }),
    );
    if (packageAccess._tag === "Failure") {
      // An absent package is the one expected pre-mutation state: Bun will create
      // it with the transactional `bun add -g ctx7@latest` below.
      if (isMissingFile(packageAccess.failure)) return;
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 package could not be inspected before managed changes.",
        { reason: safeToolingErrorMessage(packageAccess.failure) },
      );
    }
    const packageJsonText = yield* Effect.result(
      Effect.tryPromise({ try: () => files.readText(packageJsonPath), catch: (error) => error }),
    );
    if (packageJsonText._tag === "Failure") {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 package metadata could not be inspected before managed changes.",
        { reason: safeToolingErrorMessage(packageJsonText.failure) },
      );
    }

    const packageJson = yield* Effect.result(decodeContext7Package(packageJsonText.success));
    if (packageJson._tag === "Failure") {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 package metadata is invalid before managed changes.",
        { reason: safeToolingErrorMessage(packageJson.failure) },
      );
    }
    if (
      packageJson.success.version === undefined ||
      parseVersion(packageJson.success.version) !== packageJson.success.version
    ) {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 package has no exact semver version before managed changes.",
      );
    }
    const bin = context7PackageBin(packageJson.success);
    if (bin === undefined) {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 package does not declare its executable before managed changes.",
      );
    }
    const packageExecutable = pathApi.resolve(packageRoot, bin);
    const packagePaths = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => files.access(packageExecutable),
          catch: (error) => error,
        });
        const canonicalPackageRoot = yield* Effect.tryPromise({
          try: () => files.realpath(packageRoot),
          catch: (error) => error,
        });
        const canonicalExecutable = yield* Effect.tryPromise({
          try: () => files.realpath(packageExecutable),
          catch: (error) => error,
        });
        return { canonicalPackageRoot, canonicalExecutable };
      }),
    );
    if (packagePaths._tag === "Failure") {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 executable is unavailable before managed changes.",
        { reason: safeToolingErrorMessage(packagePaths.failure) },
      );
    }
    const { canonicalPackageRoot, canonicalExecutable } = packagePaths.success;
    if (
      !sameInstallerPath(canonicalPackageRoot, packageRoot, runtime.platform) ||
      !normalize(canonicalExecutable).startsWith(`${normalize(canonicalPackageRoot)}/`)
    ) {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 executable is outside its package before managed changes.",
      );
    }

    const shimAccess = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => files.access(shim), catch: (error) => error });
        return yield* Effect.tryPromise({
          try: () => files.realpath(shim),
          catch: (error) => error,
        });
      }),
    );
    if (shimAccess._tag === "Failure") {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 shim is unavailable before managed changes.",
        { reason: safeToolingErrorMessage(shimAccess.failure) },
      );
    }
    const version = yield* run(runtime, shim, ["--version"]);
    if (version.exitCode !== 0 || parseVersion(version.stdout) !== packageJson.success.version) {
      throw new ToolingError(
        "context7_unavailable",
        "Bun's managed ctx7 shim does not report the package version before managed changes.",
        { stderr: version.stderr.slice(0, 512) },
      );
    }
  });
}

function ensureContext7ViaLauncher(
  runtime: InstallerRuntime,
  mutate: boolean,
  previous?: Context7ToolState,
): Effect.Effect<Context7ToolState, unknown> {
  return Effect.gen(function* () {
    const manager = detectContext7Manager(runtime.environment);
    if (manager === undefined) {
      throw new ToolingError(
        "context7_manager_unknown",
        "HolyCodex must be launched with bunx, npx, or pnpm dlx so Context7 can use the same package manager.",
      );
    }
    const before = yield* inspectContext7(runtime, manager);
    const latest = yield* latestContext7Version(runtime, manager);
    if (latest === undefined) {
      throw new ToolingError(
        "context7_verification_failed",
        `${manager.family} could not resolve the latest ctx7 version.`,
      );
    }
    const ownership = context7Ownership(previous, manager, before);
    if (mutate && before?.version !== latest && ownership === "holycodex") {
      const command =
        manager.family === "bun"
          ? {
              executable: "bun",
              args: bunGlobalCommandArguments(runtime, "add", CONTEXT7_SPEC),
            }
          : context7InstallCommand(manager.family);
      const result = yield* run(runtime, command.executable, command.args);
      if (result.exitCode !== 0) {
        throw new ToolingError(
          "context7_install_failed",
          `${manager.family} could not install ${CONTEXT7_SPEC}.`,
          { stderr: result.stderr.slice(0, 512) },
        );
      }
    } else if (!mutate && before === undefined) {
      throw new ToolingError(
        "context7_unavailable",
        `${CONTEXT7_SPEC} is not owned by the ${manager.family} global installation.`,
      );
    }
    const after = yield* inspectContext7(runtime, manager);
    if (after === undefined) {
      throw new ToolingError(
        "context7_verification_failed",
        `${CONTEXT7_SPEC} could not be verified in the ${manager.family} global installation.`,
      );
    }
    if (after.version !== latest) {
      throw new ToolingError(
        "context7_outdated",
        `The ${manager.family} global ctx7 is ${after.version}; ${latest} is required.`,
        { installed: after.version, latest },
      );
    }
    const state: Context7StateWithIdentity = {
      manager: manager.family,
      launcher: manager.launcher,
      version: after.version,
      executable: after.executable,
      ownership,
      identity: after.identity,
    };
    // Context7ToolState gains the optional identity field at the record boundary while 0.16.x
    // records remain readable without it.
    return state as Context7ToolState;
  });
}

/** Reconcile the exact Bun-global ctx7 package and verify its own executable. */
function ensureBunGlobalContext7(
  runtime: InstallerRuntime,
  mutate: boolean,
  previous?: Context7ToolState,
): Effect.Effect<Context7ToolState, unknown> {
  return Effect.gen(function* () {
    const manager: Context7Manager = { launcher: "bunx", family: "bun", executable: "bun" };
    const before = yield* inspectBunGlobalContext7(runtime);
    const latest = yield* latestContext7Version(runtime, manager);
    if (latest === undefined) {
      throw new ToolingError(
        "context7_verification_failed",
        "Bun could not resolve the latest ctx7 version.",
      );
    }
    const ownership = context7Ownership(previous, manager, before);
    if (mutate && before?.version !== latest && ownership === "holycodex") {
      const result = yield* run(
        runtime,
        runtime.processPath,
        bunGlobalCommandArguments(runtime, "add", CONTEXT7_SPEC),
      );
      if (result.exitCode !== 0) {
        throw new ToolingError(
          "context7_install_failed",
          `Bun could not install ${CONTEXT7_SPEC} in its global installation.`,
          { stderr: result.stderr.slice(0, 512) },
        );
      }
    } else if (before === undefined) {
      throw new ToolingError(
        "context7_unavailable",
        `${CONTEXT7_SPEC} is not present in Bun's exact global installation.`,
      );
    }
    const after = yield* inspectBunGlobalContext7(runtime);
    if (after === undefined) {
      throw new ToolingError(
        "context7_verification_failed",
        `${CONTEXT7_SPEC} could not be verified in Bun's exact global installation.`,
      );
    }
    if (after.version !== latest) {
      throw new ToolingError(
        "context7_outdated",
        `Bun's global ctx7 is ${after.version}; ${latest} is required.`,
        { installed: after.version, latest },
      );
    }
    const state: Context7StateWithIdentity = {
      manager: "bun",
      launcher: "bunx",
      version: after.version,
      executable: after.executable,
      ownership,
      identity: after.identity,
    };
    return state as Context7ToolState;
  });
}

function inspectBunGlobalContext7(
  runtime: InstallerRuntime,
): Effect.Effect<Context7Inspection | undefined, unknown> {
  return Effect.gen(function* () {
    const files = runtime.files ?? nodeFiles;
    const binResult = yield* run(runtime, runtime.processPath, ["pm", "bin", "-g"]);
    if (binResult.exitCode !== 0) return undefined;
    const binRoot = binResult.stdout.trim();
    if (binRoot.length === 0) return undefined;
    const pathApi = pathFor(runtime.platform);
    const packageRoot = pathApi.join(
      pathApi.dirname(binRoot),
      "install",
      "global",
      "node_modules",
      "ctx7",
    );
    const packageJsonResult = yield* Effect.result(
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => files.readText(pathApi.join(packageRoot, "package.json")),
          catch: (error) => error,
        });
        return yield* decodeContext7Package(text);
      }),
    );
    if (packageJsonResult._tag === "Failure") return undefined;
    const packageJson = packageJsonResult.success;
    if (
      typeof packageJson.version !== "string" ||
      parseVersion(packageJson.version) !== packageJson.version
    )
      return undefined;
    const bin = context7PackageBin(packageJson);
    if (bin === undefined) return undefined;
    const packageExecutable = pathApi.resolve(packageRoot, bin);
    const shim = pathApi.join(binRoot, runtime.platform === "win32" ? "ctx7.exe" : "ctx7");
    const pathsResult = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => files.access(packageRoot), catch: (error) => error });
        yield* Effect.tryPromise({
          try: () => files.access(packageExecutable),
          catch: (error) => error,
        });
        yield* Effect.tryPromise({ try: () => files.access(shim), catch: (error) => error });
        const canonicalPackageRoot = yield* Effect.tryPromise({
          try: () => files.realpath(packageRoot),
          catch: (error) => error,
        });
        const canonicalExecutable = yield* Effect.tryPromise({
          try: () => files.realpath(packageExecutable),
          catch: (error) => error,
        });
        const canonicalShim = yield* Effect.tryPromise({
          try: () => files.realpath(shim),
          catch: (error) => error,
        });
        return { canonicalPackageRoot, canonicalExecutable, canonicalShim };
      }),
    );
    if (pathsResult._tag === "Failure") return undefined;
    const { canonicalPackageRoot, canonicalExecutable, canonicalShim } = pathsResult.success;
    if (
      !sameInstallerPath(canonicalPackageRoot, packageRoot, runtime.platform) ||
      !normalize(canonicalExecutable).startsWith(`${normalize(canonicalPackageRoot)}/`)
    )
      return undefined;
    const version = yield* run(runtime, shim, ["--version"]);
    if (version.exitCode !== 0 || parseVersion(version.stdout) !== packageJson.version)
      return undefined;
    return {
      version: packageJson.version,
      executable: shim,
      identity: yield* context7InstallationIdentity(
        { launcher: "bunx", family: "bun", executable: "bun" },
        canonicalPackageRoot,
        canonicalExecutable,
        canonicalShim,
        packageJson,
      ),
    };
  });
}

function isBunRuntime(runtime: InstallerRuntime): boolean {
  const basename = pathFor(runtime.platform).basename(runtime.processPath).toLowerCase();
  return basename === "bun" || basename === "bun.exe";
}

function context7Ownership(
  previous: Context7ToolState | undefined,
  manager: Context7Manager,
  before: Context7Inspection | undefined,
): Context7ToolState["ownership"] {
  if (before === undefined) return "holycodex";
  if (previous?.ownership !== "holycodex") return "user";
  if (previous.manager !== manager.family) return "user";
  const previousIdentity = (previous as Context7StateWithIdentity).identity;
  if (!isContext7Identity(previousIdentity) || previousIdentity !== before.identity) return "user";
  return "holycodex";
}

/** Remove Context7 only when this installation recorded ownership and the launcher family agrees. */
export function removeOwnedContext7(
  runtime: InstallerRuntime,
  previous: Context7ToolState | undefined,
): Promise<boolean> {
  return Effect.runPromise(removeOwnedContext7Effect(runtime, previous));
}

function removeOwnedContext7Effect(
  runtime: InstallerRuntime,
  previous: Context7ToolState | undefined,
): Effect.Effect<boolean, unknown> {
  return isBunRuntime(runtime)
    ? removeOwnedBunGlobalContext7(runtime, previous)
    : removeOwnedContext7ViaLauncher(runtime, previous);
}

function removeOwnedBunGlobalContext7(
  runtime: InstallerRuntime,
  previous: Context7ToolState | undefined,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    if (previous?.ownership !== "holycodex" || previous.manager !== "bun") return false;
    const currentResult = yield* Effect.result(inspectBunGlobalContext7(runtime));
    if (currentResult._tag === "Failure") return false;
    const current = currentResult.success;
    if (
      current === undefined ||
      current.version !== previous.version ||
      !(yield* sameInstallerFileEffect(runtime, current.executable, previous.executable)) ||
      !isContext7Identity((previous as Context7StateWithIdentity).identity) ||
      current.identity !== (previous as Context7StateWithIdentity).identity
    ) {
      return false;
    }
    const result = yield* run(
      runtime,
      runtime.processPath,
      bunGlobalCommandArguments(runtime, "remove", "ctx7"),
    );
    if (result.exitCode !== 0) {
      throw new ToolingError("context7_remove_failed", "Bun could not remove ctx7.", {
        stderr: result.stderr.slice(0, 512),
      });
    }
    if ((yield* inspectBunGlobalContext7(runtime)) !== undefined) {
      throw new ToolingError(
        "context7_remove_failed",
        "Bun reported success, but the recorded ctx7 installation is still present.",
      );
    }
    return true;
  });
}

function removeOwnedContext7ViaLauncher(
  runtime: InstallerRuntime,
  previous: Context7ToolState | undefined,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    if (previous?.ownership !== "holycodex") return false;
    const manager = detectContext7Manager(runtime.environment);
    if (manager === undefined || manager.family !== previous.manager) return false;
    const currentResult = yield* Effect.result(inspectContext7(runtime, manager));
    if (currentResult._tag === "Failure") {
      if (
        currentResult.failure instanceof ToolingError &&
        currentResult.failure.code === "context7_shadowed"
      )
        return false;
      throw currentResult.failure;
    }
    const current = currentResult.success;
    if (
      current === undefined ||
      current.version !== previous.version ||
      !(yield* sameInstallerFileEffect(runtime, current.executable, previous.executable)) ||
      !isContext7Identity((previous as Context7StateWithIdentity).identity) ||
      current.identity !== (previous as Context7StateWithIdentity).identity
    ) {
      return false;
    }
    const command =
      manager.family === "bun"
        ? {
            executable: "bun",
            args: bunGlobalCommandArguments(runtime, "remove", "ctx7"),
          }
        : context7RemoveCommand(manager.family);
    const result = yield* run(runtime, command.executable, command.args);
    if (result.exitCode !== 0) {
      throw new ToolingError("context7_remove_failed", `${manager.family} could not remove ctx7.`, {
        stderr: result.stderr.slice(0, 512),
      });
    }
    const verification = yield* Effect.result(
      Effect.gen(function* () {
        if ((yield* inspectContext7(runtime, manager)) !== undefined) {
          return yield* Effect.fail(
            new ToolingError(
              "context7_remove_failed",
              `${manager.family} reported success, but the recorded ctx7 installation is still present.`,
            ),
          );
        }
      }),
    );
    if (verification._tag === "Failure") {
      if (
        verification.failure instanceof ToolingError &&
        verification.failure.code === "context7_remove_failed"
      )
        throw verification.failure;
      throw new ToolingError(
        "context7_remove_failed",
        `${manager.family} removed ctx7, but its final state could not be verified.`,
      );
    }
    return true;
  });
}

/** Return the package-manager command used to install the required Context7 version. */
export function context7InstallCommand(family: Context7Manager["family"]): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  switch (family) {
    case "bun":
      return { executable: "bun", args: ["add", "--global", CONTEXT7_SPEC] };
    case "npm":
      return { executable: "npm", args: ["install", "--global", CONTEXT7_SPEC] };
    case "pnpm":
      return { executable: "pnpm", args: ["add", "--global", CONTEXT7_SPEC] };
  }
}

function bunGlobalCommandArguments(
  runtime: InstallerRuntime,
  operation: "add" | "remove",
  packageName: string,
): readonly string[] {
  const pathApi = pathFor(runtime.platform);
  const executableDirectory = pathApi.dirname(runtime.processPath);
  const cwd = pathApi.isAbsolute(executableDirectory)
    ? executableDirectory
    : runtime.platform === "win32"
      ? "C:\\"
      : "/";
  return [operation, "--global", `--cwd=${cwd}`, packageName];
}

function context7RemoveCommand(family: Context7Manager["family"]): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  switch (family) {
    case "bun":
      return { executable: "bun", args: ["remove", "--global", "ctx7"] };
    case "npm":
      return { executable: "npm", args: ["uninstall", "--global", "ctx7"] };
    case "pnpm":
      return { executable: "pnpm", args: ["remove", "--global", "ctx7"] };
  }
}

function inspectContext7(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Effect.Effect<Context7Inspection | undefined, unknown> {
  return Effect.gen(function* () {
    const files = runtime.files ?? nodeFiles;
    const binResult = yield* run(
      runtime,
      manager.executable,
      manager.family === "npm"
        ? ["prefix", "--global"]
        : manager.family === "pnpm"
          ? ["bin", "--global"]
          : ["pm", "bin", "-g"],
    );
    if (binResult.exitCode !== 0) return undefined;
    const binRoot = binResult.stdout.trim();
    if (binRoot.length === 0) return undefined;
    const packageRoot =
      manager.family === "npm"
        ? pathFor(runtime.platform).join(binRoot, "node_modules", "ctx7")
        : manager.family === "pnpm"
          ? yield* pnpmPackageRoot(runtime, manager)
          : pathFor(runtime.platform).join(
              pathFor(runtime.platform).dirname(binRoot),
              "install",
              "global",
              "node_modules",
              "ctx7",
            );
    if (packageRoot === undefined) return undefined;
    const packageJsonResult = yield* Effect.result(
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => files.readText(pathFor(runtime.platform).join(packageRoot, "package.json")),
          catch: (error) => error,
        });
        return yield* decodeContext7Package(text);
      }),
    );
    if (packageJsonResult._tag === "Failure") return undefined;
    const packageJson = packageJsonResult.success;
    if (typeof packageJson.version !== "string") return undefined;
    const bin =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : isRecord(packageJson.bin) && typeof packageJson.bin["ctx7"] === "string"
          ? packageJson.bin["ctx7"]
          : undefined;
    if (bin === undefined) return undefined;
    const executable = pathFor(runtime.platform).resolve(packageRoot, bin);
    const pathsResult = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => files.access(executable), catch: (error) => error });
        const canonicalPackageRoot = yield* Effect.tryPromise({
          try: () => files.realpath(packageRoot),
          catch: (error) => error,
        });
        const canonicalExecutable = yield* Effect.tryPromise({
          try: () => files.realpath(executable),
          catch: (error) => error,
        });
        return { canonicalPackageRoot, canonicalExecutable };
      }),
    );
    if (pathsResult._tag === "Failure") return undefined;
    const { canonicalPackageRoot, canonicalExecutable } = pathsResult.success;
    if (!normalize(canonicalExecutable).startsWith(`${normalize(canonicalPackageRoot)}/`))
      return undefined;
    const shim = context7Shim(binRoot, manager.family, runtime.platform);
    const canonicalShimResult = yield* Effect.result(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => files.access(shim), catch: (error) => error });
        return yield* Effect.tryPromise({
          try: () => files.realpath(shim),
          catch: (error) => error,
        });
      }),
    );
    if (canonicalShimResult._tag === "Failure") return undefined;
    const canonicalShim = canonicalShimResult.success;
    const shadow = yield* resolvePathExecutableEffect(runtime.environment, runtime.platform, files);
    if (
      shadow !== undefined &&
      !sameInstallerPath(yield* canonicalPathEffect(files, shadow), canonicalShim, runtime.platform)
    ) {
      return yield* Effect.fail(
        new ToolingError(
          "context7_shadowed",
          "A different ctx7 executable shadows the managed global installation.",
          {
            resolved: shadow,
            expected: shim,
          },
        ),
      );
    }
    const version = yield* run(runtime, shim, ["--version"]);
    if (version.exitCode !== 0 || parseVersion(version.stdout) !== packageJson.version)
      return undefined;
    return {
      version: packageJson.version,
      executable: shim,
      identity: yield* context7InstallationIdentity(
        manager,
        canonicalPackageRoot,
        canonicalExecutable,
        canonicalShim,
        packageJson,
      ),
    };
  });
}

function context7InstallationIdentity(
  manager: Context7Manager,
  packageRoot: string,
  packageExecutable: string,
  shim: string,
  packageJson: Readonly<{ readonly version?: unknown; readonly bin?: unknown }>,
): Effect.Effect<string, unknown> {
  return promiseEffect(() =>
    domainSeparatedSha256("context7-installation", [
      canonicalJsonUtf8({
        manager: manager.family,
        package_root: normalize(packageRoot),
        package_executable: normalize(packageExecutable),
        shim: normalize(shim),
        package: packageJson,
      }),
    ]),
  );
}

function isContext7Identity(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{64}$/u.test(value);
}

function resolvePathExecutableEffect(
  environment: Readonly<Record<string, string | undefined>>,
  platform: InstallerPlatform,
  files: InstallerFileSystem,
): Effect.Effect<string | undefined, never> {
  const path = environment["PATH"];
  if (path === undefined) return Effect.succeed(undefined);
  const names =
    platform === "win32"
      ? (environment["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter((extension) => extension.length > 0)
          .map((extension) => `ctx7${extension.toLowerCase()}`)
      : ["ctx7"];
  const candidates = path
    .split(platform === "win32" ? ";" : ":")
    .filter((directory) => directory.length > 0)
    .flatMap((directory) => names.map((name) => pathFor(platform).join(directory, name)));
  return Effect.gen(function* () {
    for (const candidate of candidates) {
      const accessible = yield* Effect.result(
        Effect.tryPromise({ try: () => files.access(candidate), catch: (error) => error }),
      );
      if (accessible._tag === "Success") return candidate;
    }
    return undefined;
  });
}

function context7Shim(
  binRoot: string,
  family: Context7Manager["family"],
  platform: InstallerPlatform,
): string {
  if (platform === "win32")
    return pathFor(platform).join(binRoot, family === "bun" ? "ctx7.exe" : "ctx7.cmd");
  return family === "npm"
    ? pathFor(platform).join(binRoot, "bin", "ctx7")
    : pathFor(platform).join(binRoot, "ctx7");
}

function canonicalPathEffect(
  files: InstallerFileSystem,
  path: string,
): Effect.Effect<string, never> {
  return Effect.tryPromise({ try: () => files.realpath(path), catch: () => path }).pipe(
    Effect.catch((fallback) => Effect.succeed(fallback)),
  );
}

function parseVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u)?.[1];
}

function decodeContext7Package(text: string) {
  return Effect.try({
    try: () => {
      const result = Schema.decodeUnknownResult(Context7PackageSchema)(JSON.parse(text) as unknown);
      if (Result.isSuccess(result)) return result.success;
      throw result.failure;
    },
    catch: (error) => error,
  });
}

function context7PackageBin(packageJson: typeof Context7PackageSchema.Type): string | undefined {
  return typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.["ctx7"];
}

function safeToolingErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 512);
  if (typeof error === "string") return error.slice(0, 512);
  return "unknown error";
}

function isMissingFile(error: unknown): boolean {
  return (
    (isRecord(error) && error["code"] === "ENOENT") ||
    /\b(?:e?noent|not found|does not exist|missing)\b/iu.test(safeToolingErrorMessage(error))
  );
}

function isMissingBunGlobalProject(stderr: string): boolean {
  return /(?:no package\.json(?: was)? found|couldn['’]?t find (?:a )?package\.json|could not find (?:a )?package\.json|package\.json (?:is )?missing)/iu.test(
    stderr,
  );
}

function pnpmPackageRoot(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Effect.Effect<string | undefined, unknown> {
  return Effect.map(run(runtime, manager.executable, ["root", "--global"]), (result) => {
    const root = result.stdout.trim();
    return result.exitCode === 0 && root.length > 0
      ? pathFor(runtime.platform).join(root, "ctx7")
      : undefined;
  });
}

function latestContext7Version(
  runtime: InstallerRuntime,
  manager: Context7Manager,
): Effect.Effect<string | undefined, unknown> {
  return Effect.map(
    run(
      runtime,
      manager.family === "bun" && isBunRuntime(runtime) ? runtime.processPath : manager.executable,
      manager.family === "bun" ? ["pm", "view", "ctx7", "version"] : ["view", "ctx7", "version"],
    ),
    (result) => (result.exitCode !== 0 ? undefined : parseVersion(result.stdout)),
  );
}

function isExecutable(path: string, name: string): boolean {
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.js`, `${name}.cjs`].some((candidate) =>
    path.endsWith(`/${candidate}`),
  );
}

/** Compare two resolved installer paths with the platform's path case rules. */
export function sameInstallerPath(
  left: string,
  right: string,
  platform: InstallerPlatform,
): boolean {
  const pathApi = pathFor(platform);
  const resolvedLeft = pathApi.resolve(left);
  const resolvedRight = pathApi.resolve(right);
  return platform === "win32"
    ? normalize(resolvedLeft) === normalize(resolvedRight)
    : resolvedLeft === resolvedRight;
}

/** Compare executable paths by filesystem identity when lexical paths differ. */
export function sameInstallerFile(
  runtime: InstallerRuntime,
  left: string,
  right: string,
): Promise<boolean> {
  return Effect.runPromise(sameInstallerFileEffect(runtime, left, right));
}

function sameInstallerFileEffect(
  runtime: InstallerRuntime,
  left: string,
  right: string,
): Effect.Effect<boolean, never> {
  if (sameInstallerPath(left, right, runtime.platform)) return Effect.succeed(true);
  const files = runtime.files ?? nodeFiles;
  return Effect.all([
    Effect.tryPromise({ try: () => files.realpath(left), catch: (error) => error }),
    Effect.tryPromise({ try: () => files.realpath(right), catch: (error) => error }),
  ]).pipe(
    Effect.map(([canonicalLeft, canonicalRight]) =>
      sameInstallerPath(canonicalLeft, canonicalRight, runtime.platform),
    ),
    Effect.catch(() => Effect.succeed(false)),
  );
}

function pathFor(platform: InstallerPlatform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase().replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structured failure raised while discovering or managing external tooling. */
export class ToolingError extends Error {
  constructor(
    readonly code:
      | "context7_manager_unknown"
      | "context7_unavailable"
      | "context7_install_failed"
      | "context7_remove_failed"
      | "context7_verification_failed"
      | "context7_outdated"
      | "context7_shadowed",
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ToolingError";
  }
}
