// SPDX-License-Identifier: Apache-2.0

import {
  compileWorkflow,
  createCodec,
  workflow,
  type Assignment,
  type NamedWaitResult,
  type ValueCodec,
  type Wait,
} from "./index.ts";

const numberCodec = createCodec("fixture-number", (value: unknown): number => {
  if (typeof value !== "number") {
    throw new Error("fixture number expected");
  }
  return value;
});

const stringCodec = createCodec("fixture-string", (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("fixture string expected");
  }
  return value;
});

const pairCodec = createCodec(
  "fixture-pair",
  (value: unknown): { readonly left: number; readonly right: number } => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("left" in value) ||
      !("right" in value) ||
      typeof value.left !== "number" ||
      typeof value.right !== "number"
    ) {
      throw new Error("fixture pair expected");
    }
    return { left: value.left, right: value.right };
  },
);

function assignment<I, O>(
  input: ValueCodec<I>,
  output: ValueCodec<O>,
  payload: unknown = undefined,
): Assignment<I, O> {
  return { input, output, payload };
}

const increment = workflow.step({
  id: "fixture-increment",
  assignment: assignment<number, number>(numberCodec, numberCodec),
});
const render = workflow.step({
  id: "fixture-render",
  assignment: assignment<number, string>(numberCodec, stringCodec),
});
const takesText = workflow.step({
  id: "fixture-takes-text",
  assignment: assignment<string, number>(stringCodec, numberCodec),
});

const sequential = workflow.queue(increment, render);
const callbackSequential = workflow.queue(increment, (value) =>
  workflow.step({
    id: "fixture-callback-render",
    assignment: {
      payload: { previous: value },
      input: numberCodec,
      output: stringCodec,
    },
  }),
);
const sixStages = workflow.queue(increment, render, takesText, increment, render, (value) =>
  workflow.step({
    id: "fixture-sixth",
    assignment: {
      payload: value,
      input: stringCodec,
      output: stringCodec,
    },
  }),
);
const sequentialWait = workflow.wait(sequential);
const callbackWait = workflow.wait(callbackSequential);
const sixStageWait = workflow.wait(sixStages);
const sequentialShape: Wait<number, string> = sequentialWait;
const callbackShape: Wait<number, string> = callbackWait;
const sixStageShape: Wait<number, string> = sixStageWait;

const numberRun = workflow.start(increment);
const namedWait = workflow.wait({ number: numberRun, text: render });
type ExpectedNamed = { readonly number: number; readonly text: string };
const namedShape: Wait<number, ExpectedNamed> = namedWait;
const namedResult: NamedWaitResult<{
  readonly number: typeof numberRun;
  readonly text: typeof render;
}> = namedShape.result;
void sequentialShape;
void callbackShape;
void sixStageShape;
void namedResult;
void compileWorkflow;

const joinedLeft = workflow.step({
  id: "fixture-joined-left",
  assignment: assignment<number, number>(numberCodec, numberCodec),
});
const joinedRight = workflow.step({
  id: "fixture-joined-right",
  assignment: assignment<number, number>(numberCodec, numberCodec),
});
const joined = workflow.wait({ left: joinedLeft, right: joinedRight });
const joinedQueue = workflow.queue(
  increment,
  () => joined,
  (aggregate) =>
    workflow.step({
      id: "fixture-joined-next",
      assignment: {
        payload: aggregate,
        input: pairCodec,
        output: numberCodec,
      },
    }),
);
const joinedShape: Wait<number, number> = workflow.wait(joinedQueue);
void joinedShape;

workflow.step({
  id: "fixture-callback-rejected",
  // @ts-expect-error Assignment callbacks are not public workflow effects.
  assignment: (value: number) => value + 1,
});

// @ts-expect-error The second stage must consume the first stage output.
workflow.queue(render, increment);

// @ts-expect-error A started run must be closed by workflow.wait before compilation.
compileWorkflow(workflow.start(increment));

// @ts-expect-error workflow.start accepts exactly one workflow declaration.
workflow.start(increment, render);

// @ts-expect-error workflow.wait only accepts a workflow, run, or named mixture.
workflow.wait({ invalid: joinedShape });

// @ts-expect-error Named waits share one compatible root input type.
workflow.wait({ number: numberRun, textInput: workflow.start(takesText) });
