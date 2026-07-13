import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, install } from "../src/install";

const originalHome = process.env.CODEX_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
});

describe("install lifecycle", () => {
  it("preserves unrelated config, removes legacy OMO, and cleans only HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await mkdir(join(home, "plugins", "cache", "sisyphuslabs", "omo"), { recursive: true });
    await writeFile(join(home, "plugins", "cache", "sisyphuslabs", "omo", "old.txt"), "old");
    await writeFile(join(home, "config.toml"), "[custom]\nvalue = true\n");

    const first = await install({ autonomous: false, json: false });
    const installed = await readFile(join(home, "config.toml"), "utf8");
    expect(installed).toContain("[custom]\nvalue = true");
    expect(first.changed).toContain(join(home, "plugins", "cache", "sisyphuslabs", "omo"));
    expect(first.backups.length).toBeGreaterThan(0);
    expect((await install({ autonomous: false, json: false })).action).toBe("install");

    await cleanup({ autonomous: false, json: false });
    await cleanup({ autonomous: false, json: false });
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe("[custom]\nvalue = true\n");
  });

  it("removes a config created solely by HolyCodex", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-test-"));
    process.env.CODEX_HOME = home;
    await install({ autonomous: false, json: false });
    await cleanup({ autonomous: false, json: false });
    await expect(readFile(join(home, "config.toml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
