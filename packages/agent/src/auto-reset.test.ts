// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountRateLimitsReadResultSchema } from "@holycodex/codex";
import * as Schema from "effect/Schema";

import type { AutoResetAccountClient } from "./auto-reset-runtime.ts";
import { decideBankedReset } from "./auto-reset.ts";
import { runAgentBinary } from "./index.ts";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createCodexHome(prefix: string): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(codexHome);
  return codexHome;
}

async function installAutoResetSelection(
  codexHome: string,
  enabled: boolean | null = true,
): Promise<void> {
  const stateDirectory = join(codexHome, "holycodex");
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(
    join(stateDirectory, "active.toml"),
    [
      "format_version = 1",
      "null_paths = []",
      "",
      "[record]",
      'owner = "holycodex"',
      "",
      "[record.optional_selections]",
      "browser_use = true",
      "computer_use = false",
      "sites = true",
      ...(enabled === null ? [] : [`"auto-reset" = ${String(enabled)}`]),
      "",
    ].join("\n"),
  );
}

const weeklyOnly = (remainingPercent: number) => ({
  snapshot: {
    primary: null,
    secondary: { usedPercent: 100 - remainingPercent, windowDurationMins: 10_080 },
  },
});
const fiveHourAndWeekly = (fiveHourRemaining: number, weeklyRemaining: number) => ({
  snapshot: {
    primary: { usedPercent: 100 - fiveHourRemaining, windowDurationMins: 300 },
    secondary: { usedPercent: 100 - weeklyRemaining, windowDurationMins: 10_080 },
  },
});

