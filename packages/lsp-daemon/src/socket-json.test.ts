// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createLineDecoder, encodeJsonLine } from "./socket-json.ts";

describe("daemon JSON lines", () => {
  it("reassembles fragmented and batched messages", () => {
    const values: unknown[] = [];
    const decoder = createLineDecoder((value) => values.push(value));
    decoder.push('{"id":1,"v":');
    decoder.push('"ok"}\n{"id":2}\n');
    expect(values).toEqual([{ id: 1, v: "ok" }, { id: 2 }]);
  });

  it("reports malformed lines and continues", () => {
    const values: unknown[] = [];
    const errors: string[] = [];
    const decoder = createLineDecoder(
      (value) => values.push(value),
      (raw) => errors.push(raw),
    );
    decoder.push("not-json\n");
    decoder.push(`${encodeJsonLine({ ok: true })}`);
    expect(errors).toEqual(["not-json"]);
    expect(values).toEqual([{ ok: true }]);
  });
});
