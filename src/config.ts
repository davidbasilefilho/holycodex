const START = "# >>> holycodex managed >>>";
const END = "# <<< holycodex managed <<<";

const OLD_NAMESPACES = [
  "marketplaces.sisyphuslabs",
  'plugins."omo@sisyphuslabs"',
  "marketplaces.lazycodex",
  'plugins."omo@lazycodex"',
  "marketplaces.code-yeongyu-codex-plugins",
  'plugins."omo@code-yeongyu-codex-plugins"',
  "agents.explorer",
  "agents.librarian",
  "agents.worker",
  "agents.plan",
  "agents.metis",
  "agents.momus",
  "agents.oracle",
  "agents.sisyphus",
  "agents.prometheus",
  "agents.atlas",
  "agents.hephaestus",
] as const;

export function removeManaged(input: string): string {
  const escapedStart = START.replaceAll(">", "\\>");
  const escapedEnd = END.replaceAll("<", "\\<");
  return input
    .replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`, "g"), "")
    .trimEnd();
}

export function removeLegacyOmo(input: string): string {
  const lines = input.split(/\r?\n/);
  const kept: string[] = [];
  let removing = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)]/.exec(line)?.[1];
    if (header !== undefined) {
      removing = OLD_NAMESPACES.some((name) => header === name || header.startsWith(`${name}.`));
    }
    if (!removing) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

function rewriteForbiddenReasoning(input: string): string {
  return input
    .split(/(?=^\s*\[)/m)
    .map((section) => {
      const usesRestrictedModel = /^\s*model\s*=\s*"[^"]*(?:sol|terra)[^"]*"/im.test(section);
      return usesRestrictedModel
        ? section.replace(/^(\s*model_reasoning_effort\s*=\s*)"high"/gim, '$1"medium"')
        : section;
    })
    .join("");
}

export function installConfig(input: string, autonomous: boolean): string {
  const base = rewriteForbiddenReasoning(removeLegacyOmo(removeManaged(input)));
  const rootModel = /^\s*model\s*=/m.test(base)
    ? ""
    : 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n';
  const autonomy = autonomous
    ? 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    : "";
  const block = `${START}\n${rootModel}${autonomy}max_concurrent_threads_per_session = 2\n\n[marketplaces.holycodex]\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true\n\n[agents.explorer]\nconfig_file = "holycodex/agents/explorer.toml"\n\n[agents.librarian]\nconfig_file = "holycodex/agents/librarian.toml"\n\n[agents.worker]\nconfig_file = "holycodex/agents/worker.toml"\n${END}`;
  return `${base}${base.length > 0 ? "\n\n" : ""}${block}\n`;
}
