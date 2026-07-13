const START = "# >>> holycodex managed >>>";
const END = "# <<< holycodex managed <<<";

const OLD_NAMESPACES = [
  "marketplaces.sisyphuslabs",
  'plugins."omo@sisyphuslabs"',
  "marketplaces.lazycodex",
  'plugins."omo@lazycodex"',
  "marketplaces.code-yeongyu-codex-plugins",
  'plugins."omo@code-yeongyu-codex-plugins"',
  "agents.plan",
  "agents.metis",
  "agents.momus",
  "agents.oracle",
  "agents.sisyphus",
  "agents.prometheus",
  "agents.atlas",
  "agents.hephaestus",
  'hooks.state."omo@sisyphuslabs',
  'hooks.state."omo@lazycodex',
  'hooks.state."omo@code-yeongyu-codex-plugins',
] as const;

export function removeManaged(input: string): string {
  const escapedStart = START.replaceAll(">", "\\>");
  const escapedEnd = END.replaceAll("<", "\\<");
  return input
    .replace(new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}\\r?\\n?`, "g"), "")
    .trim();
}

export function removeLegacyOmo(input: string): string {
  return input
    .split(/(?=^\s*\[)/m)
    .filter((section) => {
      const header = /^\s*\[([^\]]+)]/.exec(section)?.[1];
      if (header === undefined) return true;
      if (OLD_NAMESPACES.some((name) => header === name || header.startsWith(`${name}.`)))
        return false;
      const sharedAgent = ["agents.explorer", "agents.librarian", "agents.worker"].some(
        (name) => header === name || header.startsWith(`${name}.`),
      );
      return !sharedAgent || !/(?:sisyphuslabs|omo@|oh-my|code-yeongyu)/i.test(section);
    })
    .join("")
    .trimEnd();
}

function rewriteForbiddenReasoning(input: string): string {
  return input
    .split(/(?=^\s*\[)/m)
    .map((section) => {
      const model = /^\s*model\s*=\s*"([^"]+)"/im.exec(section)?.[1]?.toLowerCase();
      if (model === undefined || !/(?:sol|terra|luna)/.test(model)) return section;
      const allowsHigh = model.includes("luna");
      const rewritten = section.replace(
        /^(\s*model_reasoning_effort\s*=\s*)"([^"]+)"/gim,
        (_match, prefix: string, effort: string) => {
          const normalized = effort.toLowerCase();
          if (
            normalized === "low" ||
            normalized === "medium" ||
            (allowsHigh && normalized === "high")
          )
            return `${prefix}"${normalized}"`;
          return `${prefix}"${normalized === "high" ? "medium" : "low"}"`;
        },
      );
      return /^\s*model_reasoning_effort\s*=/im.test(rewritten)
        ? rewritten
        : rewritten.replace(/^(\s*model\s*=\s*"[^"]+")/im, '$1\nmodel_reasoning_effort = "low"');
    })
    .join("");
}

export function installConfig(input: string, autonomous: boolean): string {
  const base = rewriteForbiddenReasoning(removeLegacyOmo(removeManaged(input)));
  const firstTable = base.search(/^\s*\[/m);
  const rootSection = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  const preservedRoot = rootSection
    .replace(/^\s*max_concurrent_threads_per_session\s*=.*\r?\n?/gm, "")
    .replace(autonomous ? /^\s*(?:approval_policy|sandbox_mode)\s*=.*\r?\n?/gm : /$^/g, "")
    .trimEnd();
  const rootModel = /^\s*model\s*=/m.test(preservedRoot)
    ? ""
    : 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "low"\n';
  const autonomy = autonomous
    ? 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'
    : "";
  const rootBlock = `${START}\n${rootModel}${autonomy}max_concurrent_threads_per_session = 2\n${END}`;
  const agents = ["explorer", "librarian", "worker"]
    .filter((name) => !new RegExp(`^\\s*\\[agents\\.${name}]`, "m").test(base))
    .map((name) => `[agents.${name}]\nconfig_file = "holycodex/agents/${name}.toml"`)
    .join("\n\n");
  const pluginBlock = `${START}\n[marketplaces.holycodex]\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true${agents.length > 0 ? `\n\n${agents}` : ""}\n${END}`;
  return `${rootBlock}${preservedRoot.length > 0 ? `\n${preservedRoot}` : ""}${tables.length > 0 ? `\n\n${tables}` : ""}\n\n${pluginBlock}\n`;
}
