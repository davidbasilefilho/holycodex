#!/usr/bin/env node
import { stdin, stdout } from "node:process";

import { UnknownRecordSchema } from "../../mcp-stdio-core/src/schemas.ts";
import { runRulesHook } from "./rules-hook.ts";

let raw = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) raw += chunk;
if (raw.trim()) {
  const input = UnknownRecordSchema.safeParse(JSON.parse(raw));
  if (input.success) stdout.write(await runRulesHook(input.data));
}
