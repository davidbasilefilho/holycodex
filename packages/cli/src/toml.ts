const TOML_TABLE = /^[ \t]*(?:\[[^\]\r\n]+\]|\[\[[^\]\r\n]+\]\])[ \t]*(?:#.*)?$/m;

/** Reads a root TOML string value. */
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

type RootTomlStringArray = { readonly source: string; readonly items: string[] };

/** Reads a root TOML string array. */
export function rootTomlStringArray(input: string, key: string): string[] | undefined {
  return parseRootTomlStringArray(input, key)?.items;
}

/** Reads the source text of a root TOML string array. */
export function rootTomlStringArraySource(input: string, key: string): string | undefined {
  return parseRootTomlStringArray(input, key)?.source;
}

function parseRootTomlStringArray(input: string, key: string): RootTomlStringArray | undefined {
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
        try {
          const parsed: unknown = JSON.parse(`"${raw}"`);
          if (typeof parsed !== "string") return undefined;
          items.push(parsed);
        } catch {
          return undefined;
        }
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
    else if (character === "]") {
      const suffix = /^[ \t]*(?:#.*)?(?=\r?\n|$)/.exec(root.slice(index + 1))?.[0] ?? "";
      return {
        source: root.slice(assignment.index, index + 1 + suffix.length),
        items,
      };
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
