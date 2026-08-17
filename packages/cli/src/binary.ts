// SPDX-License-Identifier: Apache-2.0

import { runCli, renderHuman } from "./commands.ts";
import type { CliContext } from "./types.ts";

export async function runBinary(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const context: CliContext = {
    env: process.env,
    cwd: process.cwd(),
    io: {
      stdin: stdinChunks(),
      stdoutIsTTY: process.stdout.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    },
    readStdin: async () => {
      let result = "";
      for await (const chunk of stdinChunks()) {
        result += chunk;
      }
      return result;
    },
  };
  const result = await runCli(argv, context);
  if (jsonRequested(argv)) {
    context.io?.writeStdout?.(`${JSON.stringify(result.envelope)}\n`);
  } else {
    context.io?.writeStdout?.(renderHuman(result));
  }
  return result.exitCode;
}

function jsonRequested(argv: readonly string[]): boolean {
  let requested = false;
  for (const argument of argv) {
    if (argument === "--json" || argument === "--json=true") {
      requested = true;
    } else if (argument === "--json=false") {
      requested = false;
    }
  }
  return requested;
}

async function* stdinChunks(): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin) {
    if (typeof chunk === "string") {
      yield chunk;
    } else {
      yield decoder.decode(chunk, { stream: true });
    }
  }
  const tail = decoder.decode();
  if (tail.length > 0) {
    yield tail;
  }
}
