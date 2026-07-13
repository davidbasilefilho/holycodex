import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("CLI", () => {
  it("prints version under Node", async () => {
    const result = await run(process.execPath, ["src/cli.ts", "--version"]);
    expect(result.stdout).toBe("0.4.6\n");
  });

  it("enables autonomous Codex permissions by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    await run(process.execPath, ["src/cli.ts", "install", "--json"], {
      env: { ...process.env, CODEX_HOME: home },
    });

    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
  });

  it("allows autonomous Codex permissions to be disabled", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    await run(process.execPath, ["src/cli.ts", "install", "--no-codex-autonomous"], {
      env: { ...process.env, CODEX_HOME: home },
    });

    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).not.toContain("approval_policy");
    expect(config).not.toContain("sandbox_mode");
  });
});
