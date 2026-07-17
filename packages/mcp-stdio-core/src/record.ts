import { UnknownRecordSchema } from "./schemas.js";

/** Checks whether a value is a plain record. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return UnknownRecordSchema.safeParse(value).success;
}
