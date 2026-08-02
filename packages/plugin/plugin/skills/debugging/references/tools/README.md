# Tool choice

- Playwright: deterministic browser flow; console/network/DOM/screenshot proof.
- GDB/pwndbg: native crash, registers, stack, memory, heap; authorized local target only.
- Ghidra: static binary flow without source; pair with runtime proof when possible.
- pwntools: bounded, timed local protocol/process PoC; never destructive/third-party.

Use least-invasive falsifier; record command/version and keep a safe reproducer.
