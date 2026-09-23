// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { runAgentBinary } from "./index.ts";

const execFileAsync = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function io(cwd: string) {
  let stdout = "";
  let stderr = "";
  return {
    value: () => ({ stdout, stderr }),
    io: {
      cwd,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    },
  };
}

async function initRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", root]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await Bun.write(join(root, ".gitignore"), ".holycodex/\n");
  await Bun.write(join(root, "README.md"), "initial\n");
  await execFileAsync("git", ["-C", root, "add", ".gitignore", "README.md"]);
  await execFileAsync("git", ["-C", root, "commit", "-q", "-m", "initial"]);
}

async function runAgent(cwd: string, argv: readonly string[]) {
  const captured = io(cwd);
  const exitCode = await runAgentBinary([...argv, "--repo", cwd], captured.io);
  return { exitCode, ...captured.value() };
}

describe("holycodex-agent", () => {
  test("supports equivalent side-effect-free help at every command depth", async () => {
    const cwd = await createTemporaryDirectory("holycodex-agent-help-");
    const paths: readonly (readonly string[])[] = [
      [],
      ["intent"],
      ["intent", "create"],
      ["intent", "list"],
      ["intent", "current"],
      ["intent", "read"],
      ["intent", "select"],
      ["intent", "transition"],
      ["intent", "evidence"],
      ["intent", "integrate"],
      ["intent", "complete"],
      ["intent", "abandon"],
      ["plan"],
      ["plan", "read"],
      ["plan", "revise"],
      ["assignment"],
      ["assignment", "create"],
      ["assignment", "list"],
      ["assignment", "read"],
      ["assignment", "revise"],
      ["assignment", "supersede"],
      ["assignment", "start"],
      ["assignment", "recover"],
      ["assignment", "result"],
    ];
    for (const path of paths) {
      const short = io(cwd);
      expect(await runAgentBinary([...path, "-h"], short.io)).toBe(0);
      const long = io(cwd);
      expect(await runAgentBinary([...path, "--help"], long.io)).toBe(0);
      expect(long.value().stdout).toBe(short.value().stdout);
      expect(short.value().stderr).toBe("");
      expect(long.value().stderr).toBe("");
    }
    const rootHelp = io(cwd);
    expect(await runAgentBinary(["--help"], rootHelp.io)).toBe(0);
    expect(rootHelp.value().stdout).toContain(
      "assignment  create, list, read, revise, supersede, start, recover, result",
    );

    const assignmentHelp = io(cwd);
    expect(await runAgentBinary(["assignment", "--help"], assignmentHelp.io)).toBe(0);
    expect(assignmentHelp.value().stdout).toContain(
      "Root may use recover only to record a confirmed interrupted invocation as failed.",
    );

    const resultHelp = io(cwd);
    expect(await runAgentBinary(["assignment", "result", "--help"], resultHelp.io)).toBe(0);
    expect(resultHelp.value().stdout).toMatch(
      /Supply the active invocation ID and matching capability for current\s+records and historical records with a raw capability\./u,
    );
    expect(resultHelp.value().stdout).toMatch(
      /A capability-free result is accepted only\s+for legacy executing records/u,
    );
    expect(resultHelp.value().stdout).toContain(
      "neither a persisted verifier nor a raw capability.",
    );

    const recoveryHelp = io(cwd);
    expect(await runAgentBinary(["assignment", "recover", "--help"], recoveryHelp.io)).toBe(0);
    expect(recoveryHelp.value().stdout).toMatch(
      /Exact invocation\s+identity and revision must match\./,
    );
    expect(recoveryHelp.value().stdout).toContain("It cannot record success");
    expect(recoveryHelp.value().stdout).toContain("does not authenticate that its caller is Root");
    await expect(readdir(join(cwd, ".holycodex"))).rejects.toThrow();
  });

  test("returns a structured classified failure for invalid usage", async () => {
    const cwd = await createTemporaryDirectory("holycodex-agent-invalid-");
    const captured = io(cwd);
    expect(await runAgentBinary(["intent", "list", "--unknown", "value"], captured.io)).toBe(2);
    expect(captured.value().stdout).toBe("");
    expect(JSON.parse(captured.value().stderr)).toMatchObject({
      schema_version: "holycodex-agent-response-1",
      ok: false,
      error: { code: "invalid_usage" },
    });
  });

  test("classifies malformed external argv through the Effect Schema boundary", async () => {
    const captured = io(await createTemporaryDirectory("holycodex-agent-argv-"));
    expect(
      await runAgentBinary(["intent", 42 as unknown as string] as readonly string[], captured.io),
    ).toBe(2);
    expect(JSON.parse(captured.value().stderr)).toMatchObject({
      schema_version: "holycodex-agent-response-1",
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  test("authorizes current, historical raw-capability, and capability-free results", async () => {
    const cwd = await createTemporaryDirectory("holycodex-agent-capability-");
    await initRepository(cwd);

    const createdIntent = await runAgent(cwd, [
      "intent",
      "create",
      "--input",
      JSON.stringify({
        title: "Specialist result authorization",
        goal: "Keep model-facing terminal writes attributable",
        acceptanceCriteria: ["proof"],
      }),
    ]);
    expect(createdIntent.exitCode).toBe(0);
    const intent = JSON.parse(createdIntent.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };

    const createdAssignment = await runAgent(cwd, [
      "assignment",
      "create",
      "--intent",
      intent.id,
      "--revision",
      String(intent.revision),
      "--input",
      JSON.stringify({
        id: "capability-bound",
        objective: "Record an attributable terminal result",
        owner: { role: "Worker", task: "implementation" },
        scope: ["README.md"],
        acceptanceCriteria: ["proof"],
      }),
    ]);
    expect(createdAssignment.exitCode).toBe(0);
    const assignment = JSON.parse(createdAssignment.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };

    const started = await runAgent(cwd, [
      "assignment",
      "start",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(assignment.revision),
    ]);
    expect(started.exitCode).toBe(0);
    const running = JSON.parse(started.stdout).data as {
      readonly revision: number;
      readonly active_invocation_id?: string;
      readonly capability?: string;
    };
    expect(running.active_invocation_id).toBeDefined();
    expect(running.capability).toMatch(/^[a-f0-9]{64}$/u);

    const legacyMissingCapability = await runAgent(cwd, [
      "assignment",
      "result",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(running.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        outcome: "completed",
        summary: "Missing capability",
      }),
    ]);
    expect(legacyMissingCapability.exitCode).toBe(2);
    expect(JSON.parse(legacyMissingCapability.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });

    const wrongCapability = await runAgent(cwd, [
      "assignment",
      "result",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(running.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        capability: "f".repeat(64),
        outcome: "completed",
        summary: "Wrong capability",
      }),
    ]);
    expect(wrongCapability.exitCode).toBe(1);
    expect(JSON.parse(wrongCapability.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });

    const completed = await runAgent(cwd, [
      "assignment",
      "result",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(running.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        capability: running.capability,
        outcome: "completed",
        summary: "Capability-bound result",
      }),
    ]);
    expect(completed.exitCode).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({
      ok: true,
      data: { assignment: { status: "completed" } },
    });

    const completedData = JSON.parse(completed.stdout).data as {
      readonly intent: { readonly revision: number };
    };
    const legacyCreated = await runAgent(cwd, [
      "assignment",
      "create",
      "--intent",
      intent.id,
      "--revision",
      String(completedData.intent.revision),
      "--input",
      JSON.stringify({
        id: "legacy-result",
        objective: "Complete an executing legacy record",
        owner: { role: "Worker", task: "implementation" },
        scope: ["README.md"],
        acceptanceCriteria: ["proof"],
      }),
    ]);
    expect(legacyCreated.exitCode).toBe(0);
    const legacyAssignment = JSON.parse(legacyCreated.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };
    const legacyStarted = await runAgent(cwd, [
      "assignment",
      "start",
      "--intent",
      intent.id,
      "--assignment",
      legacyAssignment.id,
      "--revision",
      String(legacyAssignment.revision),
    ]);
    expect(legacyStarted.exitCode).toBe(0);
    const runningLegacy = JSON.parse(legacyStarted.stdout).data as {
      readonly revision: number;
      readonly active_invocation_id?: string;
      readonly capability?: string;
    };
    expect(runningLegacy.active_invocation_id).toBeDefined();
    expect(runningLegacy.capability).toMatch(/^[a-f0-9]{64}$/u);
    const legacyCapability = runningLegacy.capability;
    if (legacyCapability === undefined)
      throw new Error("assignment start did not return a capability");
    const intentDirectory = (await readdir(join(cwd, ".holycodex"))).find(
      (entry) => entry !== "current" && entry !== ".intent-store",
    );
    if (intentDirectory === undefined) throw new Error("Intent directory was not created");
    const assignmentPath = join(
      cwd,
      ".holycodex",
      intentDirectory,
      "assignments",
      `${legacyAssignment.id}.toon`,
    );
    const legacyText = await readFile(assignmentPath, "utf8");
    expect(legacyText).not.toContain(legacyCapability);
    expect(legacyText).toMatch(/^active_invocation_capability_verifier:/mu);
    await writeFile(
      assignmentPath,
      legacyText.replace(
        /^active_invocation_capability_verifier:.*\r?\n?/mu,
        `active_invocation_capability: ${legacyCapability}\n`,
      ),
      "utf8",
    );

    const legacyRecovered = await runAgent(cwd, [
      "assignment",
      "result",
      "--intent",
      intent.id,
      "--assignment",
      legacyAssignment.id,
      "--revision",
      String(runningLegacy.revision),
      "--input",
      JSON.stringify({
        invocationId: runningLegacy.active_invocation_id,
        capability: legacyCapability,
        outcome: "completed",
        summary: "Historical raw-capability result",
      }),
    ]);
    expect(legacyRecovered.exitCode).toBe(0);
    expect(JSON.parse(legacyRecovered.stdout)).toMatchObject({
      ok: true,
      data: { assignment: { status: "completed" } },
    });

    const legacyWithoutIdentityCreated = await runAgent(cwd, [
      "assignment",
      "create",
      "--intent",
      intent.id,
      "--revision",
      String(JSON.parse(legacyRecovered.stdout).data.intent.revision),
      "--input",
      JSON.stringify({
        id: "legacy-result-without-identity",
        objective: "Complete an executing legacy record without invocation identity",
        owner: { role: "Worker", task: "implementation" },
        scope: ["README.md"],
        acceptanceCriteria: ["proof"],
      }),
    ]);
    expect(legacyWithoutIdentityCreated.exitCode).toBe(0);
    const legacyWithoutIdentity = JSON.parse(legacyWithoutIdentityCreated.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };
    const legacyWithoutIdentityStarted = await runAgent(cwd, [
      "assignment",
      "start",
      "--intent",
      intent.id,
      "--assignment",
      legacyWithoutIdentity.id,
      "--revision",
      String(legacyWithoutIdentity.revision),
    ]);
    expect(legacyWithoutIdentityStarted.exitCode).toBe(0);
    const runningLegacyWithoutIdentity = JSON.parse(legacyWithoutIdentityStarted.stdout).data as {
      readonly revision: number;
      readonly active_invocation_id?: string;
      readonly capability?: string;
    };
    expect(runningLegacyWithoutIdentity.capability).toMatch(/^[a-f0-9]{64}$/u);
    const legacyWithoutIdentityPath = join(
      cwd,
      ".holycodex",
      intentDirectory,
      "assignments",
      `${legacyWithoutIdentity.id}.toon`,
    );
    const idAndCapabilityFreeText = (await readFile(legacyWithoutIdentityPath, "utf8"))
      .replace(/^active_invocation_id:.*\r?\n?/mu, "")
      .replace(/^active_started_at:.*\r?\n?/mu, "")
      .replace(/^active_invocation_capability_verifier:.*\r?\n?/mu, "")
      .replace(/^active_invocation_capability:.*\r?\n?/mu, "");
    await writeFile(legacyWithoutIdentityPath, idAndCapabilityFreeText, "utf8");

    const missingCapability = await runAgent(cwd, [
      "assignment",
      "result",
      "--intent",
      intent.id,
      "--assignment",
      legacyWithoutIdentity.id,
      "--revision",
      String(runningLegacyWithoutIdentity.revision),
      "--input",
      JSON.stringify({
        outcome: "completed",
        summary: "Legacy capability-free result",
      }),
    ]);
    expect(missingCapability.exitCode).toBe(0);
    expect(JSON.parse(missingCapability.stdout)).toMatchObject({
      ok: true,
      data: { assignment: { status: "completed" } },
    });
  }, 30_000);

  test("records interruption recovery through the CLI when the persisted verifier remains", async () => {
    const cwd = await createTemporaryDirectory("holycodex-agent-recovery-");
    await initRepository(cwd);

    const createdIntent = await runAgent(cwd, [
      "intent",
      "create",
      "--input",
      JSON.stringify({
        title: "Interrupted CLI recovery",
        goal: "Record a lost-capability invocation as interrupted",
        acceptanceCriteria: ["truthful terminal state"],
      }),
    ]);
    const intent = JSON.parse(createdIntent.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };
    const createdAssignment = await runAgent(cwd, [
      "assignment",
      "create",
      "--intent",
      intent.id,
      "--revision",
      String(intent.revision),
      "--input",
      JSON.stringify({
        id: "interrupted-cli",
        objective: "Recover an interrupted invocation",
        owner: { role: "Worker", task: "implementation" },
        scope: ["README.md"],
        acceptanceCriteria: ["record failure"],
      }),
    ]);
    const assignment = JSON.parse(createdAssignment.stdout).data as {
      readonly id: string;
      readonly revision: number;
    };
    const started = await runAgent(cwd, [
      "assignment",
      "start",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(assignment.revision),
    ]);
    const running = JSON.parse(started.stdout).data as {
      readonly revision: number;
      readonly active_invocation_id?: string;
      readonly active_started_at?: string;
    };
    if (running.active_invocation_id === undefined || running.active_started_at === undefined)
      throw new Error("assignment start did not return exact invocation identity");

    const intentDirectory = (await readdir(join(cwd, ".holycodex"))).find(
      (entry) => entry !== "current" && entry !== ".intent-store",
    );
    if (intentDirectory === undefined) throw new Error("Intent directory was not created");
    const assignmentPath = join(
      cwd,
      ".holycodex",
      intentDirectory,
      "assignments",
      `${assignment.id}.toon`,
    );
    const persisted = await readFile(assignmentPath, "utf8");
    expect(persisted).toMatch(/^active_invocation_capability_verifier:/mu);

    const missingReason = await runAgent(cwd, [
      "assignment",
      "recover",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(running.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        startedAt: running.active_started_at,
      }),
    ]);
    expect(missingReason.exitCode).toBe(2);
    expect(JSON.parse(missingReason.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });

    const recovered = await runAgent(cwd, [
      "assignment",
      "recover",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(running.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        startedAt: running.active_started_at,
        interruptionReason: "The invocation stopped before returning its capability-bound result.",
      }),
    ]);
    expect(recovered.exitCode).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      operation: "assignment.recover",
      data: {
        assignment: {
          status: "failed",
          invocations: [
            {
              id: running.active_invocation_id,
              outcome: "failed",
              started_at: running.active_started_at,
              evidence: [
                {
                  kind: "behavior",
                  result: "failed",
                  value: expect.stringContaining("recovered as failed"),
                },
              ],
            },
          ],
        },
      },
    });

    const attemptedSuccess = await runAgent(cwd, [
      "assignment",
      "recover",
      "--intent",
      intent.id,
      "--assignment",
      assignment.id,
      "--revision",
      String(JSON.parse(recovered.stdout).data.assignment.revision),
      "--input",
      JSON.stringify({
        invocationId: running.active_invocation_id,
        startedAt: running.active_started_at,
        interruptionReason: "attempt success",
        outcome: "completed",
      }),
    ]);
    expect(attemptedSuccess.exitCode).toBe(2);
    expect(JSON.parse(attemptedSuccess.stderr)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  }, 15_000);
});
