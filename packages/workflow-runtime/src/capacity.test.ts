// SPDX-License-Identifier: Apache-2.0

import * as Effect from "effect/Effect";
import { describe, expect, test } from "vite-plus/test";
import { makeCapacityService, type CapacityService } from "./index.ts";

async function service(
  input: Readonly<{
    readonly maxCalls?: number;
    readonly maxConcurrency?: number;
    readonly costMax?: number;
  }>,
): Promise<CapacityService> {
  return await Effect.runPromise(
    makeCapacityService({
      planConcurrency: input.maxConcurrency ?? 2,
      sessionConcurrency: input.maxConcurrency ?? 2,
      codexConcurrency: input.maxConcurrency ?? 2,
      maxRetries: 2,
      maxCalls: input.maxCalls ?? 8,
      costMax: input.costMax ?? 100,
    }),
  );
}

const request = (runId: string, estimatedCost: number, maxCalls = 8, maxCost = 100) => ({
  runId,
  maxCalls,
  maxConcurrency: 2,
  maxCost,
  estimatedCost,
});

describe("atomic shared capacity settlement", () => {
  test("settles below, equal to, and above reservation without releasing committed cost", async () => {
    const capacity = await service({});
    const below = await Effect.runPromise(capacity.acquire(request("below", 40)));
    await Effect.runPromise(below.settle({ costUnits: 20 }));
    await Effect.runPromise(below.release);
    expect(await Effect.runPromise(capacity.snapshot("below"))).toMatchObject({
      calls: 1,
      committedCost: 20,
      reservedCost: 0,
    });

    const equal = await Effect.runPromise(capacity.acquire(request("equal", 30)));
    await Effect.runPromise(equal.settle({ costUnits: 30 }));
    await Effect.runPromise(equal.release);
    expect(await Effect.runPromise(capacity.snapshot("equal"))).toMatchObject({
      committedCost: 30,
    });

    const above = await Effect.runPromise(capacity.acquire(request("above", 10, 100, 100)));
    await expect(
      Effect.runPromise(Effect.flip(above.settle({ costUnits: 101 }))),
    ).resolves.toMatchObject({ code: "settlement_overflow" });
    await Effect.runPromise(above.release);
    await expect(
      Effect.runPromise(Effect.flip(capacity.acquire(request("later", 1)))),
    ).resolves.toMatchObject({ code: "settlement_overflow" });
  });

  test("atomically enforces independent calls, concurrency, and shared cost", async () => {
    const capacity = await service({ maxCalls: 2, maxConcurrency: 1, costMax: 60 });
    const first = await Effect.runPromise(capacity.acquire(request("shared", 40, 2, 60)));
    let secondSettled = false;
    const second = Effect.runPromise(capacity.acquire(request("shared", 20, 2, 60))).then(
      (reservation) => {
        secondSettled = true;
        return reservation;
      },
    );
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    await Effect.runPromise(first.settle({ costUnits: 40 }));
    await Effect.runPromise(first.release);
    const retry = await second;
    await Effect.runPromise(retry.settle({ costUnits: 20 }));
    await Effect.runPromise(retry.release);
    await expect(
      Effect.runPromise(Effect.flip(capacity.acquire(request("shared", 1, 2, 60)))),
    ).resolves.toMatchObject({ code: "admission_exceeded" });
  });

  test("charges retries and timeout uncertainty across nested shared runs", async () => {
    const capacity = await service({ maxCalls: 8, maxConcurrency: 2, costMax: 60 });
    const first = await Effect.runPromise(capacity.acquire(request("parent", 10)));
    const nested = await Effect.runPromise(capacity.acquire(request("child", 40)));
    await Effect.runPromise(first.settle({ costUnits: 5 }));
    await Effect.runPromise(first.release);
    await Effect.runPromise(nested.settle({ costUnits: 40 }));
    await Effect.runPromise(nested.release);

    const retry = await Effect.runPromise(capacity.acquire(request("parent", 10)));
    await Effect.runPromise(retry.settle({ costUnits: 10 }));
    await Effect.runPromise(retry.release);
    const timeout = await Effect.runPromise(capacity.acquire(request("parent", 5)));
    await Effect.runPromise(timeout.settle({ costUnits: 5 }));
    await Effect.runPromise(timeout.release);
    expect(await Effect.runPromise(capacity.snapshot("parent"))).toMatchObject({
      calls: 3,
      committedCost: 20,
      reservedCost: 0,
    });
    await expect(
      Effect.runPromise(Effect.flip(capacity.acquire(request("later", 1)))),
    ).resolves.toMatchObject({ code: "admission_exceeded" });
  });

  test("restores committed and outstanding values without double charging", async () => {
    const capacity = await service({ maxCalls: 4, costMax: 100 });
    await Effect.runPromise(
      capacity.restoreRun({
        runId: "resumed",
        maxCalls: 4,
        maxConcurrency: 2,
        maxCost: 100,
        calls: 1,
        committedCost: 30,
        reservedCost: 20,
        overflow: false,
      }),
    );
    await Effect.runPromise(
      capacity.restoreRun({
        runId: "resumed",
        maxCalls: 4,
        maxConcurrency: 2,
        maxCost: 100,
        calls: 1,
        committedCost: 30,
        reservedCost: 20,
        overflow: false,
      }),
    );
    expect(await Effect.runPromise(capacity.snapshot("resumed"))).toMatchObject({
      calls: 1,
      committedCost: 30,
      reservedCost: 20,
    });
  });
});
