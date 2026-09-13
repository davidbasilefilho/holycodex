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
});
