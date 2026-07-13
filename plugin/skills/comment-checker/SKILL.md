---
name: comment-checker
description: Use when an edit produces a comment-checker warning that must be fixed or explained; do not use for ordinary comments, lint output, or before an edit. Produces a disposition for every blocking warning; unlike programming checks it handles the edit hook only.
---

# Comment Checker

After successful `apply_patch`, `write`, `edit`, `multi_edit`, or `multiedit`, fix or explain any blocking warning before continuing. Non-edit tools are ignored. No MCP tool exists. Missing checker binaries produce no output.
