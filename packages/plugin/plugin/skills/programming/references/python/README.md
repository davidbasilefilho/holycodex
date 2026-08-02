# Python

Preserve toolchain; greenfield prefers `uv`, Python 3.12+, Ruff, basedpyright, pytest. Type public boundaries; parse external data with Pydantic v2/existing schemas. Prefer frozen models, protocols, pathlib, context managers, explicit async ownership/structured concurrency. No `Any`, bare `except`, mutable default, import side effect, silent fallback, blocking async I/O. Use typed errors and `raise ... from`. Test public behavior deterministically; run format/lint, strict types, targeted pytest.
