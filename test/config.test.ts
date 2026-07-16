import { describe, expect, it } from "vitest";
import { installConfig, removeManaged } from "../src/config";

describe("Codex configuration", () => {
  it("preserves unrelated settings when installing", () => {
    const input = 'model = "user/model"\n[custom]\nvalue = true\n';
    const output = installConfig(input, "default");
    expect(output).toContain('model = "user/model"');
    expect(output).toContain("[custom]\nvalue = true");
    expect(output).toContain("max_concurrent_threads_per_session = 2");
    expect(output).not.toContain('model = "gpt-5.6-terra"');
    expect(output).toContain('approval_policy = "on-request"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
    expect(output).toContain(
      'status_line = ["model-with-reasoning", "context-remaining", "current-dir"]',
    );
  });

  it("is idempotent when installed repeatedly", () => {
    const once = installConfig("", "default");
    expect(installConfig(once, "default")).toBe(once);
  });

  it("removes only its managed block during cleanup", () => {
    const installed = installConfig("[custom]\nvalue = true\n", "default");
    expect(removeManaged(installed)).toBe("[custom]\nvalue = true");
  });

  it("removes legacy OMO namespaces", () => {
    const input =
      '[marketplaces.sisyphuslabs]\nsource = "old"\n[agents.metis]\nmodel = "old"\n[hooks.state."omo@sisyphuslabs:old"]\nenabled = true\n[custom]\nvalue = true\n';
    const output = installConfig(input, "default");
    expect(output).not.toContain("sisyphuslabs");
    expect(output).not.toContain("agents.metis");
    expect(output).not.toContain("hooks.state");
  });

  it("preserves an explicit shared agent preference", () => {
    const input = '[agents.explorer]\nmodel = "user/model"\n';
    const output = installConfig(input, "default");
    expect(output.match(/\[agents\.explorer]/g)).toHaveLength(1);
    expect(output).toContain('model = "user/model"');
  });

  it("maps each bundled subagent to its own instruction file", () => {
    const output = installConfig("", "default");
    for (const agent of ["explorer", "librarian", "worker"]) {
      expect(output).toContain(`[agents.${agent}]\nconfig_file = "holycodex/agents/${agent}.toml"`);
    }
    expect(output).not.toContain("developer_instructions");
  });

  it("preserves an explicit model and reasoning effort", () => {
    const input = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n';
    expect(installConfig(input, "default")).toContain('model_reasoning_effort = "high"');
  });

  it("normalizes restricted reasoning in named sections", () => {
    const input =
      '[aliases.fast]\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "minimal"\n' +
      '[agents.deep]\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n';
    const output = installConfig(input, "default");
    expect(output).toContain(
      '[aliases.fast]\nmodel = "gpt-5.6-terra"\nmodel_reasoning_effort = "minimal"',
    );
    expect(output).toContain(
      '[agents.deep]\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"',
    );
  });

  it("does not add an effort to an explicit model", () => {
    expect(installConfig('model = "gpt-5.6-luna"\n', "default")).not.toContain(
      "model_reasoning_effort",
    );
  });

  it("adds the default root model when only a named section chose a model", () => {
    expect(installConfig('[profiles.deep]\nmodel = "custom/model"\n', "default")).toContain(
      'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "medium"',
    );
  });

  it("merges managed feature and network keys without duplicate tables", () => {
    const output = installConfig(
      '[features]\nother = true\n[sandbox_workspace_write]\nwritable_roots = ["x"]\n',
      "autonomous",
    );
    expect(output.match(/\[features]/g)).toHaveLength(1);
    expect(output.match(/\[sandbox_workspace_write]/g)).toHaveLength(1);
    expect(output).toContain("default_mode_request_user_input = true");
    expect(output).toContain("network_access = true");
    expect(output).toContain('approval_policy = "never"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
  });

  it("requires an explicit dangerous mode for full access", () => {
    const output = installConfig("", "dangerous");
    expect(output).toContain('approval_policy = "never"');
    expect(output).toContain('sandbox_mode = "danger-full-access"');
  });

  it("migrates former autonomous full access to containment and restores prior config", () => {
    const input = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n';
    const migrated = installConfig(input, "autonomous");
    expect(migrated).toContain('approval_policy = "never"');
    expect(migrated).toContain('sandbox_mode = "workspace-write"');
    expect(migrated).toContain("network_access = true");
    expect(migrated).not.toContain('sandbox_mode = "danger-full-access"');
    expect(removeManaged(migrated)).toBe(input.trim());
    expect(installConfig(input, "dangerous")).toContain('sandbox_mode = "danger-full-access"');
  });

  it("merges context visibility into unrelated status items and restores cleanup input", () => {
    const input =
      'status_line = ["git-branch", "tokens-used"]\napproval_policy = "untrusted"\n[custom]\nvalue = true\n';
    const installed = installConfig(input, "default");
    expect(installed).toContain('status_line = ["git-branch", "tokens-used", "context-remaining"]');
    expect(installed).toContain('approval_policy = "on-request"');
    expect(removeManaged(installed)).toBe(input.trim());
  });

  it("does not duplicate context visibility from a multiline status list", () => {
    const input = 'status_line = [\n  "model",\n  "context-remaining",\n  "git-branch",\n]\n';
    const output = installConfig(input, "autonomous");
    expect(output.match(/context-remaining/g)).toHaveLength(1);
    expect(removeManaged(output)).toBe(input.trim());
  });
});
