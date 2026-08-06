import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MODEL_ROUTING_PLANS,
  PLAN_NAMES,
  type FastMode,
  type PlanName,
} from "../packages/cli/src/catalog";
import {
  installConfig as installPlatformConfig,
  removeManaged,
  type AutonomyMode,
  type RequestedAutonomy,
} from "../packages/cli/src/config";

const installConfig = (
  input: string,
  mode: AutonomyMode | RequestedAutonomy | undefined,
  fast: FastMode = "standard",
): string => installPlatformConfig(input, mode, "win32", undefined, undefined, fast);
const installPlanConfig = (input: string, plan: PlanName): string =>
  installPlatformConfig(input, "default", "win32", plan);

describe("Codex configuration", () => {
  it("preserves unrelated settings when installing", () => {
    const input = 'model = "user/model"\n[custom]\nvalue = true\n';
    const output = installConfig(input, "default");
    expect(output).toContain('model = "user/model"');
    expect(output).toContain("[custom]\nvalue = true");
    expect(output).toContain("[agents]");
    expect(output).toContain("max_concurrent_threads_per_session = 4");
    expect(output).not.toContain("max_depth = 1");
    expect(output).not.toContain('model = "gpt-5.6-sol"');
    expect(output).toContain('approval_policy = "on-request"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
    expect(output).not.toContain("[marketplaces.holycodex]");
    expect(output).toContain('[plugins."holycodex@holycodex"]\nenabled = true');
    expect(output).toContain(
      'status_line = ["model-with-reasoning", "context-remaining", "current-dir"]',
    );
  });

  it("is idempotent when installed repeatedly", () => {
    const once = installConfig("", "default");
    expect(installConfig(once, "default")).toBe(once);
  });

  it("defaults to plus and applies every root plan", () => {
    expect(installPlatformConfig("", "default", "win32")).toBe(
      installPlatformConfig("", "default", "win32", "plus"),
    );
    for (const plan of PLAN_NAMES) {
      const output = installPlanConfig("", plan);
      const route = MODEL_ROUTING_PLANS[plan].root;
      expect(output).toContain(`# holycodex plan: ${plan}`);
      expect(output).toContain(`model = "${route.model}"`);
      expect(output).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
      expect(output).toContain(
        `max_concurrent_threads_per_session = ${MODEL_ROUTING_PLANS[plan].workflow.limits.concurrency + 1}`,
      );
      expect(output).toContain("workflow-policy");
    }
  });

  it("updates managed root routing when the selected plan changes", () => {
    const original = "[custom]\nvalue = true\n";
    const plus = installPlanConfig(original, "plus");
    const pro = installPlanConfig(plus, "pro-20x");
    const route = MODEL_ROUTING_PLANS["pro-20x"].root;
    expect(pro).toContain("# holycodex plan: pro-20x");
    expect(pro).toContain(`model = "${route.model}"`);
    expect(pro).toContain(`model_reasoning_effort = "${route.reasoningEffort}"`);
    expect(removeManaged(pro)).toBe(original.trim());
  });

  it("maps explicit direct-subagent overrides to root-inclusive threads", () => {
    const overridden = installPlatformConfig("", "default", "win32", "plus", 1);
    expect(overridden).not.toContain("# holycodex max-subagents:");
    expect(overridden).toContain("max_concurrent_threads_per_session = 2");

    const reset = installPlatformConfig(overridden, "default", "win32", "plus");
    expect(reset).not.toContain("# holycodex max-subagents:");
    expect(reset).toContain(
      `max_concurrent_threads_per_session = ${MODEL_ROUTING_PLANS.plus.workflow.limits.concurrency + 1}`,
    );
    expect(removeManaged(reset)).toBe("");
  });

  it("migrates the former pro-20x Sol xhigh root route", () => {
    const oldPro = installPlanConfig("", "pro-20x").replace(
      'model_reasoning_effort = "high"',
      'model_reasoning_effort = "xhigh"',
    );
    const upgraded = installPlanConfig(oldPro, "pro-20x");
    expect(upgraded).toContain('model_reasoning_effort = "high"');
    expect(upgraded).not.toContain('model_reasoning_effort = "xhigh"');
  });

  it("migrates the outgoing pro-5x Sol medium root route", () => {
    const oldPro = installPlanConfig("", "pro-5x").replace(
      'model_reasoning_effort = "high"',
      'model_reasoning_effort = "medium"',
    );
    const upgraded = installPlanConfig(oldPro, "pro-5x");
    expect(upgraded).toContain('model = "gpt-5.6-sol"');
    expect(upgraded).toContain('model_reasoning_effort = "high"');
    expect(upgraded).not.toContain('model_reasoning_effort = "medium"');
  });

  it("migrates the former go Terra medium root route", () => {
    const oldGo = installPlanConfig("", "go")
      .replace('model = "gpt-5.6-luna"', 'model = "gpt-5.6-terra"')
      .replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "medium"');
    const upgraded = installPlanConfig(oldGo, "go");
    expect(upgraded).toContain('model = "gpt-5.6-luna"');
    expect(upgraded).toContain('model_reasoning_effort = "high"');
    expect(upgraded).not.toContain('model = "gpt-5.6-terra"');
  });

  it("preserves an unrelated explicit root route across reinstall", () => {
    const installed = installPlanConfig(
      'model = "user/root"\nmodel_reasoning_effort = "xhigh"\n',
      "plus",
    );
    const reinstalled = installPlanConfig(installed, "plus");
    expect(reinstalled).toContain('model = "user/root"');
    expect(reinstalled).toContain('model_reasoning_effort = "xhigh"');
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
    expect(output).toContain('config_file = "holycodex/agents/explorer.toml"');
    expect(removeManaged(output)).toBe(input.trim());
  });

  it("maps each bundled subagent to its own instruction file", () => {
    const output = installConfig("", "default");
    for (const agent of ["explorer", "librarian", "worker"]) {
      expect(output).toContain(`[agents.${agent}]`);
      expect(output).toContain(`config_file = "holycodex/agents/${agent}.toml"`);
    }
    expect(output).not.toContain("developer_instructions");
  });

  it("ships supported agent configs with low verbosity", () => {
    for (const agent of ["explorer", "librarian", "worker"]) {
      const source = readFileSync(`packages/plugin/plugin/agents/${agent}.toml`, "utf8");
      expect(source).toContain('model_verbosity = "low"');
    }
  });

  it("keeps capability-specific guidance in each specialist profile", () => {
    const explorer = readFileSync("packages/plugin/plugin/agents/explorer.toml", "utf8");
    const librarian = readFileSync("packages/plugin/plugin/agents/librarian.toml", "utf8");
    const worker = readFileSync("packages/plugin/plugin/agents/worker.toml", "utf8");
    expect(explorer).toContain("Prefer `rg` and `rg --files`");
    expect(explorer).toContain("fall back to `grep` and `find`");
    expect(librarian).toContain("smallest sufficient set of current authoritative primary sources");
    expect(librarian).toContain("Attach each source to a decision-relevant claim");
    expect(worker).toContain("repository-native, merge-ready work");
    expect(worker).toContain("Node.js and Bun portability");
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

  it("completes the default pair around an explicit model", () => {
    const output = installConfig('model = "gpt-5.6-luna"\n', "default");
    expect(output).toContain('model = "gpt-5.6-luna"');
    expect(output).toContain('model_reasoning_effort = "medium"');
  });

  it("adds the default root model when only a named section chose a model", () => {
    expect(installConfig('[profiles.deep]\nmodel = "custom/model"\n', "default")).toContain(
      'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"',
    );
  });

  it("completes the default pair around an explicit effort without duplication", () => {
    const output = installConfig('model_reasoning_effort = "high"\n', "default");
    expect(output).toContain('model = "gpt-5.6-sol"');
    expect(output.match(/^model_reasoning_effort\s*=/gm)).toHaveLength(1);
    expect(output).toContain('model_reasoning_effort = "high"');
  });

  it("adds the complete Sol medium pair when both root values are absent", () => {
    const output = installConfig("", "default");
    expect(output.match(/^model\s*=/gm)).toHaveLength(1);
    expect(output.match(/^model_reasoning_effort\s*=/gm)).toHaveLength(1);
    expect(output).toContain('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"');
  });

  it("adds low model verbosity at the root before named sections", () => {
    const output = installConfig('[profiles.deep]\nmodel = "custom/model"\n', "default");
    expect(output.match(/^model_verbosity\s*=/gm)).toHaveLength(1);
    expect(output).toContain('model_verbosity = "low"');
    expect(output.indexOf('model_verbosity = "low"')).toBeLessThan(
      output.indexOf("[profiles.deep]"),
    );
  });

  it("enforces low root model verbosity and restores the original value during cleanup", () => {
    const output = installConfig('model_verbosity = "high"\n', "default");
    expect(output.match(/^model_verbosity\s*=/gm)).toHaveLength(1);
    expect(output).toContain('model_verbosity = "low"');
    expect(removeManaged(output)).toBe('model_verbosity = "high"');
  });

  it("reinstalls low root model verbosity after a managed edit and preserves the original cleanup value", () => {
    const installed = installConfig("", "default")
      .replace('model = "gpt-5.6-sol"', 'model = "user/model"')
      .replace('model_reasoning_effort = "medium"', 'model_reasoning_effort = "high"')
      .replace('model_verbosity = "low"', 'model_verbosity = "high"');
    const reinstalled = installConfig(installed, "default");
    expect(reinstalled.match(/^model\s*=/gm)).toHaveLength(1);
    expect(reinstalled.match(/^model_reasoning_effort\s*=/gm)).toHaveLength(1);
    expect(reinstalled.match(/^model_verbosity\s*=/gm)).toHaveLength(1);
    expect(reinstalled).toContain('model = "user/model"');
    expect(reinstalled).toContain('model_reasoning_effort = "high"');
    expect(reinstalled).toContain('model_verbosity = "low"');
    expect(removeManaged(reinstalled)).toBe(
      'model = "user/model"\nmodel_reasoning_effort = "high"',
    );
    expect(installConfig(reinstalled, "default")).toBe(reinstalled);
  });

  it("preserves both explicit root values exactly once", () => {
    const output = installConfig(
      'model = "user/model"\nmodel_reasoning_effort = "xhigh"\n',
      "default",
    );
    expect(output.match(/^model\s*=/gm)).toHaveLength(1);
    expect(output.match(/^model_reasoning_effort\s*=/gm)).toHaveLength(1);
    expect(removeManaged(output)).toBe('model = "user/model"\nmodel_reasoning_effort = "xhigh"');
  });

  it("does not treat named-section effort as a root value", () => {
    const output = installConfig('[agents.custom]\nmodel_reasoning_effort = "low"\n', "default");
    expect(output).toContain('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"');
    expect(output).toContain('[agents.custom]\nmodel_reasoning_effort = "low"');
  });

  it("merges managed feature and network keys without duplicate tables", () => {
    const output = installConfig(
      '[features]\nother = true\n[sandbox_workspace_write]\nwritable_roots = ["x"]\n',
      "autonomous",
    );
    expect(output.match(/\[features]/g)).toHaveLength(1);
    expect(output.match(/\[sandbox_workspace_write]/g)).toHaveLength(1);
    expect(output).toContain("default_mode_request_user_input = true");
    expect(output).toContain("multi_agent = true");
    expect(output).not.toContain("multi_agent_v2 = true");
    expect(output).toContain("network_access = true");
    expect(output).toContain('approval_policy = "never"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
  });

  it("recognizes inline comments on managed table headers", () => {
    const input = "[features] # local settings\nother = true\n";
    const output = installConfig(input, "default");
    expect(output.match(/^\[features](?:\s+#.*)?$/gm)).toHaveLength(1);
    expect(output).toContain("[features] # local settings");
    expect(output).toContain("other = true");
    expect(removeManaged(output)).toBe(input.trim());
  });

  it("restores explicit managed table values during cleanup", () => {
    const input =
      "[features]\ndefault_mode_request_user_input = false\nmulti_agent = false\nmulti_agent_v2 = false\n" +
      "[agents]\nmax_threads = 9\nmax_depth = 3\n" +
      "[sandbox_workspace_write]\nnetwork_access = false\n";
    const installed = installConfig(input, "default");
    expect(installed).toContain("default_mode_request_user_input = true");
    expect(installed).toContain("multi_agent = true");
    expect(installed).toContain("multi_agent_v2 = false");
    expect(installed).toContain("max_concurrent_threads_per_session = 4");
    expect(installed).not.toContain("max_depth = 1");
    expect(installed).toContain("network_access = true");
    expect(removeManaged(installed)).toBe(input.trim());
  });

  it("requires an explicit dangerous mode for full access", () => {
    const output = installConfig("", "dangerous");
    expect(output).toContain('approval_policy = "never"');
    expect(output).toContain('sandbox_mode = "danger-full-access"');
    expect(output).not.toContain("approvals_reviewer");
  });

  it("uses automatic approval review only for the safe default mode", () => {
    const safe = installConfig("", "default");
    expect(safe).toContain('approval_policy = "on-request"');
    expect(safe).toContain('approvals_reviewer = "auto_review"');
    expect(safe).toContain('sandbox_mode = "workspace-write"');

    const autonomous = installConfig("", "autonomous");
    expect(autonomous).toContain('approval_policy = "never"');
    expect(autonomous).not.toContain("approvals_reviewer");
    expect(autonomous).toContain('sandbox_mode = "workspace-write"');
  });

  it("seeds safe permissions only for a fresh omitted request", () => {
    const output = installPlatformConfig("", undefined, "win32");
    expect(output).toContain('approval_policy = "on-request"');
    expect(output).toContain('approvals_reviewer = "auto_review"');
    expect(output).toContain('sandbox_mode = "workspace-write"');
    expect(output).not.toContain("default_permissions");
    expect(output).toContain("# holycodex autonomy: default");
    expect(removeManaged(output)).toBe("");
  });

  it("preserves the live omitted permission tuple across reinstall", () => {
    const autonomous = installPlatformConfig("", "autonomous", "win32");
    const preserved = installPlatformConfig(autonomous, undefined, "win32");
    expect(preserved).toContain('approval_policy = "never"');
    expect(preserved).toContain('sandbox_mode = "workspace-write"');
    expect(preserved).not.toContain('approvals_reviewer = "auto_review"');
    expect(preserved).toContain("# holycodex autonomy: autonomous");
    expect(installPlatformConfig(preserved, undefined, "win32")).toBe(preserved);
  });

  it.each([
    [
      "default",
      'approval_policy = "on-request"',
      'approvals_reviewer = "auto_review"',
      'sandbox_mode = "workspace-write"',
    ],
    ["autonomous", 'approval_policy = "never"', undefined, 'sandbox_mode = "workspace-write"'],
    ["dangerous", 'approval_policy = "never"', undefined, 'sandbox_mode = "danger-full-access"'],
  ] as const)("applies the exact explicit %s tuple", (mode, approval, reviewer, sandbox) => {
    const output = installPlatformConfig('default_permissions = "profile"\n', mode, "win32");
    expect(output).toContain(approval);
    expect(output).toContain(sandbox);
    if (reviewer === undefined) expect(output).not.toContain("approvals_reviewer");
    else expect(output).toContain(reviewer);
    expect(output).not.toMatch(/^default_permissions\s*=/m);
    expect(removeManaged(output)).toBe('default_permissions = "profile"');
  });

  it("keeps a user-modified generated selection during cleanup", () => {
    const installed = installPlatformConfig("", "autonomous", "win32");
    const modified = installed.replace(
      'sandbox_mode = "workspace-write"',
      'sandbox_mode = "danger-full-access"',
    );
    expect(removeManaged(modified)).toContain('sandbox_mode = "danger-full-access"');
    expect(removeManaged(modified)).not.toContain("# holycodex autonomy:");
  });

  it.each(["default", "autonomous"] as const)(
    "retains prior %s metadata when a user selects another exact tuple",
    (mode) => {
      const installed = installPlatformConfig("", mode, "win32");
      const modified = installed
        .replace('approval_policy = "on-request"', 'approval_policy = "never"')
        .replace('approvals_reviewer = "auto_review"\n', "")
        .replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-full-access"');
      const reinstalled = installPlatformConfig(modified, undefined, "win32");
      expect(reinstalled).toContain(`# holycodex autonomy: ${mode}`);
      expect(reinstalled).toContain('sandbox_mode = "danger-full-access"');
      expect(removeManaged(reinstalled)).toContain('sandbox_mode = "danger-full-access"');
      expect(removeManaged(reinstalled)).not.toContain("# holycodex autonomy:");
    },
  );

  it("migrates the historical safe tuple without an approvals reviewer", () => {
    const legacy =
      '# >>> holycodex managed >>>\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n# <<< holycodex managed <<<\n';
    const migrated = installPlatformConfig(legacy, undefined, "win32");
    expect(migrated).toContain("# holycodex autonomy: default");
    expect(migrated).toContain('approval_policy = "on-request"');
    expect(migrated).toContain('sandbox_mode = "workspace-write"');
    expect(migrated).not.toContain('approvals_reviewer = "auto_review"');
    expect(removeManaged(migrated)).toBe("");
  });

  it("restores true original permissions after explicit mode switches", () => {
    const original =
      'default_permissions = "profile"\napproval_policy = "custom"\nsandbox_mode = "workspace-write"\n';
    const autonomous = installPlatformConfig(original, "autonomous", "win32");
    const omitted = installPlatformConfig(autonomous, undefined, "win32");
    const dangerous = installPlatformConfig(omitted, "dangerous", "win32");
    expect(removeManaged(dangerous)).toBe(original.trim());
    expect(installPlatformConfig(dangerous, "dangerous", "win32")).toBe(dangerous);
  });

  it("restores an explicit approvals reviewer exactly during cleanup", () => {
    const input = 'approvals_reviewer = "user-reviewer"\n';
    const installed = installConfig(input, "default");
    expect(installed).toContain('approvals_reviewer = "auto_review"');
    expect(removeManaged(installed)).toBe(input.trim());
  });

  it("owns the requested service tier and restores the pre-install value", () => {
    const input = 'service_tier = "default"\n';
    const fastAll = installConfig(input, "default", "fast-all");
    expect(fastAll).toContain("# holycodex fast: fast-all");
    expect(fastAll).toContain('service_tier = "fast"');
    expect(fastAll.match(/^service_tier\s*=/gm)).toHaveLength(1);
    expect(removeManaged(fastAll)).toBe(input.trim());

    const agentsFast = installConfig(fastAll, "default", "fast");
    expect(agentsFast).toContain("# holycodex fast: fast");
    expect(agentsFast).toContain('service_tier = "default"');
    expect(removeManaged(agentsFast)).toBe(input.trim());

    const standard = installConfig(agentsFast, "default");
    expect(standard).toContain("# holycodex fast: standard");
    expect(standard).toContain('service_tier = "default"');
    expect(standard.match(/^service_tier\s*=/gm)).toHaveLength(1);
    expect(removeManaged(standard)).toBe(input.trim());
  });

  it("installs desktop and Windows settings in merged managed tables", () => {
    const input = '[desktop]\nshow-context-window-usage = false\n[windows]\nsandbox = "elevated"\n';
    const output = installConfig(input, "default");
    expect(output.match(/^\[desktop]/gm)).toHaveLength(1);
    expect(output).not.toContain("enabled-reasoning-efforts");
    expect(output).toContain("show-context-window-usage = true");
    expect(output.match(/^\[windows]/gm)).toHaveLength(1);
    expect(output).toContain('sandbox = "unelevated"');
    expect(removeManaged(output)).toBe(input.trim());
    expect(installConfig(output, "default")).toBe(output);
  });

  it("does not add sandbox workspace networking for dangerous autonomy", () => {
    const output = installConfig("", "dangerous");
    expect(output).not.toContain("[sandbox_workspace_write]");
  });

  it("migrates duplicate legacy managed root values without retaining them", () => {
    const legacy =
      '# >>> holycodex managed >>>\nnotify = ["old"]\nnotify = ["old"]\n# <<< holycodex managed <<<\n' +
      '[mcp_servers.user]\ncommand = "user-runtime"\n';
    const output = installConfig(legacy, "default");
    expect(output.match(/^notify\s*=/gm) ?? []).toHaveLength(0);
    expect(output).toContain('[mcp_servers.user]\ncommand = "user-runtime"');
    expect(removeManaged(output)).toBe('[mcp_servers.user]\ncommand = "user-runtime"');
  });

  it("keeps unrelated root settings outside original-root metadata", () => {
    const input = 'notify = ["chatgpt-runtime"]\nservice_tier = "priority"\n';
    const output = installConfig(input, "default");
    const encoded = /^# holycodex original root: ([A-Za-z0-9+/=]+)$/m.exec(output)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded ?? "", "base64").toString("utf8")).toBe('service_tier = "priority"');
    expect(output.match(/^notify\s*=/gm)).toHaveLength(1);
    expect(removeManaged(output)).toBe(input.trim());
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

  it("consumes multiline status lists whose closing bracket follows the last item", () => {
    const input = 'status_line = [\n  "current-dir"]\n[custom]\nvalue = true\n';
    const output = installConfig(input, "default");
    expect(output).toContain('status_line = ["current-dir", "context-remaining"]');
    expect(output).not.toMatch(/^\s*"current-dir"]$/m);
    expect(removeManaged(output)).toBe(input.trim());
  });

  it("preserves valid single-quoted status-line entries", () => {
    const input = "status_line = ['git-branch', 'current-dir']\n";
    const output = installConfig(input, "default");
    expect(output).toContain('status_line = ["git-branch", "current-dir", "context-remaining"]');
    expect(removeManaged(output)).toBe(input.trim());
  });

  it("ignores quoted status-line items in inline comments", () => {
    const input = 'status_line = ["current-dir"] # formerly "git-branch"\n';
    const output = installConfig(input, "default");
    expect(output.match(/^status_line = .*$/m)?.[0]).toBe(
      'status_line = ["current-dir", "context-remaining"]',
    );
    expect(removeManaged(output)).toBe(input.trim());
  });
});
