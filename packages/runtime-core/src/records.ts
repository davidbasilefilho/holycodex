import { z } from "zod";

export const UnknownRecordSchema = z.record(z.string(), z.unknown());
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
