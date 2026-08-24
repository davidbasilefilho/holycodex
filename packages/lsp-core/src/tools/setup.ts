// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { setupLspServer } from "../lsp/setup.ts";
import { LspSetupError } from "../lsp/errors.ts";
import { decodeLspSchema } from "../lsp/schema.ts";
import { text } from "./result.ts";
import type { ToolExecutionResult } from "./types.ts";

const SetupInputSchema = Schema.Struct({
  serverId: Schema.optional(Schema.String),
  server_id: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
  executable: Schema.optional(Schema.String),
  configPath: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
});

/** Executes the explicit, no-download `lsp_setup` capability adapter. */
export async function executeLspSetup(
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const input = decodeLspSchema(SetupInputSchema, params);
  if (input === undefined)
    return text(
      "Invalid lsp_setup input. Provide a server id and typed executable/configuration fields.",
      { errorKind: "invalid_input" },
      true,
    );
  const serverId = input.serverId ?? input.server_id;
  if (serverId === undefined || serverId.length === 0)
    return text(
      "Missing required string parameter 'serverId'.",
      { errorKind: "invalid_input" },
      true,
    );
  const { root, executable, configPath, args, extensions } = input;
  try {
    const result = setupLspServer({
      serverId,
      ...(root === undefined ? {} : { root }),
      ...(executable === undefined ? {} : { executable }),
      ...(configPath === undefined ? {} : { configPath }),
      ...(args === undefined ? {} : { args }),
      ...(extensions === undefined ? {} : { extensions }),
    });
    return text(`Configured LSP server '${result.serverId}' in ${result.configPath}.`, result);
  } catch (error: unknown) {
    if (error instanceof LspSetupError)
      return text(error.message, { serverId, errorKind: error.code }, true);
    throw error;
  }
}
