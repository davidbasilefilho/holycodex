// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import { describe, expect, test } from "vite-plus/test";
import {
  APPROVAL_POLICY,
  APPROVAL_POLICY_GUIDANCE,
  ApprovalPolicySchema,
  approvalModeFor,
  lookupApprovalPolicy,
} from "./index";
import { decodeUnknown } from "./schema";

describe("core approval policy", () => {
  test("keeps one immutable decision for each assigned action", () => {
    expect(Object.isFrozen(APPROVAL_POLICY)).toBe(true);
    for (const entry of Object.values(APPROVAL_POLICY)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.values(APPROVAL_POLICY).map((entry) => entry.identifier)).toEqual([
      "workflow.create",
      "workflow.run",
      "workflow.resume",
      "local.repository.edit",
      "local.repository.check",
      "local.repository.lint",
      "local.repository.format",
      "local.repository.commit",
      "external.read",
      "specialist.dispatch",
      "vcs.server.mutation",
      "vcs.server.ci-trigger",
      "unknown.effect",
    ]);
    expect(Object.values(APPROVAL_POLICY).map((entry) => entry.requiresRootApproval)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(Reflect.set(APPROVAL_POLICY.workflowRun, "requiresRootApproval", true)).toBe(false);
  });

  test("maps workflow mechanics and Root gates without conflating other effects", () => {
    expect(approvalModeFor("workflow.create")).toBe("never");
    expect(approvalModeFor("workflow.run")).toBe("never");
    expect(approvalModeFor("workflow.resume")).toBe("never");
    expect(approvalModeFor("local.repository.edit")).toBe("never");
    expect(approvalModeFor("local.repository.check")).toBe("never");
    expect(approvalModeFor("local.repository.lint")).toBe("never");
    expect(approvalModeFor("local.repository.format")).toBe("never");
    expect(approvalModeFor("local.repository.commit")).toBe("never");
    expect(approvalModeFor("external.read")).toBe("never");
    expect(approvalModeFor("specialist.dispatch")).toBe("never");
    expect(approvalModeFor("vcs.server.mutation")).toBe("root");
    expect(approvalModeFor("vcs.server.ci-trigger")).toBe("root");
    expect(approvalModeFor("unknown.effect")).toBe("root");
    expect(lookupApprovalPolicy("vcs.server.mutation").label).toBe(
      "version-control-server mutation",
    );
    expect(APPROVAL_POLICY_GUIDANCE.noRootApproval).toContain("do not require Root approval");
    expect(APPROVAL_POLICY_GUIDANCE.rootApproval).toContain("require Root approval");
  });

  test("validates the exported policy through Effect Schema", () => {
    expect(Either.isRight(decodeUnknown(ApprovalPolicySchema, APPROVAL_POLICY))).toBe(true);
    expect(
      Either.isLeft(
        decodeUnknown(ApprovalPolicySchema, {
          ...APPROVAL_POLICY,
          workflowRun: { ...APPROVAL_POLICY.workflowRun, identifier: "vcs.server.mutation" },
        }),
      ),
    ).toBe(true);
  });
});
