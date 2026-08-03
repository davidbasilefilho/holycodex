import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { publicationPlan, publicationSummary } from "../scripts/publish.mjs";
import {
  lockfileWorkspaceVersions,
  nextDevVersion,
  nextZeroVersion,
  replaceVersionIfPresent,
  versionedSource,
  versionedLockfile,
  versionedJson,
} from "../scripts/version.mjs";

const root = join(import.meta.dirname, "..");
const run = promisify(execFile);

describe("zerover versioning", () => {
  it("bumps fixes on the patch component", () => {
    expect(nextZeroVersion("0.2.0", "patch")).toBe("0.2.1");
  });

  it("bumps breaking changes on the second component", () => {
    expect(nextZeroVersion("0.2.7", "minor")).toBe("0.3.0");
  });

  it("accepts an explicit zerover version and rejects 1.x", () => {
    expect(nextZeroVersion("0.2.0", "0.4.3")).toBe("0.4.3");
    expect(() => nextZeroVersion("0.2.0", "1.0.0")).toThrow(/Usage/);
  });

  it("derives unique npm dev-channel prerelease versions", () => {
    expect(nextDevVersion("0.6.0", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(nextDevVersion("0.6.0-rc.2", "42", "3")).toBe("0.6.0-dev.42.3");
    expect(() => nextDevVersion("0.6.0", "run", "1")).toThrow(/Usage/);
  });

  it("keeps the CLI and plugin package versions exact", () => {
    const source = {
      name: "holycodex",
      version: "0.6.0",
      dependencies: { "@holycodex/plugin": "0.6.0", retained: "1.0.0" },
    };
    expect(versionedJson("packages/cli/package.json", source, "0.6.0-dev.4.2")).toEqual({
      ...source,
      version: "0.6.0-dev.4.2",
      dependencies: { "@holycodex/plugin": "0.6.0-dev.4.2", retained: "1.0.0" },
    });
  });

  it("reads workspace versions from the Bun lockfile", () => {
    const source = `{
  "workspaces": {
    "": { "name": "holycodex" },
    "packages/cli": {
      "name": "holycodex",
      "version": "0.9.5",
      "dependencies": { "@holycodex/plugin": "0.9.5" },
    },
    "packages/plugin": {
      "name": "@holycodex/plugin",
      "version": "0.9.5",
    },
  },
  "packages": {},
}`;

    expect(lockfileWorkspaceVersions(source)).toEqual({
      "packages/cli": "0.9.5",
      "packages/plugin": "0.9.5",
    });
    const bumped = versionedLockfile(source, "0.9.6");
    expect(lockfileWorkspaceVersions(bumped)).toEqual({
      "packages/cli": "0.9.6",
      "packages/plugin": "0.9.6",
    });
    expect(bumped).toContain('"@holycodex/plugin": "0.9.6"');
  });

  it("updates generated runtime versions without mutating files during a dry run", async () => {
    expect(versionedSource("runtime.js", 'VERSION = "0.10.6"', "0.10.6", "0.10.7")).toContain(
      'VERSION = "0.10.7"',
    );
    const runtime = join(root, "packages", "plugin", "plugin", "runtime", "core-instructions.js");
    const before = await readFile(runtime, "utf8");
    await run(
      process.execPath,
      [join(root, "scripts", "version.mjs"), "dev", "42", "1", "--dry-run"],
      { cwd: root },
    );
    expect(await readFile(runtime, "utf8")).toBe(before);
  });

  it("allows a clean checkout to derive a version before ignored runtime output exists", async () => {
    await expect(
      replaceVersionIfPresent("packages/plugin/plugin/runtime/missing.js", "0.10.6", "0.10.7"),
    ).resolves.toBe(false);
  });
});

describe("npm publication", () => {
  it("publishes missing packages and skips only integrity-matched registry versions", () => {
    const local = [
      { name: "@holycodex/plugin", version: "0.10.7", integrity: "sha512-plugin" },
      { name: "holycodex", version: "0.10.7", integrity: "sha512-cli" },
    ];
    expect(
      publicationPlan(local, new Map([["@holycodex/plugin@0.10.7", "sha512-plugin"]])),
    ).toEqual([
      { ...local[0], action: "skip" },
      { ...local[1], action: "publish" },
    ]);
    expect(() =>
      publicationPlan(local, new Map([["@holycodex/plugin@0.10.7", "sha512-different"]])),
    ).toThrow(/integrity/);
    expect(local[0].name).toBe("@holycodex/plugin");
    expect(local[1].name).toBe("holycodex");
    expect(publicationSummary({ ...local[0], action: "skip" }, "latest", "existing")).toContain(
      "package=@holycodex/plugin version=0.10.7 result=existing tag=latest",
    );
  });
});
