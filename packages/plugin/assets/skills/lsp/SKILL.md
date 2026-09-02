---
name: lsp
description: Use when Root assigns code work needing type-aware definitions, references, diagnostics, or rename; query the validated language-server boundary.
---

Owner: Worker. Boundary: use only the configured LSP provider and assigned
scope. An unavailable provider fails closed; do not substitute an unvalidated
tool.

Completion: definitions, references, diagnostics, or bounded rename evidence
is returned with exact paths, or the actionable provider denial is recorded.
