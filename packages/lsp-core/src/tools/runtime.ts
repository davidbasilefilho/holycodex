// SPDX-License-Identifier: Apache-2.0

import { LSP_COMMANDS } from "./definitions.ts";
import { coerceToolArguments } from "./parameters.ts";
import type { ToolExecutionResult } from "./types.ts";

/** Executes one public LSP command or alias with typed tool arguments. */
export async function executeLspTool(
  name: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const command = LSP_COMMANDS.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  if (command === undefined) throw new Error(`Unknown LSP tool: ${name}`);
  return command.execute(params, signal);
}

export { coerceToolArguments };
