---
name: context7-cli
description: Use when a current library, framework, SDK, or API fact needs authoritative documentation.
---

Use current authoritative documentation before relying on memory. Return the
requested versions, behavior, dates, conflicts, and coverage limits with
source locators. Do not turn an external fact into an architecture decision.

Root dispatches this procedure to `Librarian.lookup` or `Librarian.research`
through a bounded Assignment; Root does not perform current-source research
locally.
