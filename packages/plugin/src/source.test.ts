// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";

import { assertSafePath } from "./source.ts";

describe("plugin source path classification", () => {
  test("allows the session-audit skill slug while rejecting session data paths", () => {
    expect(() => assertSafePath("skills/session-audit/SKILL.md")).not.toThrow();
    expect(() => assertSafePath("skills/session-audit/agents/openai.yaml")).not.toThrow();

    expect(() => assertSafePath("skills/session/session.json")).toThrow(/secret-like/iu);
    expect(() => assertSafePath("skills/session-audit/session.json")).toThrow(/secret-like/iu);
    expect(() => assertSafePath("skills/sample/api-key.txt")).toThrow(/secret-like/iu);
    expect(() => assertSafePath("skills/sample/private.pem")).toThrow(/secret-like/iu);
  });
});
