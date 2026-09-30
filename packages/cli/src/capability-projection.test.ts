// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";

import {
  projectNativeAgents,
  renderNativeAgent,
  rootDeveloperInstructions,
} from "./native-agents.ts";

test("projects only selected visual providers into Root and both visual specialists", () => {
  for (const browserUse of [false, true]) {
    for (const computerUse of [false, true]) {
      const options = { browserUse, computerUse };
      const projections = [
        rootDeveloperInstructions(options),
        ...projectNativeAgents("default")
          .filter((agent) => agent.name === "Worker.visual" || agent.name === "Reviewer.visual")
          .map((agent) => renderNativeAgent(agent, options)),
      ];
      expect(projections).toHaveLength(3);
      for (const projection of projections) {
        expect(projection.includes("Browser Use / ")).toBe(browserUse);
        expect(projection.includes("Computer Use")).toBe(computerUse);
        expect(projection).not.toContain("if Browser Use is installed");
        if (browserUse) {
          expect(projection).toContain(
            "open and inspect the standalone temporary HTML with Browser Use / IAB",
          );
          expect(
            projection.includes(
              "Use Computer Use for HTML interactions Browser Use cannot perform.",
            ),
          ).toBe(computerUse);
        } else if (computerUse) {
          expect(projection).toContain(
            "open and inspect the standalone temporary HTML with Computer Use",
          );
        } else {
          expect(projection).toContain("give the standalone temporary HTML file to the user");
        }
      }
    }
  }
});
