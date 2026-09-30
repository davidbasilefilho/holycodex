// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";

import {
  ToolingError,
  context7InstallCommand,
  detectContext7Manager,
  ensureContext7,
  inspectContext7ReadOnly,
  preflightContext7,
  removeOwnedContext7,
  sameInstallerFile,
  sameInstallerPath,
} from "./tooling.ts";
import type {
  Context7Manager,
  Context7ToolState,
  InstallerFileSystem,
  InstallerProcessResult,
  InstallerRuntime,
} from "./types.ts";

type Context7StateWithIdentity = Context7ToolState & { readonly identity?: string | undefined };

const success = (stdout = ""): InstallerProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const failure = (stderr = "failed"): InstallerProcessResult => ({
  exitCode: 1,
  stdout: "",
  stderr,
});
const normalized = (path: string): string => win32.resolve(path).toLowerCase();

describe("installer tooling", () => {
  test("compares executable paths with platform-specific case rules", () => {
    expect(
      sameInstallerPath(
        "C:\\Program Files\\Bun\\ctx7.exe",
        "c:/program files/bun/ctx7.exe",
        "win32",
      ),
    ).toBe(true);
    expect(sameInstallerPath("/usr/local/bin/ctx7", "/usr/local/bin/ctx7", "linux")).toBe(true);
    expect(sameInstallerPath("/usr/local/bin/CTX7", "/usr/local/bin/ctx7", "linux")).toBe(false);
  });

  test("compares Windows short and long executable paths by canonical filesystem identity", async () => {
    const fixture = context7Runtime({ family: "bun" });
    const longPath = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\holycodex\\ctx7.exe";
    const shortPath = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\holycodex\\ctx7.exe";
    const baseFiles = fixture.runtime.files;
    if (baseFiles === undefined)
      throw new Error("The Context7 fixture has no filesystem boundary.");
    const files: InstallerFileSystem = {
      ...baseFiles,
      realpath: async (path) => {
        if (path === longPath || path === shortPath) return longPath;
        throw new Error("ENOENT");
      },
    };
    const runtime = { ...fixture.runtime, files };

    await expect(sameInstallerFile(runtime, longPath, shortPath)).resolves.toBe(true);
    await expect(
      sameInstallerFile(runtime, longPath, "C:\\Users\\runneradmin\\other\\ctx7.exe"),
    ).resolves.toBe(false);
    await expect(
      sameInstallerFile(
        { ...runtime, files: { ...files, realpath: async () => Promise.reject(new Error()) } },
        longPath,
        shortPath,
      ),
    ).resolves.toBe(false);
  });

  test("accepts a working PATH ctx7 when registry resolution fails", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "1.0.0",
      latestFails: true,
      shadowed: true,
      shadowVersion: "3.0.0",
    });
    await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
      version: "3.0.0",
      executable: "C:\\Shadow\\ctx7.cmd",
      ownership: "user",
    });
    expect(fixture.installs()).toBe(0);
    expect(fixture.calls.some((call) => call.includes("pm view ctx7 version"))).toBe(false);
  });

  test("preflights a usable PATH ctx7 without package-manager or registry access", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "1.0.0",
      latestFails: true,
      shadowed: true,
      shadowVersion: "3.0.0",
    });
    await expect(
      preflightContext7({ ...fixture.runtime, environment: { PATH: "C:\\Shadow" } }),
    ).resolves.toBeUndefined();
    expect(fixture.calls).toEqual(["C:\\Shadow\\ctx7.cmd --version"]);
  });
  test("accepts only bunx, npx, and pnpm dlx launcher metadata", () => {
    expect(detectContext7Manager({ npm_execpath: "C:/bun/bin/bunx.exe" })).toEqual({
      launcher: "bunx",
      family: "bun",
      executable: "bun",
    });
    expect(
      detectContext7Manager({ npm_execpath: "/opt/pnpm/pnpm.cjs", npm_command: "dlx" }),
    ).toEqual({ launcher: "pnpm dlx", family: "pnpm", executable: "pnpm" });
    expect(
      detectContext7Manager({ npm_execpath: "/opt/npm/bin/npx-cli.js", npm_command: "exec" }),
    ).toEqual({ launcher: "npx", family: "npm", executable: "npm" });
    expect(
      detectContext7Manager({ npm_execpath: "/opt/npm/bin/npm-cli.js", npm_command: "exec" }),
    ).toMatchObject({ launcher: "npx", family: "npm" });
    expect(
      detectContext7Manager({ npm_execpath: "C:/bun/bin/bun.exe", npm_command: "exec" }),
    ).toMatchObject({ launcher: "bunx", family: "bun" });

    for (const environment of [
      { npm_execpath: "C:/bun/bin/bun.exe", npm_command: "run" },
      { npm_execpath: "/opt/npm/bin/npm-cli.js", npm_command: "run-script" },
      { npm_execpath: "/opt/pnpm/pnpm.cjs", npm_command: "run" },
      { npm_execpath: "/opt/yarn/yarn.js", npm_command: "dlx" },
      { npm_execpath: "/opt/corepack/corepack.js", npm_command: "exec" },
      { npm_config_user_agent: "bun/1.4.2", npm_command: "run" },
      { npm_config_registry: "https://registry.npmjs.org" },
      {},
    ]) {
      expect(detectContext7Manager(environment)).toBeUndefined();
    }
  });

  test("maps ctx7@latest to every supported manager family", () => {
    expect(context7InstallCommand("bun")).toEqual({
      executable: "bun",
      args: ["add", "--global", "ctx7@latest"],
    });
    expect(context7InstallCommand("npm")).toEqual({
      executable: "npm",
      args: ["install", "--global", "ctx7@latest"],
    });
    expect(context7InstallCommand("pnpm")).toEqual({
      executable: "pnpm",
      args: ["add", "--global", "ctx7@latest"],
    });
  });

  test("uses Bun's Windows executable shim and documented global bin command", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
    });
    await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
      executable: fixture.shim,
    });
    expect(fixture.shim.endsWith("\\ctx7.exe")).toBe(true);
    expect(fixture.calls.filter((call) => call === "bun pm bin -g")).toHaveLength(2);
    expect(fixture.calls).toContain("bun pm view ctx7 version");
  });

  test("preflights an installed Bun global package through its exact executable", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      latestFails: true,
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    expect(fixture.installs()).toBe(0);
    expect(fixture.calls).toEqual(["bun pm bin -g", `${fixture.shim} --version`]);
    expect(fixture.calls.some((call) => call.includes("pm view ctx7 version"))).toBe(false);
  });

  test("leaves a missing Bun ctx7 package for transactional installation", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      latest: "2.0.0",
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    expect(fixture.installs()).toBe(0);

    await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
      manager: "bun",
      version: "2.0.0",
      executable: fixture.shim,
    });
    expect(fixture.installs()).toBe(1);
    expect(fixture.calls).toContain("bun add --global --cwd=C:\\ ctx7@latest");
    expect(fixture.calls).toContain("bun pm view ctx7 version");
  });

  test("runs Bun global installs outside the invoking project directory", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "C:\\Program Files\\Bun\\bun.exe",
      latest: "2.0.0",
    });
    await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
      version: "2.0.0",
      executable: fixture.shim,
    });
    expect(fixture.calls).toContain(
      "C:\\Program Files\\Bun\\bun.exe add --global --cwd=C:\\Program Files\\Bun ctx7@latest",
    );
  });

  test("defers a Bun package installation failure until the transaction", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      latest: "2.0.0",
      installFails: true,
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    await expect(ensureContext7(fixture.runtime, true)).rejects.toMatchObject({
      code: "context7_install_failed",
      details: { stderr: "install failed" },
    });
    expect(fixture.installs()).toBe(1);
    expect(fixture.calls).toContain("bun add --global --cwd=C:\\ ctx7@latest");
    expect(fixture.calls).toContain("bun pm view ctx7 version");
  });

  test("falls back to a valid Bun global ctx7 when the PATH executable fails", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      shadowed: true,
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    await expect(ensureContext7(fixture.runtime, false)).resolves.toMatchObject({
      executable: fixture.shim,
      version: "2.0.0",
    });
    expect(fixture.installs()).toBe(0);
    expect(fixture.calls.some((call) => call.includes("Shadow"))).toBe(true);
    expect(fixture.calls).toContain("bun pm view ctx7 version");
  });

  test("keeps a foreign Bun launcher shadow failure nonmutating", async () => {
    const fixture = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      shadowed: true,
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    await expect(ensureContext7(fixture.runtime, true)).rejects.toMatchObject({
      code: "context7_shadowed",
    });
    expect(fixture.installs()).toBe(0);
    expect(fixture.calls.some((call) => call.includes("add --global --cwd="))).toBe(false);
  });

  test("reports discoverable Bun preflight failures before mutation", async () => {
    for (const option of [
      { globalBinFails: true },
      { globalBinEmpty: true },
      { projectMissing: true },
      { missingShim: true },
      { brokenShim: true },
      { shimVersion: "9.9.9" },
      { outsidePackageBin: true },
    ]) {
      const fixture = context7Runtime({
        family: "bun",
        processPath: "bun",
        installed: "2.0.0",
        latest: "2.0.0",
        ...option,
      });
      await expect(preflightContext7(fixture.runtime)).rejects.toMatchObject({
        code: "context7_unavailable",
      });
      expect(fixture.installs()).toBe(0);
      expect(fixture.calls.some((call) => call.includes("add --global --cwd="))).toBe(false);
      expect(fixture.calls.some((call) => call.includes("pm view ctx7 version"))).toBe(false);
    }
  });

  test("allows Bun to create its missing global project during the transaction", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      latest: "2.0.0",
      missingProjectInitially: true,
    });
    await expect(preflightContext7(fixture.runtime)).resolves.toBeUndefined();
    expect(fixture.installs()).toBe(0);
    await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
      version: "2.0.0",
      executable: fixture.shim,
    });
    expect(fixture.installs()).toBe(1);
    expect(fixture.calls).toContain("bun add --global --cwd=C:\\ ctx7@latest");
  });

  for (const family of ["bun", "npm", "pnpm"] as const) {
    test(`${family} skips mutation only for a valid latest manager-owned shim`, async () => {
      const fixture = context7Runtime({ family, installed: "2.1.0", latest: "2.1.0" });
      await expect(ensureContext7(fixture.runtime, true)).resolves.toMatchObject({
        manager: family,
        version: "2.1.0",
        ownership: "user",
        executable: fixture.shim,
      });
      expect(fixture.installs()).toBe(0);
      expect(fixture.shimRuns()).toBe(2);
    });
  }

  test("does not update an outdated user-owned package through launcher managers", async () => {
    for (const family of ["bun", "npm", "pnpm"] as const) {
      const fixture = context7Runtime({ family, installed: "1.0.0", latest: "2.0.0" });
      await expect(ensureContext7(fixture.runtime, true)).rejects.toMatchObject({
        code: "context7_outdated",
        details: { installed: "1.0.0", latest: "2.0.0" },
      });
      expect(fixture.installs()).toBe(0);
      expect(fixture.calls.some((call) => call.includes("ctx7@latest"))).toBe(false);
    }
  });

  test("preserves an existing user-owned Bun global package during install", async () => {
    const fixture = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "1.0.0",
      latest: "2.0.0",
    });
    await expect(ensureContext7(fixture.runtime, true)).rejects.toMatchObject({
      code: "context7_outdated",
      details: { installed: "1.0.0", latest: "2.0.0" },
    });
    expect(fixture.installs()).toBe(0);
    expect(fixture.calls).toContain("bun pm view ctx7 version");
    expect(fixture.calls.some((call) => call.includes("add --global --cwd="))).toBe(false);
  });

  test("records a new install as HolyCodex-owned and preserves prior user origin on repair", async () => {
    const fresh = context7Runtime({ family: "npm", latest: "2.0.0" });
    const freshState = await ensureContext7(fresh.runtime, true);
    expect(freshState).toMatchObject({
      version: "2.0.0",
      ownership: "holycodex",
    });
    expect((freshState as Context7StateWithIdentity).identity).toMatch(/^[0-9a-f]{64}$/u);

    const repaired = context7Runtime({ family: "npm", installed: "2.0.0", latest: "2.0.0" });
    await expect(
      ensureContext7(repaired.runtime, true, context7State(freshState.executable, "user", "npm")),
    ).resolves.toMatchObject({ ownership: "user" });
  });

  test("retains ownership through a same-manager update with matching provenance", async () => {
    const original = context7Runtime({ family: "bun", processPath: "bun", latest: "1.0.0" });
    const previous = await ensureContext7(original.runtime, true);
    expect(previous.ownership).toBe("holycodex");

    const updated = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "1.0.0",
      latest: "2.0.0",
    });
    await expect(ensureContext7(updated.runtime, true, previous)).resolves.toMatchObject({
      version: "2.0.0",
      ownership: "holycodex",
    });
    expect(updated.installs()).toBe(1);
  });

  test("drops ownership after manager migration or same-version replacement", async () => {
    const original = context7Runtime({ family: "bun", latest: "2.0.0" });
    const previous = await ensureContext7(original.runtime, true);
    expect(previous.ownership).toBe("holycodex");

    const migrated = context7Runtime({ family: "npm", installed: "2.0.0", latest: "2.0.0" });
    await expect(ensureContext7(migrated.runtime, true, previous)).resolves.toMatchObject({
      ownership: "user",
    });
    await expect(removeOwnedContext7(migrated.runtime, previous)).resolves.toBe(false);
    expect(migrated.removes()).toBe(0);

    const replaced = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      packageRevision: "replacement",
    });
    await expect(ensureContext7(replaced.runtime, true, previous)).resolves.toMatchObject({
      ownership: "user",
    });
    await expect(removeOwnedContext7(replaced.runtime, previous)).resolves.toBe(false);
    expect(replaced.removes()).toBe(0);

    const relocated = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      root: "C:\\Users\\different",
    });
    await expect(ensureContext7(relocated.runtime, true, previous)).resolves.toMatchObject({
      ownership: "user",
    });
    await expect(removeOwnedContext7(relocated.runtime, previous)).resolves.toBe(false);
    expect(relocated.removes()).toBe(0);
  });

  test("fails closed for legacy 0.16.x ownership records without provenance", async () => {
    const fixture = context7Runtime({ family: "bun", installed: "2.0.0", latest: "2.0.0" });
    const legacy = context7State(fixture.shim, "holycodex");
    await expect(ensureContext7(fixture.runtime, true, legacy)).resolves.toMatchObject({
      ownership: "user",
    });
    await expect(removeOwnedContext7(fixture.runtime, legacy)).resolves.toBe(false);
    expect(fixture.removes()).toBe(0);
  });

  test("doctor detects missing and outdated manager-owned Context7 state", async () => {
    const missing = context7Runtime({ family: "pnpm", latest: "2.0.0" });
    await expect(ensureContext7(missing.runtime, false)).rejects.toMatchObject({
      code: "context7_unavailable",
    });

    const outdated = context7Runtime({ family: "pnpm", installed: "1.0.0", latest: "2.0.0" });
    await expect(ensureContext7(outdated.runtime, false)).rejects.toMatchObject({
      code: "context7_outdated",
      details: { installed: "1.0.0", latest: "2.0.0" },
    });
  });

  test("read-only Context7 inspection never resolves the registry", async () => {
    const fixture = context7Runtime({
      family: "pnpm",
      installed: "1.0.0",
      latest: "2.0.0",
      processPath: "node",
    });
    const inspected = await inspectContext7ReadOnly(fixture.runtime);
    expect(inspected).toMatchObject({ version: "1.0.0", executable: fixture.shim });
    expect(fixture.calls.some((call) => call.includes("view ctx7 version"))).toBe(false);
  });

  test("rejects missing, broken, mismatched, and shadowed shims", async () => {
    for (const option of [
      { missingShim: true },
      { brokenShim: true },
      { shimVersion: "9.9.9" },
      { outsidePackageBin: true },
    ]) {
      const fixture = context7Runtime({
        family: "bun",
        installed: "2.0.0",
        latest: "2.0.0",
        ...option,
      });
      await expect(ensureContext7(fixture.runtime, false)).rejects.toMatchObject({
        code: "context7_unavailable",
      });
    }

    const shadowed = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      shadowed: true,
    });
    await expect(ensureContext7(shadowed.runtime, false)).rejects.toMatchObject({
      code: "context7_shadowed",
    });
  });

  test("fails clearly when latest resolution or reconciliation fails", async () => {
    const bunLatestFailure = context7Runtime({
      family: "bun",
      processPath: "bun",
      installed: "1.0.0",
      latestFails: true,
    });
    await expect(ensureContext7(bunLatestFailure.runtime, true)).rejects.toMatchObject({
      code: "context7_verification_failed",
    });
    expect(bunLatestFailure.installs()).toBe(0);

    const latestFailure = context7Runtime({
      family: "npm",
      installed: "1.0.0",
      latestFails: true,
    });
    await expect(ensureContext7(latestFailure.runtime, true)).rejects.toMatchObject({
      code: "context7_verification_failed",
    });

    const managed = context7Runtime({ family: "npm", latest: "1.0.0" });
    const previous = await ensureContext7(managed.runtime, true);
    const installFailure = context7Runtime({
      family: "npm",
      installed: "1.0.0",
      latest: "2.0.0",
      installFails: true,
    });
    await expect(ensureContext7(installFailure.runtime, true, previous)).rejects.toMatchObject({
      code: "context7_install_failed",
      details: { stderr: "install failed" },
    });
  });

  test("removes only a matching recorded HolyCodex installation", async () => {
    const provenance = context7Runtime({ family: "bun", latest: "2.0.0" });
    const ownedState = await ensureContext7(provenance.runtime, true);
    expect(ownedState.ownership).toBe("holycodex");

    const owned = context7Runtime({ family: "bun", installed: "2.0.0", latest: "2.0.0" });
    await expect(removeOwnedContext7(owned.runtime, ownedState)).resolves.toBe(true);
    expect(owned.removes()).toBe(1);
    expect(owned.calls).toContain("bun remove --global --cwd=C:\\ ctx7");

    const user = context7Runtime({ family: "bun", installed: "2.0.0", latest: "2.0.0" });
    await expect(removeOwnedContext7(user.runtime, context7State(user.shim, "user"))).resolves.toBe(
      false,
    );
    expect(user.removes()).toBe(0);

    const drifted = context7Runtime({ family: "bun", installed: "3.0.0", latest: "3.0.0" });
    await expect(removeOwnedContext7(drifted.runtime, ownedState)).resolves.toBe(false);
    expect(drifted.removes()).toBe(0);
  });

  test("preserves shadowed state and reports an owned uninstall failure", async () => {
    const shadowed = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      shadowed: true,
    });
    const provenance = context7Runtime({ family: "bun", latest: "2.0.0" });
    const ownedState = await ensureContext7(provenance.runtime, true);
    await expect(removeOwnedContext7(shadowed.runtime, ownedState)).resolves.toBe(false);

    const failed = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      removeFails: true,
    });
    await expect(removeOwnedContext7(failed.runtime, ownedState)).rejects.toMatchObject({
      code: "context7_remove_failed",
      details: { stderr: "remove failed" },
    });

    const stale = context7Runtime({
      family: "bun",
      installed: "2.0.0",
      latest: "2.0.0",
      removeLeavesPackage: true,
    });
    await expect(removeOwnedContext7(stale.runtime, ownedState)).rejects.toMatchObject({
      code: "context7_remove_failed",
    });
  });

  test("rejects unknown launcher metadata before inspecting shared tooling", async () => {
    const fixture = context7Runtime({ family: "bun", installed: "2.0.0", latest: "2.0.0" });
    const runtime = { ...fixture.runtime, environment: { npm_command: "run" } };
    await expect(ensureContext7(runtime, true)).rejects.toBeInstanceOf(ToolingError);
    expect(fixture.calls).toHaveLength(0);
  });
});

