# Python

Preserve workspace toolchain; greenfield prefers `uv`, Python 3.12+, Ruff, basedpyright, pytest. Type every public boundary. Parse external data with Pydantic v2 or existing schema layer. Prefer frozen dataclasses/models, protocols, pathlib, context managers, explicit async ownership, structured concurrency. No `Any`, bare `except`, mutable default, import side effect, silent fallback, or blocking I/O in async path. Use typed domain errors; preserve causes with `raise ... from`. Test public behavior with deterministic fixtures. Run formatter/lint, strict typecheck, targeted pytest.
