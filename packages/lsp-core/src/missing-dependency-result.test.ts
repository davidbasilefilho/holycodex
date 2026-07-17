import { describe, expect, test } from "vitest";

import { missingDependencyResultOrThrow } from "./missing-dependency-result.js";

describe("missingDependencyResultOrThrow", () => {
  test("returns the shared tool error for a missing dependency", () => {
    const result = missingDependencyResultOrThrow(
      new Error("No LSP server configured for extension: .md"),
      { filePath: "README.md" },
    );

    expect(result.details).toEqual({
      filePath: "README.md",
      error: "No LSP server configured for extension: .md",
      errorKind: "missing_dependency",
    });
  });

  test("rethrows unrelated errors unchanged", () => {
    const error = new Error("request failed");
    expect(() => missingDependencyResultOrThrow(error, {})).toThrow(error);
  });
});
