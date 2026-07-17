#!/usr/bin/env node
import { stdin, stdout } from "node:process";

import { runRulesHook } from "./rules-hook.ts";

let raw = "";
stdin.setEncoding("utf8");
for await (const chunk of stdin) raw += chunk;
if (raw.trim()) {
  const input: unknown = JSON.parse(raw);
  if (typeof input === "object" && input !== null && !Array.isArray(input))
    stdout.write(await runRulesHook(input));
}
