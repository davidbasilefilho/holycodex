# Repository directives

## Interaction

- Be direct, succinct, and objective. Use sections for complex responses and brief answers for simple requests.
- Favor headings over lists. Nest lists only when details require it.
- Do not use em dashes. Restructure the sentence.
- Trust user knowledge. Research unfamiliar concepts and verify current libraries, tools, features, and breaking changes before implementation.

## Code

- Produce minimal, readable, performant code. Reuse one shared implementation instead of duplicating behavior.
- Use descriptive names. Avoid inline comments unless logic is mathematical, cryptographic, or otherwise non-obvious.
- Add concise JSDoc to every exposed or public function and method, plus complex or non-obvious private logic.
- Name repeated or domain-significant numeric and string literals. Ordinary one-use values, protocol keys, and clear schema literals may remain inline.
- Prefer overloaded getter-setter functions for stateful APIs when `fn()` to read and `fn(value)` to write gives the clearest interface.
- Prioritize seamless developer experience and high-fidelity, accessible UI/UX where applicable.
- Degrade gracefully where recovery is possible. Return clear, actionable errors and use the project logger for diagnostic events.
- Favor built-in language features, efficient algorithms, and repository-wide style consistency.
- Keep the entire codebase and every published runtime compatible with both Node.js and Bun. Do not rely on runtime-specific APIs without a tested portable fallback.

## Safety and verification

- Use Vite+ for formatting, linting, and type checking. Before finishing every task, run `vp check --fix` and fix every reported error. Do not use Prettier directly.
- Do not run dev servers or compile/build commands. Do not invoke package scripts that compile or build as a side effect.
- Targeted tests that do not invoke a compile/build script are allowed.
- Do not perform irreversible actions without explicit user confirmation.
- Do not commit or push unless explicitly requested. When requested, split large changes into logical commits with clear messages.

## Durable implementation notes

- Append durable findings to `.agents/NOTES.md` when work ports another project, integrates external systems or protocols, adapts behavior across incompatible runtimes, or requires inspection of another repository or project.
- Record source and revision, relevant constraints, chosen adaptation, rejected alternatives, compatibility or licensing obligations, and reusable verification findings.
- Keep notes factual and durable. Do not use the file as a task log or duplicate information obvious from code.
