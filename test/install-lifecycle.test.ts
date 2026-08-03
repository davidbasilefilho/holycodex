import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanup, install, type InstallRuntime } from "../packages/cli/src/install";

const originalHome = process.env.CODEX_HOME;
const fixtures: string[] = [];
const runtime: InstallRuntime = {
  platform: "win32",
  gitBash: () => ({ found: true, path: "bash.exe", source: "env", checkedPaths: [] }),
  runProcess: async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ installed: [], available: [] }),
    stderr: "",
    timedOut: false,
    matched: false,
    outputTruncated: false,
  }),
};

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function home(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(path);
  process.env.CODEX_HOME = path;
  return path;
}

describe.sequential("install lifecycle", () => {
  it("is idempotent and cleanup preserves unrelated configuration", async () => {
    const root = await home("holycodex-lifecycle-");
    await writeFile(join(root, "config.toml"), "[custom]\nvalue = true\n");

    await install({ autonomy: "default", json: true }, runtime);
    await install({ autonomy: "default", json: true }, runtime);
    await cleanup({ json: true });
    await cleanup({ json: true });

    expect(await readFile(join(root, "config.toml"), "utf8")).toBe("[custom]\nvalue = true\n");
    await expect(access(join(root, "plugins", "cache", "holycodex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports every concise installation phase in order", async () => {
    await home("holycodex-progress-");
    const events: string[] = [];

    await install(
      {
        autonomy: "default",
        json: false,
        onProgress: ({ step, status }) => events.push(`${step}:${status}`),
      },
      runtime,
    );

    expect(events.filter((event) => event.endsWith(":complete"))).toEqual([
      "prerequisites:complete",
      "backup:complete",
      "configuration:complete",
      "staging:complete",
      "validation:complete",
      "managed-files:complete",
      "codex-security:complete",
      "computer-use:complete",
      "cleanup:complete",
    ]);
  });

  it("restores the previous usable state after a post-commit failure", async () => {
    const root = await home("holycodex-rollback-");
    const config = "[custom]\nvalue = true\n";
    const cache = join(root, "plugins", "cache", "holycodex");
    const agents = join(root, "holycodex", "agents");
    await writeFile(join(root, "config.toml"), config);
    await mkdir(cache, { recursive: true });
    await mkdir(agents, { recursive: true });
    await writeFile(join(cache, "before.txt"), "cache-before");
    await writeFile(join(agents, "before.txt"), "agents-before");

    await expect(
      install(
        { autonomy: "default", json: true },
        {
          ...runtime,
          runProcess: async () => {
            throw new Error("injected post-commit failure");
          },
        },
      ),
    ).rejects.toThrow("injected post-commit failure");

    expect(await readFile(join(root, "config.toml"), "utf8")).toBe(config);
    expect(await readFile(join(cache, "before.txt"), "utf8")).toBe("cache-before");
    expect(await readFile(join(agents, "before.txt"), "utf8")).toBe("agents-before");
  });
});
