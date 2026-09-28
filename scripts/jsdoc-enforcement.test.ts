// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const oxlintPath = join(workspaceRoot, "node_modules/.bin/oxlint");
const configPath = join(workspaceRoot, ".oxlintrc.json");

async function readOutput(stream: Bun.Subprocess["stdout"]): Promise<string> {
  return stream instanceof ReadableStream ? new Response(stream).text() : "";
}

async function lintFixture(source: string): Promise<{ exitCode: number; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), "holycodex-jsdoc-"));
  try {
    const fixturePath = join(directory, "fixture.ts");
    await writeFile(fixturePath, source, "utf8");
    const child = Bun.spawn([oxlintPath, "-c", configPath, fixturePath], {
      cwd: workspaceRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      readOutput(child.stdout),
      readOutput(child.stderr),
    ]);
    return { exitCode: await child.exited, output: `${stdout}${stderr}` };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("JSDoc enforcement rule", () => {
  test("accepts documented exports, aliases, and public methods", async () => {
    const result = await lintFixture(`
/** A directly exported function. */
export function direct() {}

/** A function exported through a local alias. */
function local() {}
export { local as alias };

/** A default function exported through a local binding. */
const defaultImplementation = () => {};
export default defaultImplementation;

/** Public API exposed by the fixture. */
export class PublicApi {
  /** Run the public operation. */
  run() {
    this.helper();
    this.hidden();
    this.#secret();
  }

  protected helper() {}
  private hidden() {}
  #secret() {}
}
`);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("holycodex(require-jsdoc)");
  });

  test("reports undocumented direct exports, aliases, and public methods", async () => {
    const result = await lintFixture(`
function local() {}
export { local as alias };
export const direct = () => {};

export class PublicApi {
  run() {}
  private hidden() {}
}
`);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.output).toContain("holycodex(require-jsdoc)");
    expect(result.output).toContain('Exported function "alias"');
    expect(result.output).toContain('Exported function "direct"');
    expect(result.output).toContain('Exported class "PublicApi"');
    expect(result.output).toContain('Public method "run"');
    expect(result.output).not.toContain('Public method "hidden"');
  });

  test("requires documentation for exported types, schemas, and public type members", async () => {
    const result = await lintFixture(`
export interface User {
  id: string;
}

export type UserOptions = {
  enabled: boolean;
};

export const UserSchema = { parse() {} };

export enum Status {
  Ready,
}

type LocalValue = string;
export { LocalValue as Value };

interface InternalOnly {
  id: string;
}
const internalSchema = {};
`);

    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.output).toContain('Exported interface "User"');
    expect(result.output).toContain('Public type member "id"');
    expect(result.output).toContain('Exported type alias "UserOptions"');
    expect(result.output).toContain('Public type member "enabled"');
    expect(result.output).toContain('Exported value "UserSchema"');
    expect(result.output).toContain('Exported enum "Status"');
    expect(result.output).toContain('Public enum member "Ready"');
    expect(result.output).toContain('Exported declaration "Value"');
    expect(result.output).not.toMatch(/holycodex\(require-jsdoc\).*InternalOnly/);
    expect(result.output).not.toMatch(/holycodex\(require-jsdoc\).*internalSchema/);
  });

  test("accepts documented API declarations and leaves internal declarations alone", async () => {
    const result = await lintFixture(`
/** A public user shape. */
export interface User {
  /** Stable identity for the user. */
  id: string;
}

/** Options accepted by the user API. */
export type UserOptions = {
  /** Whether the user is enabled. */
  enabled: boolean;
};

/** Runtime validator for user input. */
export const UserSchema = { parse() {} };

/** A public status. */
export enum Status {
  /** Ready to use. */
  Ready,
}

/** Default public options. */
export default interface Defaults {
  /** Number of retries. */
  retries: number;
}

/** A public model with a documented field. */
export class UserModel {
  /** Stable user identity. */
  id = "";
}

interface InternalOnly {
  id: string;
}
const internalSchema = {};
`);

    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("holycodex(require-jsdoc)");
  });
});
