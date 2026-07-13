import { describe, expect, it } from "vitest";
import { installConfig, removeManaged } from "../src/config";

describe("Codex configuration", () => {
  it("preserves unrelated settings when installing", () => {
    const input = 'model = "user/model"\n[custom]\nvalue = true\n';
    const output = installConfig(input, false);
    expect(output).toContain('model = "user/model"');
    expect(output).toContain("[custom]\nvalue = true");
    expect(output).toContain("max_concurrent_threads_per_session = 2");
    expect(output).not.toContain('model = "gpt-5.6-sol"');
  });

  it("is idempotent when installed repeatedly", () => {
    const once = installConfig("", false);
    expect(installConfig(once, false)).toBe(once);
  });

  it("removes only its managed block during cleanup", () => {
    const installed = installConfig("[custom]\nvalue = true\n", false);
    expect(removeManaged(installed)).toBe("[custom]\nvalue = true");
  });

  it("removes legacy OMO namespaces", () => {
    const input =
      '[marketplaces.sisyphuslabs]\nsource = "old"\n[agents.metis]\nmodel = "old"\n[custom]\nvalue = true\n';
    const output = installConfig(input, false);
    expect(output).not.toContain("sisyphuslabs");
    expect(output).not.toContain("agents.metis");
  });

  it("preserves an explicit shared agent preference", () => {
    const input = '[agents.explorer]\nmodel = "user/model"\n';
    const output = installConfig(input, false);
    expect(output.match(/\[agents\.explorer]/g)).toHaveLength(1);
    expect(output).toContain('model = "user/model"');
  });

  it("rewrites forbidden Sol reasoning", () => {
    const input = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n';
    expect(installConfig(input, false)).toContain('model_reasoning_effort = "medium"');
  });

  it("normalizes restricted reasoning in named sections", () => {
    const input =
      '[aliases.fast]\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "minimal"\n' +
      '[agents.deep]\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n';
    const output = installConfig(input, false);
    expect(output).toContain(
      '[aliases.fast]\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"',
    );
    expect(output).toContain(
      '[agents.deep]\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"',
    );
  });

  it("adds a safe effort when a preserved restricted model omitted one", () => {
    expect(installConfig('model = "gpt-5.6-luna"\n', false)).toContain(
      'model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"',
    );
  });

  it("adds the default root model when only a named section chose a model", () => {
    expect(installConfig('[profiles.deep]\nmodel = "custom/model"\n', false)).toContain(
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"',
    );
  });
});
