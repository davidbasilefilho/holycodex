// SPDX-License-Identifier: Apache-2.0

import type { AccountRateLimitsReadResult } from "@holycodex/codex";
import * as Schema from "effect/Schema";

const UsageWindowSchema = Schema.Struct({
  usedPercent: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(100),
  ),
  windowDurationMins: Schema.Union([
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
    Schema.Null,
  ]),
});
const LimitSnapshotSchema = Schema.Struct({
  primary: Schema.Union([UsageWindowSchema, Schema.Null]),
  secondary: Schema.Union([UsageWindowSchema, Schema.Null]),
});

/** Authoritative current rate-limit windows and permission state for one reset decision. */
export const AutoResetDecisionInputSchema = Schema.Struct({
  snapshot: LimitSnapshotSchema,
  permission: Schema.optional(Schema.Literals(["notRequested", "granted", "refused"])),
});
/** Typed input consumed by the deterministic banked reset decision adapter. */
export type AutoResetDecisionInput = typeof AutoResetDecisionInputSchema.Type;

/** Result of evaluating the banked reset thresholds against current usage evidence. */
export interface AutoResetDecision {
  /** Whether a five-hour quota window is present in the current snapshot. */
  readonly hasFiveHourLimit: boolean | null;
  /** Current weekly remaining percentage, or null when unavailable. */
  readonly weeklyRemainingPercent: number | null;
  /** Current five-hour remaining percentage, or null when the plan has no such limit. */
  readonly fiveHourRemainingPercent: number | null;
  /** Next action determined by the thresholds and current permission state. */
  readonly decision:
    | "insufficientEvidence"
    | "doNotReset"
    | "requestPermission"
    | "resetAuthorized";
  /** Why this action was selected. */
  readonly reason: string;
}

/** Current policy and credit evidence extracted from a fresh local account read. */
export interface AutoResetLiveState {
  /** Threshold decision based on the selected Codex usage snapshot. */
  readonly policy: AutoResetDecision;
  /** Number of reset credits reported in the fresh account response, or null if unavailable. */
  readonly availableCreditCount: number | null;
  /** Id of a currently available Codex reset credit suitable for the consume RPC. */
  readonly eligibleCreditId: string | null;
}

/**
 * Determine whether current quota evidence permits a banked reset or requires user permission. A
 * five-hour limit is detected only from a current 300-minute window; a weekly-only snapshot
 * establishes that the current plan has no five-hour window.
 */
export function decideBankedReset(input: AutoResetDecisionInput): AutoResetDecision {
  const windows = [input.snapshot.primary, input.snapshot.secondary].filter(
    (window) => window !== null,
  );
  const fiveHour = windows.find((window) => window.windowDurationMins === 300);
  const weekly = windows.find((window) => window.windowDurationMins === 10_080);
  const permission = input.permission ?? "notRequested";
  const weeklyRemainingPercent = remaining(weekly?.usedPercent);
  const fiveHourRemainingPercent = remaining(fiveHour?.usedPercent);

  if (fiveHour !== undefined) {
    const fiveHourRemaining = 100 - fiveHour.usedPercent;
    const lowerThreshold =
      fiveHourRemaining < 15 || (weeklyRemainingPercent !== null && weeklyRemainingPercent < 7);
    const askThreshold =
      fiveHourRemaining < 20 || (weeklyRemainingPercent !== null && weeklyRemainingPercent < 15);
    if (lowerThreshold) {
      return result(
        true,
        weeklyRemainingPercent,
        fiveHourRemainingPercent,
        "resetAuthorized",
        "A five-hour or weekly remaining quota is below its no-permission threshold.",
      );
    }
    if (weekly === undefined && !askThreshold) {
      return result(
        true,
        weeklyRemainingPercent,
        fiveHourRemainingPercent,
        "insufficientEvidence",
        "The current snapshot does not contain a weekly usage window needed to rule out its threshold.",
      );
    }
    if (!askThreshold) {
      return result(
        true,
        weeklyRemainingPercent,
        fiveHourRemainingPercent,
        "doNotReset",
        "Neither remaining quota is below its permission threshold.",
      );
    }
    if (permission === "granted") {
      return result(
        true,
        weeklyRemainingPercent,
        fiveHourRemainingPercent,
        "resetAuthorized",
        "Permission was granted at the current permission threshold.",
      );
    }
    return result(
      true,
      weeklyRemainingPercent,
      fiveHourRemainingPercent,
      "requestPermission",
      permission === "refused"
        ? "Permission was refused and neither quota has reached the lower no-permission threshold."
        : "A remaining quota is below its permission threshold.",
    );
  }

  if (weekly === undefined) {
    return result(
      null,
      null,
      null,
      "insufficientEvidence",
      "The current snapshot does not contain a weekly usage window.",
    );
  }

  if (windows.some((window) => window.windowDurationMins !== 10_080)) {
    return result(
      null,
      weeklyRemainingPercent,
      null,
      "insufficientEvidence",
      "A present usage window has an unknown or non-weekly duration, so a weekly-only plan cannot be inferred.",
    );
  }

  if (weeklyRemainingPercent !== null && weeklyRemainingPercent < 5) {
    return result(
      false,
      weeklyRemainingPercent,
      null,
      "resetAuthorized",
      "Weekly remaining quota is below the no-permission threshold.",
    );
  }
  if (weeklyRemainingPercent !== null && weeklyRemainingPercent >= 10) {
    return result(
      false,
      weeklyRemainingPercent,
      null,
      "doNotReset",
      "Weekly remaining quota is not below the permission threshold.",
    );
  }
  if (permission === "granted") {
    return result(
      false,
      weeklyRemainingPercent,
      null,
      "resetAuthorized",
      "Permission was granted at the weekly permission threshold.",
    );
  }
  return result(
    false,
    weeklyRemainingPercent,
    null,
    "requestPermission",
    permission === "refused"
      ? "Permission was refused and weekly remaining quota has not reached the lower no-permission threshold."
      : "Weekly remaining quota is below its permission threshold.",
  );
}

/** Derive reset policy and selectable credit evidence from one fresh account-rate-limits read. */
export function inspectAccountRateLimits(
  account: AccountRateLimitsReadResult,
  permission: "notRequested" | "granted" | "refused" = "notRequested",
): AutoResetLiveState {
  const snapshot = account.rateLimitsByLimitId?.["codex"] ?? account.rateLimits;
  const policy = decideBankedReset({
    snapshot: { primary: snapshot.primary, secondary: snapshot.secondary },
    permission,
  });
  const creditSummary = account.rateLimitResetCredits;
  const eligibleCredit =
    creditSummary !== null && creditSummary.availableCount > 0 && creditSummary.credits !== null
      ? creditSummary.credits.find(
          (credit) => credit.resetType === "codexRateLimits" && credit.status === "available",
        )
      : undefined;
  return {
    policy,
    availableCreditCount: creditSummary?.availableCount ?? null,
    eligibleCreditId: eligibleCredit?.id ?? null,
  };
}

function remaining(usedPercent: number | undefined): number | null {
  return usedPercent === undefined ? null : 100 - usedPercent;
}

function result(
  hasFiveHourLimit: boolean | null,
  weeklyRemainingPercent: number | null,
  fiveHourRemainingPercent: number | null,
  decision: AutoResetDecision["decision"],
  reason: string,
): AutoResetDecision {
  return { hasFiveHourLimit, weeklyRemainingPercent, fiveHourRemainingPercent, decision, reason };
}
