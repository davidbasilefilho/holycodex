import { Buffer } from "node:buffer";

const START = "# >>> holycodex managed >>>";
const END = "# <<< holycodex managed <<<";
const ORIGINAL_ROOT = "# holycodex original root: ";

export type AutonomyMode = "default" | "autonomous" | "dangerous";

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
    .replace(
      new RegExp(`${escapedStart}([\\s\\S]*?)${escapedEnd}(?:\\r?\\n){0,2}`, "g"),
      (_match, body: string) => {
        const encoded = body.match(/^# holycodex original root: ([A-Za-z0-9+/=]+)$/m)?.[1];
        return encoded === undefined ? "" : `${Buffer.from(encoded, "base64").toString("utf8")}\n`;
      },
    )
    .trim();
}

export function removeLegacyOmo(input: string): string {
  return input
    .split(/(?=^\s*\[)/m)
    .filter((section) => {
      const header = /^\s*\[([^\]]+)]/.exec(section)?.[1];
      if (header === undefined) return true;
      if (
        OLD_NAMESPACES.some(
          (name) =>
            header === name ||
            header.startsWith(`${name}.`) ||
            (name.includes('"omo@') && header.startsWith(name)),
        )
      )
        return false;
      const shared = ["agents.explorer", "agents.librarian", "agents.worker"].some(
        (name) => header === name || header.startsWith(`${name}.`),
      );
      return !shared || !/(?:sisyphuslabs|omo@|oh-my|code-yeongyu)/i.test(section);
    })
    .join("")
    .trimEnd();
}

function injectTableKey(input: string, table: string, key: string, value: string): string {
  const header = new RegExp(`^\\s*\\[${table.replaceAll(".", "\\.")}]\\s*$`, "m");
  const match = header.exec(input);
  const managed = `${START}\n${key} = ${value}\n${END}`;
  if (match === null)
    return `${input.trimEnd()}\n\n${START}\n[${table}]\n${key} = ${value}\n${END}`.trim();
  const bodyStart = match.index + match[0].length;
  const next = input.slice(bodyStart).search(/^\s*\[/m);
  const bodyEnd = next < 0 ? input.length : bodyStart + next;
  const body = input
    .slice(bodyStart, bodyEnd)
    .replace(new RegExp(`^\\s*${key}\\s*=.*\\r?\\n?`, "gm"), "")
    .trim();
  const suffix = input.slice(bodyEnd).trimStart();
  return `${input.slice(0, bodyStart)}\n${body ? `${body}\n` : ""}${managed}${suffix ? `\n${suffix}` : ""}`.trim();
}

function rootValue(input: string, key: string): string | undefined {
  if (key === "status_line")
    return (
      /^\s*status_line\s*=\s*\[[\s\S]*?^\s*]\s*(?:#.*)?$/m.exec(input)?.[0] ??
      /^\s*status_line\s*=.*$/m.exec(input)?.[0]
    );
  return new RegExp(`^\\s*${key}\\s*=.*$`, "m").exec(input)?.[0];
}

function removeRootValue(input: string, value: string | undefined): string {
  return value === undefined ? input : input.replace(value, "");
}

function mergedStatusLine(original: string | undefined): string {
  if (original === undefined) return '["model-with-reasoning", "context-remaining", "current-dir"]';
  const source = original.slice(original.indexOf("=") + 1);
  const items = [...source.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(
    (match) => JSON.parse(`"${match[1]}"`) as string,
  );
  if (!items.includes("context-remaining")) items.push("context-remaining");
  return `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;
}

export function installConfig(input: string, mode: AutonomyMode): string {
  const base = removeLegacyOmo(removeManaged(input));
  const firstTable = base.search(/^\s*\[/m);
  const root = firstTable < 0 ? base : base.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : base.slice(firstTable);
  const controlled = [
    "approval_policy",
    "sandbox_mode",
    "max_concurrent_threads_per_session",
    "status_line",
  ].map((key) => rootValue(root, key));
  const originalRoot = root.trim();
  const preservedRoot = controlled.reduce(removeRootValue, root).trim();
  const model = /^\s*model\s*=/m.test(preservedRoot)
    ? ""
    : 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "medium"\n';
  const approval = mode === "default" ? "on-request" : "never";
  const sandbox = mode === "dangerous" ? "danger-full-access" : "workspace-write";
  const original = originalRoot
    ? `${ORIGINAL_ROOT}${Buffer.from(originalRoot).toString("base64")}\n`
    : "";
  const preserved = preservedRoot ? `${preservedRoot}\n` : "";
  const rootBlock = `${START}\n${original}${model}${preserved}approval_policy = "${approval}"\nsandbox_mode = "${sandbox}"\nstatus_line = ${mergedStatusLine(controlled[3])}\nmax_concurrent_threads_per_session = 2\n${END}`;
  let configured = `${rootBlock}${tables ? `\n\n${tables}` : ""}`;
  configured = injectTableKey(configured, "features", "default_mode_request_user_input", "true");
  if (mode !== "dangerous")
    configured = injectTableKey(configured, "sandbox_workspace_write", "network_access", "true");
  const agents = ["explorer", "librarian", "worker"]
    .filter((name) => !new RegExp(`^\\s*\\[agents\\.${name}]`, "m").test(configured))
    .map((name) => `[agents.${name}]\nconfig_file = "holycodex/agents/${name}.toml"`)
    .join("\n\n");
  const plugin = `${START}\n[marketplaces.holycodex]\nsource = "https://github.com/davidbasilefilho/holycodex.git"\n\n[plugins."holycodex@holycodex"]\nenabled = true${agents ? `\n\n${agents}` : ""}\n${END}`;
  return `${configured.trim()}\n\n${plugin}\n`;
}
