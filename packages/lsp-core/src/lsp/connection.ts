// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import { LspClientTransport } from "./transport.ts";

const InitializeResultSchema = Schema.Unknown;

/** Adds the standard LSP initialize handshake to a transport. */
export class LspClientConnection extends LspClientTransport {
  /** Initializes the language server and announces the workspace. */
  async initialize(signal?: AbortSignal): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    await this.sendRequest(
      "initialize",
      InitializeResultSchema,
      {
        processId: process.pid,
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            publishDiagnostics: {},
            rename: { prepareSupport: true, prepareSupportDefaultBehavior: 1 },
          },
          workspace: {
            symbol: {},
            workspaceFolders: true,
            configuration: true,
            applyEdit: true,
            workspaceEdit: { documentChanges: true },
          },
        },
        initializationOptions: this.server.initialization,
      },
      { timeoutMs: this.initializeTimeoutMs, signal },
    );
    await this.sendNotification("initialized");
    await this.sendNotification("workspace/didChangeConfiguration", {
      settings: { json: { validate: { enable: true } } },
    });
  }
}
