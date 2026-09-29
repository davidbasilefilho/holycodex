---
name: dev-server
description: Use when a shared background development server is needed; let Root start, reuse, and manage one server for the session.
---

Root only. Reuse a healthy server for the current project; otherwise start the
repository's development command in the background using the active runtime's
process controls. Confirm readiness, return its URL, and share the URL with
specialists so they reuse it. Root retains the process handle. Keep it alive
across Assignments; restart only when configuration or server state requires
it. Stop only the process owned by this session when
no longer needed. Specialists request server changes through their terminal
report rather than starting competing servers.
