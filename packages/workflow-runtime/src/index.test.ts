// SPDX-License-Identifier: Apache-2.0

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, test } from "vite-plus/test";
import type { JsonValue } from "@holycodex/core";
import {
  compileWorkflow,
  createCodec,
  makeCapacityService,
  runExecutionPlan,
  workflow,
  type Assignment,
  type CapacityService,
  type ValueCodec,
  type Wait,
  type WorkflowHostServices,
} from "./index.ts";

const numberCodec = createCodec("number", (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expected a finite number");
  }
  return value;
});

const textCodec = createCodec("text", (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("expected text");
  }
  return value;
});

const pairCodec = createCodec(
  "pair",
  (value: unknown): { readonly left: number; readonly right: number } => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("left" in value) ||
      !("right" in value) ||
      typeof value.left !== "number" ||
      typeof value.right !== "number"
    ) {
      throw new Error("expected a numeric pair");
    }
    return { left: value.left, right: value.right };
  },
);

function descriptor<I extends JsonValue, O extends JsonValue>(
  input: ValueCodec<I>,
  output: ValueCodec<O>,
  payload?: JsonValue,
): Assignment<I, O> {
  return {
    input,
    output,
    ...(payload === undefined ? {} : { payload }),
  };
}

function assignmentResult(assignment: Assignment<JsonValue, JsonValue>): unknown {
  const payload = assignment.payload;
  if (assignment.output.name === "number") {
    if (typeof payload === "number") {
      return payload + 1;
    }
    if (typeof payload === "object" && payload !== null && "value" in payload) {
      const value = payload["value"];
      if (typeof value === "number") {
        return payload && "op" in payload && payload["op"] === "double" ? value * 2 : value + 1;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "left" in value &&
        "right" in value &&
        typeof value["left"] === "number" &&
        typeof value["right"] === "number"
      ) {
        return value["left"] + value["right"];
      }
    }
  }
  if (assignment.output.name === "text") {
    if (typeof payload === "number") {
      return `value:${payload}`;
    }
    if (typeof payload === "object" && payload !== null && "value" in payload) {
      const value = payload["value"];
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        return `value:${String(value)}`;
      }
    }
  }
  throw new Error("unexpected fixture assignment payload");
}

function fixtureServices(
  execute: (
    assignment: Assignment<JsonValue, JsonValue>,
  ) => Effect.Effect<unknown, import("./index.ts").WorkflowFailure> = (assignment) =>
    Effect.try({
      try: () => assignmentResult(assignment),
      catch: (cause) => ({
        _tag: "WorkflowFailure" as const,
        code: "execution" as const,
        message: "fixture agent failed",
        cause,
      }),
    }),
): WorkflowHostServices {
  return { agent: { execute } };
}

async function prepare<I extends JsonValue, T extends JsonValue>(
  terminal: Wait<I, T>,
  input: unknown,
  services: WorkflowHostServices = fixtureServices(),
  capacity?: CapacityService,
): Promise<T> {
  const plan = await Effect.runPromise(
    compileWorkflow(terminal, {
      capacity: {
        planConcurrency: 2,
        sessionConcurrency: 2,
        codexConcurrency: 2,
        maxRetries: 2,
      },
    }),
  );
  const sharedCapacity = capacity ?? (await Effect.runPromise(makeCapacityService(plan.capacity)));
  return await Effect.runPromise(
    runExecutionPlan(plan, input, {
      capacity: sharedCapacity,
      services,
    }),
  );
}

