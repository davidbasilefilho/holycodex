// SPDX-License-Identifier: Apache-2.0

import { runCli, renderHuman } from "./commands.ts";
import { helpRequested, helpText, helpTopic } from "./help.ts";
import type { CliContext } from "./types.ts";

export interface BinaryIo {
  readonly stdin?: AsyncIterable<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export async function runBinary(
  argv: readonly string[] = Bun.argv.slice(2),
  binaryIo: BinaryIo = processIo(),
): Promise<number> {
  const context: CliContext = {
    env: process.env,
    cwd: process.cwd(),
    workflowSessionId: `cli-${crypto.randomUUID()}`,
    io: {
      stdin: binaryIo.stdin ?? stdinChunks(),
      stdoutIsTTY: binaryIo.stdoutIsTTY ?? process.stdout.isTTY === true,
      stderrIsTTY: binaryIo.stderrIsTTY ?? process.stderr.isTTY === true,
      ...(binaryIo.confirm === undefined ? {} : { confirm: binaryIo.confirm }),
      writeStdout: binaryIo.writeStdout,
      writeStderr: binaryIo.writeStderr,
    },
    readStdin: async () => {
      let result = "";
      for await (const chunk of binaryIo.stdin ?? stdinChunks()) {
        result += chunk;
      }
      return result;
    },
  };
  const result = await runCli(argv, context);
  if (helpRequested(argv) && !jsonRequested(argv)) {
    context.io?.writeStdout?.(helpText(helpTopic(argv)));
  } else if (argv[0] === "help" && !jsonRequested(argv)) {
    context.io?.writeStdout?.(helpText(helpTopic(argv)));
  } else if (jsonRequested(argv)) {
    context.io?.writeStdout?.(`${JSON.stringify(result.envelope)}\n`);
  } else if (result.envelope.ok) {
    context.io?.writeStdout?.(renderHuman(result));
  } else {
    context.io?.writeStderr?.(renderHuman(result));
  }
  return result.exitCode;
}

function processIo(): BinaryIo {
  return {
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
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
