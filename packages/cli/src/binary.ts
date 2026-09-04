// SPDX-License-Identifier: Apache-2.0

import { createInterface } from "node:readline/promises";

import { runCli, renderHuman } from "./commands.ts";
import { helpRequested, helpTopic, renderHelp } from "./help.ts";
import type { InstallRequest } from "./installer.ts";
import type { CliContext, InstallWizardResult } from "./types.ts";

export interface BinaryIo {
  readonly stdin?: AsyncIterable<string>;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly confirm?: (message: string) => Promise<boolean>;
  /** Optional injectable wizard used by embedders and tests. */
  readonly installWizard?: (initial: InstallRequest) => Promise<InstallWizardResult>;
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
    io: {
      stdin: binaryIo.stdin ?? stdinChunks(),
      stdoutIsTTY: binaryIo.stdoutIsTTY ?? process.stdout.isTTY === true,
      stderrIsTTY: binaryIo.stderrIsTTY ?? process.stderr.isTTY === true,
      ...(binaryIo.confirm === undefined ? {} : { confirm: binaryIo.confirm }),
      ...(binaryIo.installWizard === undefined ? {} : { installWizard: binaryIo.installWizard }),
      writeStdout: binaryIo.writeStdout,
      writeStderr: binaryIo.writeStderr,
    },
  };
  const result = await runCli(argv, context);
  if ((helpRequested(argv) || argv[0] === "help") && !jsonRequested(argv)) {
    context.io?.writeStdout?.(
      renderHelp(helpTopic(argv), {
        stdoutIsTTY: context.io?.stdoutIsTTY,
        stderrIsTTY: context.io?.stderrIsTTY,
        env: context.env,
        stream: "stdout",
      }),
    );
  } else if (jsonRequested(argv)) {
    context.io?.writeStdout?.(`${JSON.stringify(result.envelope)}\n`);
  } else if (result.envelope.ok) {
    context.io?.writeStdout?.(
      renderHuman(result, {
        stdoutIsTTY: context.io?.stdoutIsTTY,
        stderrIsTTY: context.io?.stderrIsTTY,
        env: context.env,
        stream: "stdout",
      }),
    );
  } else {
    context.io?.writeStderr?.(
      renderHuman(result, {
        stdoutIsTTY: context.io?.stderrIsTTY,
        stderrIsTTY: context.io?.stderrIsTTY,
        env: context.env,
        stream: "stderr",
      }),
    );
  }
  return result.exitCode;
}

function processIo(): BinaryIo {
  return {
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    confirm: async (message) => {
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await prompt.question(`${message} [y/N] `);
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
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