describe("workflow 0.15 DSL and Effect runtime", () => {
  test("executes inert descriptor stages sequentially", async () => {
    let calls = 0;
    const first = workflow.step({
      id: "first",
      assignment: descriptor(numberCodec, numberCodec),
    });
    const terminal = workflow.wait(
      workflow.queue(first, (value: number) =>
        workflow.step({
          id: "second",
          assignment: descriptor(numberCodec, numberCodec, { op: "double", value }),
        }),
      ),
    );
    const result = await prepare(terminal, 3, {
      agent: {
        execute: (assignment) =>
          Effect.sync(() => {
            calls += 1;
            return assignmentResult(assignment);
          }),
      },
    });
    expect(result).toBe(8);
    expect(calls).toBe(2);
  });

  test("wait accepts direct workflows, runs, and compatible named mixtures", async () => {
    const left = workflow.step({
      id: "left",
      assignment: descriptor(numberCodec, numberCodec),
    });
    const right = workflow.step({
      id: "right",
      assignment: descriptor(numberCodec, textCodec),
    });
    const terminal = workflow.wait({ left: workflow.start(left), right });

    await expect(prepare(terminal, 4)).resolves.toEqual({ left: 5, right: "value:4" });
  });

  test("rejects overlapping writer ownership in a parallel layer", async () => {
    const left = workflow.step({
      id: "writer-left",
      assignment: {
        ...descriptor(numberCodec, numberCodec),
        metadata: { writes: ["packages/core"] },
      },
    });
    const right = workflow.step({
      id: "writer-right",
      assignment: {
        ...descriptor(numberCodec, numberCodec),
        metadata: { writes: ["packages/core/src/routes.ts#lookupRoute"] },
      },
    });
    const result = await Effect.runPromiseExit(compileWorkflow(workflow.wait({ left, right })));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const failure = Cause.failureOption(result.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value.code).toBe("compilation");
      }
    }
  });

  test("passes an opaque join result to the next queue callback", async () => {
    const seed = workflow.step({
      id: "seed",
      assignment: descriptor(numberCodec, numberCodec),
    });
    const branch = workflow.wait({
      left: workflow.step({ id: "branch-left", assignment: descriptor(numberCodec, numberCodec) }),
      right: workflow.step({
        id: "branch-right",
        assignment: descriptor(numberCodec, numberCodec),
      }),
    });
    const terminal = workflow.wait(
      workflow.queue(
        seed,
        () => branch,
        (value: { readonly left: number; readonly right: number }) =>
          workflow.step({
            id: "join-next",
            assignment: descriptor(pairCodec, numberCodec, { value }),
          }),
      ),
    );

    await expect(prepare(terminal, 4)).resolves.toBe(12);
  });

  test("shares hierarchical session capacity across independent runs", async () => {
    let active = 0;
    let maximum = 0;
    const services = fixtureServices((assignment) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          active += 1;
          maximum = Math.max(maximum, active);
          return assignment;
        }),
        () => Effect.sleep("8 millis").pipe(Effect.as(assignmentResult(assignment))),
        () =>
          Effect.sync(() => {
            active -= 1;
          }),
      ),
    );
    const first = workflow.wait(
      workflow.step({ id: "capacity-a", assignment: descriptor(numberCodec, numberCodec) }),
    );
    const second = workflow.wait(
      workflow.step({ id: "capacity-b", assignment: descriptor(numberCodec, numberCodec) }),
    );
    const firstPlan = await Effect.runPromise(compileWorkflow(first));
    const secondPlan = await Effect.runPromise(compileWorkflow(second));
    const capacity = await Effect.runPromise(
      makeCapacityService({
        planConcurrency: 2,
        sessionConcurrency: 1,
        codexConcurrency: 2,
        maxRetries: 0,
      }),
    );

    await Promise.all([
      Effect.runPromise(runExecutionPlan(firstPlan, 1, { capacity, services })),
      Effect.runPromise(runExecutionPlan(secondPlan, 1, { capacity, services })),
    ]);
    expect(maximum).toBe(1);
  });

  test("retries typed agent failures without executing an assignment locally", async () => {
    let calls = 0;
    const flaky = workflow.step({
      id: "flaky",
      assignment: {
        ...descriptor(numberCodec, numberCodec, { op: "flaky" }),
        metadata: { retries: 1 },
      },
    });
    const services = fixtureServices(() => {
      calls += 1;
      return calls === 1
        ? Effect.fail({
            _tag: "WorkflowFailure" as const,
            code: "execution" as const,
            message: "transient",
          })
        : Effect.succeed(3);
    });
    const plan = await Effect.runPromise(
      compileWorkflow(workflow.wait(flaky), {
        capacity: { maxRetries: 1 },
      }),
    );
    const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
    await expect(
      Effect.runPromise(runExecutionPlan(plan, 2, { capacity, services })),
    ).resolves.toBe(3);
    expect(calls).toBe(2);
  });

  test("does not retry a failure marked as an uncertain external effect", async () => {
    let calls = 0;
    const step = workflow.step({
      id: "uncertain",
      assignment: {
        ...descriptor(numberCodec, numberCodec),
        metadata: { retries: 1 },
      },
    });
    const plan = await Effect.runPromise(
      compileWorkflow(workflow.wait(step), { capacity: { maxRetries: 1 } }),
    );
    const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
    const services = fixtureServices(() => {
      calls += 1;
      return Effect.fail({
        _tag: "WorkflowFailure" as const,
        code: "execution" as const,
        message: "uncertain",
        retryable: false,
      });
    });

    await expect(
      Effect.runPromise(runExecutionPlan(plan, 1, { capacity, services })),
    ).rejects.toBeDefined();
    expect(calls).toBe(1);
  });

  test("records each native retry attempt without post-effect approval", async () => {
    let calls = 0;
    let approvals = 0;
    const events: Array<{ readonly type: string; readonly attempt: number }> = [];
    const flaky = workflow.step({
      id: "retry-accounting",
      assignment: {
        ...descriptor(numberCodec, numberCodec),
        metadata: { retries: 1 },
      },
    });
    const plan = await Effect.runPromise(
      compileWorkflow(workflow.wait(flaky), {
        capacity: { maxRetries: 1, maxCalls: 2, costMax: 2 },
      }),
    );
    const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
    await expect(
      Effect.runPromise(
        runExecutionPlan(plan, 1, {
          capacity,
          services: {
            journal: (event) =>
              Effect.sync(() => {
                events.push({ type: event.type, attempt: event.attempt });
              }),
            approval: () =>
              Effect.sync(() => {
                approvals += 1;
              }),
            agent: {
              execute: () => {
                calls += 1;
                return calls === 1
                  ? Effect.fail({
                      _tag: "WorkflowFailure" as const,
                      code: "execution" as const,
                      message: "transient",
                    })
                  : Effect.succeed(2);
              },
            },
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(calls).toBe(2);
    expect(approvals).toBe(2);
    expect(
      events.filter((event) => event.type === "started").map((event) => event.attempt),
    ).toEqual([1, 2]);
    expect(events.at(-1)).toEqual({ type: "completed", attempt: 2 });
  });

  test("preserves interruption failures without timing out live agents", async () => {
    const step = workflow.step({
      id: "interruptible",
      assignment: descriptor(numberCodec, numberCodec, { op: "interruptible" }),
    });
    const plan = await Effect.runPromise(
      compileWorkflow(workflow.wait(step), {
        capacity: { maxRetries: 0 },
      }),
    );
    const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
    const interrupted = await Effect.runPromiseExit(
      runExecutionPlan(plan, 1, {
        capacity,
        services: fixtureServices(() => Effect.interrupt),
      }),
    );
    expect(interrupted._tag).toBe("Failure");
    if (interrupted._tag === "Failure") {
      const failure = Cause.failureOption(interrupted.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value.code).toBe("interruption");
      }
    }
  });

  test("rejects malformed policy and open terminals before dispatch", async () => {
    const invalid = workflow.step({
      id: "invalid name",
      assignment: descriptor(numberCodec, numberCodec),
    });
    await expect(
      Effect.runPromiseExit(compileWorkflow(workflow.wait(invalid))),
    ).resolves.toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail" },
    });

    const openRun = workflow.start(invalid);
    // @ts-expect-error A started run is not a waited terminal.
    compileWorkflow(openRun);
  });

  test("atomically admits parallel calls, cost, and observed concurrency", async () => {
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const left = workflow.step({
      id: "atomic-left",
      assignment: descriptor(numberCodec, numberCodec),
    });
    const right = workflow.step({
      id: "atomic-right",
      assignment: descriptor(numberCodec, numberCodec),
    });
    const terminal = workflow.wait({ left, right });
    const plan = await Effect.runPromise(
      compileWorkflow(terminal, {
        capacity: {
          planConcurrency: 2,
          sessionConcurrency: 2,
          codexConcurrency: 2,
          maxRetries: 0,
          maxCalls: 1,
          costMax: 1,
        },
      }),
    );
    const capacity = await Effect.runPromise(makeCapacityService(plan.capacity));
    const result = await Effect.runPromiseExit(
      runExecutionPlan(plan, 1, {
        capacity,
        services: fixtureServices((assignment) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              calls += 1;
              active += 1;
              maximum = Math.max(maximum, active);
              return assignment;
            }),
            () => Effect.sleep("5 millis").pipe(Effect.as(assignmentResult(assignment))),
            () =>
              Effect.sync(() => {
                active -= 1;
              }),
          ),
        ),
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toBe(1);
    expect(maximum).toBe(1);
  });
});