type ContextFixtureOptions = Readonly<{
  family: Context7Manager["family"];
  processPath?: string;
  installed?: string;
  latest?: string;
  latestFails?: boolean;
  installFails?: boolean;
  removeFails?: boolean;
  removeLeavesPackage?: boolean;
  globalBinFails?: boolean;
  globalBinEmpty?: boolean;
  projectMissing?: boolean;
  missingProjectInitially?: boolean;
  missingShim?: boolean;
  brokenShim?: boolean;
  shimVersion?: string;
  shadowed?: boolean;
  shadowVersion?: string;
  outsidePackageBin?: boolean;
  packageRevision?: string;
  root?: string;
}>;

function context7Runtime(options: ContextFixtureOptions): {
  readonly runtime: InstallerRuntime;
  readonly calls: string[];
  readonly shim: string;
  readonly installs: () => number;
  readonly removes: () => number;
  readonly shimRuns: () => number;
} {
  const manager = managerFor(options.family);
  const calls: string[] = [];
  let current = options.installed;
  const processPath = options.processPath ?? "node";
  const packageRevision = options.packageRevision ?? "original";
  const root = options.root ?? "C:\\Users\\test";
  let installCount = 0;
  let removeCount = 0;
  let shimRunCount = 0;
  const binRoot =
    options.family === "bun"
      ? win32.join(root, ".bun", "bin")
      : options.family === "npm"
        ? win32.join(root, "npm")
        : win32.join(root, "pnpm", "bin");
  const packageRoot =
    options.family === "bun"
      ? win32.join(win32.dirname(binRoot), "install", "global", "node_modules", "ctx7")
      : options.family === "npm"
        ? win32.join(binRoot, "node_modules", "ctx7")
        : win32.join(root, "pnpm", "global", "node_modules", "ctx7");
  const packageExecutable = win32.join(packageRoot, "dist", "index.js");
  const shim = win32.join(binRoot, options.family === "bun" ? "ctx7.exe" : "ctx7.cmd");
  const projectRoot =
    options.family === "bun" ? win32.join(win32.dirname(binRoot), "install", "global") : undefined;
  const shadow = "C:\\Shadow\\ctx7.cmd";
  let projectAvailable = options.missingProjectInitially !== true;
  const environment = {
    ...manager.environment,
    PATH: options.shadowed ? `C:\\Shadow;${binRoot}` : "",
  };
  const present = (path: string): boolean => {
    const value = normalized(path);
    return (
      (options.family === "bun" && value === normalized(binRoot)) ||
      (projectRoot !== undefined &&
        projectAvailable &&
        !options.projectMissing &&
        value === normalized(projectRoot)) ||
      (current !== undefined && value === normalized(packageRoot)) ||
      (current !== undefined && value === normalized(packageExecutable)) ||
      (current !== undefined && !options.missingShim && value === normalized(shim)) ||
      (options.shadowed === true && value === normalized(shadow))
    );
  };
  const files: InstallerFileSystem = {
    access: async (path) => {
      if (!present(path)) throw new Error("ENOENT");
    },
    readText: async (path) => {
      if (
        normalized(path) !== normalized(win32.join(packageRoot, "package.json")) ||
        current === undefined
      ) {
        throw new Error("ENOENT");
      }
      return JSON.stringify({
        version: current,
        bin: { ctx7: "dist/index.js" },
        revision: packageRevision,
      });
    },
    realpath: async (path) => {
      if (normalized(path) === normalized(packageExecutable) && options.outsidePackageBin) {
        return "C:\\Outside\\index.js";
      }
      if (normalized(path) === normalized(packageRoot) && present(path)) return packageRoot;
      if (!present(path)) throw new Error("ENOENT");
      return path;
    },
  };
  const runtime: InstallerRuntime = {
    platform: "win32",
    environment,
    processPath,
    files,
    run: async (executable, args) => {
      calls.push(`${executable} ${args.join(" ")}`);
      if (
        executable === manager.executable ||
        (options.family === "bun" && executable === processPath)
      ) {
        const words = args.join(" ");
        if (words === manager.binCommand) {
          if (options.globalBinFails) return failure("bun global location unavailable");
          if (options.globalBinEmpty) return success();
          if (options.missingProjectInitially && !projectAvailable) {
            return failure(
              'error: No package.json was found for directory "C:\\Users\\test\\.bun\\install\\global"\nnote: Run "bun init" to initialize a project',
            );
          }
          return success(binRoot);
        }
        if (words === "root --global")
          return success("C:\\Users\\test\\pnpm\\global\\node_modules");
        if (words === manager.latestCommand) {
          return options.latestFails
            ? failure("latest failed")
            : success(options.latest ?? "2.0.0");
        }
        const bunGlobalInstall =
          options.family === "bun" &&
          args[0] === "add" &&
          args[1] === "--global" &&
          args[2]?.startsWith("--cwd=") === true &&
          args[3] === "ctx7@latest";
        if (words === manager.installCommand || bunGlobalInstall) {
          installCount += 1;
          if (options.installFails) return failure("install failed");
          current = options.latest ?? "2.0.0";
          if (options.missingProjectInitially) projectAvailable = true;
          return success();
        }
        const bunGlobalRemove =
          options.family === "bun" &&
          args[0] === "remove" &&
          args[1] === "--global" &&
          args[2]?.startsWith("--cwd=") === true &&
          args[3] === "ctx7";
        if (words === manager.removeCommand || bunGlobalRemove) {
          removeCount += 1;
          if (options.removeFails) return failure("remove failed");
          if (!options.removeLeavesPackage) current = undefined;
          return success();
        }
      }
      if (normalized(executable) === normalized(shim)) {
        shimRunCount += 1;
        if (options.brokenShim) return failure("broken shim");
        return success(`ctx7 ${options.shimVersion ?? current ?? "0.0.0"}`);
      }
      if (normalized(executable) === normalized(shadow) && options.shadowVersion !== undefined) {
        return success(`ctx7 ${options.shadowVersion}`);
      }
      return failure("unexpected command");
    },
  };
  return {
    runtime,
    calls,
    shim,
    installs: () => installCount,
    removes: () => removeCount,
    shimRuns: () => shimRunCount,
  };
}

