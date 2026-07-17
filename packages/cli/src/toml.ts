const TOML_TABLE = /^[ \t]*(?:\[[^\]\r\n]+\]|\[\[[^\]\r\n]+\]\])[ \t]*(?:#.*)?$/m;

export function rootTomlString(input: string, key: string): string | undefined {
  const table = TOML_TABLE.exec(input);
  const root = table === null ? input : input.slice(0, table.index);
  const match = new RegExp(
    String.raw`^[ \t]*${escapeRegExp(key)}[ \t]*=[ \t]*(?:"((?:\\.|[^"\\\r\n])*)"|'([^'\r\n]*)')[ \t]*(?:#.*)?$`,
    "m",
  ).exec(root);
  if (match === null) return undefined;
  if (match[2] !== undefined) return match[2];

  try {
    const parsed: unknown = JSON.parse(`"${match[1] ?? ""}"`);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function rootTomlStringArray(input: string, key: string): string[] | undefined {
  const table = TOML_TABLE.exec(input);
  const root = table === null ? input : input.slice(0, table.index);
  const assignment = new RegExp(String.raw`^[ \t]*${escapeRegExp(key)}[ \t]*=`, "m").exec(root);
  if (assignment === null) return undefined;
  const start = root.indexOf("[", assignment.index + assignment[0].length);
  if (start < 0) return undefined;

  const items: string[] = [];
  let quote: '"' | "'" | undefined;
  let raw = "";
  let escaped = false;
  let comment = false;
  for (let index = start + 1; index < root.length; index += 1) {
    const character = root[index];
    if (comment) {
      if (character === "\n") comment = false;
      continue;
    }
    if (quote === '"') {
      if (escaped) {
        raw += character;
        escaped = false;
      } else if (character === "\\") {
        raw += character;
        escaped = true;
      } else if (character === '"') {
        const parsed: unknown = JSON.parse(`"${raw}"`);
        if (typeof parsed !== "string") return undefined;
        items.push(parsed);
        quote = undefined;
        raw = "";
      } else {
        raw += character;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        items.push(raw);
        quote = undefined;
        raw = "";
      } else {
        raw += character;
      }
      continue;
    }
    if (character === "#") comment = true;
    else if (character === '"' || character === "'") quote = character;
    else if (character === "]") return items;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