describe("banked auto-reset decision", () => {
  test("detects a present five-hour window and applies strict upper thresholds", () => {
    expect(decideBankedReset(fiveHourAndWeekly(20, 15))).toMatchObject({
      hasFiveHourLimit: true,
      decision: "doNotReset",
    });
    expect(decideBankedReset(fiveHourAndWeekly(19.99, 50))).toMatchObject({
      decision: "requestPermission",
    });
    expect(decideBankedReset(fiveHourAndWeekly(15, 50))).toMatchObject({
      decision: "requestPermission",
    });
    expect(decideBankedReset(fiveHourAndWeekly(50, 14.99))).toMatchObject({
      decision: "requestPermission",
    });
    expect(decideBankedReset(fiveHourAndWeekly(50, 7))).toMatchObject({
      decision: "requestPermission",
    });
  });

  test("a lower five-hour threshold overrides earlier refusal", () => {
    expect(
      decideBankedReset({
        ...fiveHourAndWeekly(16, 50),
        permission: "refused",
      }),
    ).toMatchObject({ decision: "requestPermission" });
    expect(
      decideBankedReset({
        ...fiveHourAndWeekly(14.99, 50),
        permission: "refused",
      }),
    ).toMatchObject({ decision: "resetAuthorized" });
    expect(decideBankedReset(fiveHourAndWeekly(50, 6.99))).toMatchObject({
      decision: "resetAuthorized",
    });
  });

  test("detects a weekly-only plan from current windows and resets below five percent", () => {
    expect(decideBankedReset(weeklyOnly(10))).toMatchObject({
      hasFiveHourLimit: false,
      decision: "doNotReset",
    });
    expect(decideBankedReset(weeklyOnly(9.99))).toMatchObject({ decision: "requestPermission" });
    expect(decideBankedReset({ ...weeklyOnly(8), permission: "refused" })).toMatchObject({
      decision: "requestPermission",
    });
    expect(decideBankedReset({ ...weeklyOnly(4.99), permission: "refused" })).toMatchObject({
      decision: "resetAuthorized",
    });
    expect(decideBankedReset(weeklyOnly(5))).toMatchObject({ decision: "requestPermission" });
  });

  test("does not infer a weekly-only plan when a present window has unknown duration", () => {
    expect(
      decideBankedReset({
        snapshot: {
          primary: { usedPercent: 90, windowDurationMins: null },
          secondary: { usedPercent: 90, windowDurationMins: 10_080 },
        },
      }),
    ).toMatchObject({
      hasFiveHourLimit: null,
      weeklyRemainingPercent: 10,
      fiveHourRemainingPercent: null,
      decision: "insufficientEvidence",
    });
    expect(decideBankedReset(weeklyOnly(10))).toMatchObject({
      hasFiveHourLimit: false,
      decision: "doNotReset",
    });
  });

  test("returns insufficient evidence instead of inferring an absent weekly window", () => {
    expect(decideBankedReset({ snapshot: { primary: null, secondary: null } })).toMatchObject({
      hasFiveHourLimit: null,
      weeklyRemainingPercent: null,
      decision: "insufficientEvidence",
    });
    expect(
      decideBankedReset({
        snapshot: {
          primary: { usedPercent: 99, windowDurationMins: null },
          secondary: { usedPercent: 99, windowDurationMins: 1_440 },
        },
      }),
    ).toMatchObject({
      hasFiveHourLimit: null,
      decision: "insufficientEvidence",
    });
    expect(
      decideBankedReset({
        snapshot: { primary: { usedPercent: 75, windowDurationMins: 300 }, secondary: null },
      }),
    ).toMatchObject({
      hasFiveHourLimit: true,
      decision: "insufficientEvidence",
    });
    expect(
      decideBankedReset({
        snapshot: { primary: { usedPercent: 75, windowDurationMins: 300 }, secondary: null },
        permission: "refused",
      }),
    ).toMatchObject({ decision: "insufficientEvidence" });
  });

  test("reads current usage through holycodex-agent without consuming a credit", async () => {
    const codexHome = await createCodexHome("holycodex-auto-reset-enabled-");
    await installAutoResetSelection(codexHome);
    let stdout = "";
    let stderr = "";
    let reads = 0;
    let consumes = 0;
    const accountClient: AutoResetAccountClient = {
      readAccountRateLimits: async () => {
        reads += 1;
        return accountRateLimits(weeklyOnly(8).snapshot, 1);
      },
      consumeAccountRateLimitResetCredit: async () => {
        consumes += 1;
        return { outcome: "reset" };
      },
      close: async () => undefined,
    };
    const code = await runAgentBinary(["auto-reset", "read"], {
      cwd: process.cwd(),
      codexHome,
      writeStdout: (text) => (stdout += text),
      writeStderr: (text) => (stderr += text),
      autoResetAccountClient: accountClient,
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      operation: "auto-reset.read",
      data: {
        hasFiveHourLimit: false,
        weeklyRemainingPercent: 8,
        decision: "requestPermission",
        availableCreditCount: 1,
        hasSelectableCodexCredit: true,
      },
    });
    expect(reads).toBe(1);
    expect(consumes).toBe(0);
  });

  test("consume reads fresh limits, gates by permission and credit evidence, and reports every RPC outcome", async () => {
    const codexHome = await createCodexHome("holycodex-auto-reset-enabled-");
    await installAutoResetSelection(codexHome);
    const consumed: Array<{ idempotencyKey: string; creditId: string }> = [];
    let snapshot = weeklyOnly(8).snapshot;
    let availableCount = 1;
    let creditStatus: "available" | "redeemed" = "available";
    let outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" = "reset";
    let reads = 0;
    const accountClient: AutoResetAccountClient = {
      readAccountRateLimits: async () => {
        reads += 1;
        return accountRateLimits(snapshot, availableCount, creditStatus);
      },
      consumeAccountRateLimitResetCredit: async (input) => {
        consumed.push(input);
        return { outcome };
      },
      close: async () => undefined,
    };
    const run = async (argv: readonly string[]) => {
      let stdout = "";
      let stderr = "";
      const exitCode = await runAgentBinary([...argv], {
        cwd: process.cwd(),
        codexHome,
        writeStdout: (text) => (stdout += text),
        writeStderr: (text) => (stderr += text),
        autoResetAccountClient: accountClient,
      });
      return { exitCode, stdout, stderr };
    };

    const askFirst = await run(["auto-reset", "consume", "--idempotency-key", "ask-attempt"]);
    expect(JSON.parse(askFirst.stdout)).toMatchObject({
      data: { decision: "requestPermission", outcome: "notConsumed" },
    });
    expect(consumed).toHaveLength(0);

    const grant = await run([
      "auto-reset",
      "consume",
      "--authorization",
      "granted",
      "--idempotency-key",
      "granted-attempt",
    ]);
    expect(JSON.parse(grant.stdout)).toMatchObject({
      data: { decision: "resetAuthorized", outcome: "reset" },
    });
    expect(consumed.at(-1)).toEqual({
      idempotencyKey: "granted-attempt",
      creditId: "credit-1",
    });

    snapshot = weeklyOnly(4).snapshot;
    for (const nextOutcome of ["nothingToReset", "noCredit", "alreadyRedeemed"] as const) {
      outcome = nextOutcome;
      const result = await run([
        "auto-reset",
        "consume",
        "--authorization",
        "refused",
        "--idempotency-key",
        `lower-${nextOutcome}`,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        data: { decision: "resetAuthorized", outcome: nextOutcome },
      });
    }

    availableCount = 0;
    const noCredit = await run([
      "auto-reset",
      "consume",
      "--idempotency-key",
      "no-available-credit",
    ]);
    expect(JSON.parse(noCredit.stdout)).toMatchObject({
      data: {
        decision: "resetAuthorized",
        outcome: "notConsumed",
        hasSelectableCodexCredit: false,
      },
    });
    expect(consumed).toHaveLength(4);

    availableCount = 1;
    creditStatus = "redeemed";
    const unknownCredit = await run([
      "auto-reset",
      "consume",
      "--idempotency-key",
      "unavailable-credit",
    ]);
    expect(JSON.parse(unknownCredit.stdout)).toMatchObject({
      data: { outcome: "notConsumed", hasSelectableCodexCredit: false },
    });
    expect(consumed).toHaveLength(4);
    expect(reads).toBe(7);
    expect(unknownCredit.exitCode).toBe(0);
    expect(unknownCredit.stderr).toBe("");
  });

  test("does not consume on missing weekly evidence in the fresh account read", async () => {
    const codexHome = await createCodexHome("holycodex-auto-reset-enabled-");
    await installAutoResetSelection(codexHome);
    let consumes = 0;
    const accountClient: AutoResetAccountClient = {
      readAccountRateLimits: async () =>
        accountRateLimits(
          { primary: { usedPercent: 75, windowDurationMins: 300 }, secondary: null },
          1,
        ),
      consumeAccountRateLimitResetCredit: async () => {
        consumes += 1;
        return { outcome: "reset" };
      },
      close: async () => undefined,
    };
    let stdout = "";
    const exitCode = await runAgentBinary(
      ["auto-reset", "consume", "--idempotency-key", "missing-weekly"],
      {
        cwd: process.cwd(),
        codexHome,
        writeStdout: (text) => (stdout += text),
        writeStderr: () => undefined,
        autoResetAccountClient: accountClient,
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      data: { decision: "insufficientEvidence", outcome: "notConsumed" },
    });
    expect(consumes).toBe(0);
  });

  test("requires persisted opt-in for account reads and reset consumption", async () => {
    let reads = 0;
    let consumes = 0;
    const accountClient: AutoResetAccountClient = {
      readAccountRateLimits: async () => {
        reads += 1;
        return accountRateLimits(weeklyOnly(4).snapshot, 1);
      },
      consumeAccountRateLimitResetCredit: async () => {
        consumes += 1;
        return { outcome: "reset" };
      },
      close: async () => undefined,
    };
    for (const selected of [false, null]) {
      const codexHome = await createCodexHome("holycodex-auto-reset-disabled-");
      await installAutoResetSelection(codexHome, selected);
      const run = async (argv: readonly string[]) => {
        let stderr = "";
        const exitCode = await runAgentBinary([...argv], {
          cwd: process.cwd(),
          codexHome,
          writeStdout: () => undefined,
          writeStderr: (text) => (stderr += text),
          autoResetAccountClient: accountClient,
        });
        return { exitCode, stderr };
      };

      for (const argv of [
        ["auto-reset", "read"],
        ["auto-reset", "consume", "--authorization", "granted", "--idempotency-key", "explicit"],
      ]) {
        const result = await run(argv);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("capability_disabled");
      }
    }
    expect(reads).toBe(0);
    expect(consumes).toBe(0);

    const evaluateCodexHome = await createCodexHome("holycodex-auto-reset-evaluate-");
    let evaluateStdout = "";
    const evaluateExitCode = await runAgentBinary(
      ["auto-reset", "evaluate", "--input", JSON.stringify(weeklyOnly(4))],
      {
        codexHome: evaluateCodexHome,
        writeStdout: (text) => (evaluateStdout += text),
        writeStderr: () => undefined,
      },
    );
    expect(evaluateExitCode).toBe(0);
    expect(JSON.parse(evaluateStdout).data.decision).toBe("resetAuthorized");
    expect(reads).toBe(0);
  });
});

function accountRateLimits(
  snapshot: {
    readonly primary: {
      readonly usedPercent: number;
      readonly windowDurationMins: number | null;
    } | null;
    readonly secondary: {
      readonly usedPercent: number;
      readonly windowDurationMins: number | null;
    } | null;
  },
  availableCount: number,
  creditStatus: "available" | "redeemed" = "available",
) {
  return Schema.decodeUnknownSync(AccountRateLimitsReadResultSchema)({
    rateLimits: {
      ...snapshot,
      primary: snapshot.primary === null ? null : { ...snapshot.primary, resetsAt: null },
      secondary: snapshot.secondary === null ? null : { ...snapshot.secondary, resetsAt: null },
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: {
      availableCount,
      credits: [
        {
          id: "credit-1",
          resetType: "codexRateLimits",
          status: creditStatus,
          grantedAt: 1_799_000_000,
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    },
  });
}