function managerFor(family: Context7Manager["family"]): {
  readonly executable: Context7Manager["executable"];
  readonly environment: Readonly<Record<string, string>>;
  readonly binCommand: string;
  readonly latestCommand: string;
  readonly installCommand: string;
  readonly removeCommand: string;
} {
  switch (family) {
    case "bun":
      return {
        executable: "bun",
        environment: { npm_execpath: "C:/bun/bin/bunx.exe" },
        binCommand: "pm bin -g",
        latestCommand: "pm view ctx7 version",
        installCommand: "add --global ctx7@latest",
        removeCommand: "remove --global ctx7",
      };
    case "npm":
      return {
        executable: "npm",
        environment: { npm_execpath: "C:/npm/bin/npx-cli.js", npm_command: "exec" },
        binCommand: "prefix --global",
        latestCommand: "view ctx7 version",
        installCommand: "install --global ctx7@latest",
        removeCommand: "uninstall --global ctx7",
      };
    case "pnpm":
      return {
        executable: "pnpm",
        environment: { npm_execpath: "C:/pnpm/pnpm.cjs", npm_command: "dlx" },
        binCommand: "bin --global",
        latestCommand: "view ctx7 version",
        installCommand: "add --global ctx7@latest",
        removeCommand: "remove --global ctx7",
      };
  }
}

function context7State(
  executable: string,
  ownership: Context7ToolState["ownership"],
  manager: Context7Manager["family"] = "bun",
): Context7ToolState {
  const launcher = manager === "bun" ? "bunx" : manager === "npm" ? "npx" : "pnpm dlx";
  return {
    manager,
    launcher,
    version: "2.0.0",
    executable,
    ownership,
  };
}
