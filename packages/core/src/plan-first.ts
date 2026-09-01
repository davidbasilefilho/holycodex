// SPDX-License-Identifier: Apache-2.0

export type PlanFirstPhase = "planning" | "implementation";

/** Shared execution state for the conversational plan-first boundary. */
export class PlanFirstExecutionGate {
  #phase: PlanFirstPhase;

  constructor(phase: PlanFirstPhase = "implementation") {
    this.#phase = phase;
  }

  get phase(): PlanFirstPhase {
    return this.#phase;
  }

  enterPlanning(): void {
    this.#phase = "planning";
  }

  authorizeContinuation(): void {
    this.#phase = "implementation";
  }

  assertMutationAllowed(): void {
    if (this.#phase === "planning") {
      throw new PlanFirstGateError(
        "Plan-first mode is read-only until an explicit continuation authorizes implementation.",
      );
    }
  }

  assertDispatchAllowed(): void {
    this.assertMutationAllowed();
  }
}

export class PlanFirstGateError extends Error {
  readonly code = "plan_first_locked" as const;

  constructor(message: string) {
    super(message);
    this.name = "PlanFirstGateError";
  }
}
