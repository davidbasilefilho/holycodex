import { Readable, Writable } from "node:stream";

/** Resolves without spawning a process. */
export const noSpawn = (): Promise<void> => Promise.resolve();

/** Creates a readable JSON-lines fixture. */
export function inputStream(messages: readonly object[]): Readable {
  return Readable.from([`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`]);
}

/** Creates a writable fixture that collects decoded chunks. */
export function collectingWritable(chunks: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
}
