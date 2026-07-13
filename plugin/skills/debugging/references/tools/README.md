# Tool choice

- Playwright: deterministic browser flow, console/network/DOM/screenshot evidence.
- GDB/pwndbg: native crash, registers, stack, memory, heap; local authorized target only.
- Ghidra: static binary control/data flow when source absent; pair claims with runtime proof when possible.
- pwntools: local protocol/process PoC with bounded input and timeout; never destructive or third-party.

Use least invasive tool that falsifies a hypothesis. Record exact command/version and preserve a safe reproducer.
