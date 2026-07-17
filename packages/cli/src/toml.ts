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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
