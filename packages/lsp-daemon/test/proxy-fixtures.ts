import { Readable, Writable } from "node:stream";

export const noSpawn = (): Promise<void> => Promise.resolve();

export function inputStream(messages: readonly object[]): Readable {
  return Readable.from([`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`]);
}

export function collectingWritable(chunks: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(chunk.toString());
      callback();
    },
  });
}
