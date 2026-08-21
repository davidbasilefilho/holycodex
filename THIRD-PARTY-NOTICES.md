# Third-party notices

This file records attribution and license text for the dependency files
installed by Bun for this workspace. It is informational and does not make a
legal guarantee about any distribution, compatibility, security property, or
license interpretation. Package/source metadata is also summarized in
[DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Runtime components

The following installed runtime packages are MIT-licensed:

- `effect` 3.22.1
- `quickjs-emscripten` 0.32.0
- `quickjs-emscripten-core` 0.32.0
- `@jitl/quickjs-ffi-types` 0.32.0
- `@jitl/quickjs-wasmfile-debug-asyncify` 0.32.0
- `@jitl/quickjs-wasmfile-debug-sync` 0.32.0
- `@jitl/quickjs-wasmfile-release-asyncify` 0.32.0
- `@jitl/quickjs-wasmfile-release-sync` 0.32.0

The `quickjs-emscripten`, `quickjs-emscripten-core`, and FFI package files
carry the first MIT section below. Each of the four Wasm package files carries
that section followed by the QuickJS engine attribution. The consolidated text
below reproduces both sections from those installed files:

```text
The MIT License

quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


quickjs:
QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`typescript` 7.0.2 is a runtime dependency of `workflow-runtime` and is
Apache-2.0 licensed by Microsoft Corp. Its installed license is the Apache
License, Version 2.0, which is distributed in full as the repository
[LICENSE](LICENSE). The platform package resolved for Linux x64 carries the
same license and an installed `NOTICE.txt` identifying DefinitelyTyped,
Unicode, and DOM notices; the platform selection is lockfile- and platform-
dependent.

## Development-only components

These packages are used for repository tooling and type checking, not by the
published runtime dependency graph:

- `vite-plus` 0.2.9 — MIT, [source repository](https://github.com/voidzero-dev/vite-plus).
  Its installed `LICENSE` also enumerates bundled MIT, ISC, and BlueOak
  components for the development CLI.
- `@types/bun` resolved with `bun-types` 1.4.0 — MIT, [Bun source repository](https://github.com/oven-sh/bun).

The development-only distinction is intentional: their notices explain the
toolchain used to develop and verify HolyCodex and do not imply that Vite+ or
Bun type declarations are bundled into the runtime payload. See the installed
package files and `bun.lock` when a platform-specific attribution needs to be
refreshed.

## Generated App Server artifacts

The files under `packages/codex/generated/codex-cli-0.148.0/` are generated
protocol artifacts, not third-party packages and not a new license assertion.
Their executable identity, 943-file inventory, SHA-256 digests, protocol epoch,
and capability limits are recorded in
[PROVENANCE.md](docs/PROVENANCE.md#generated-artifact). The local artifact
records `multi_agent_v2` as disabled with an unverified distinct lifecycle;
advertised V2 fails closed and the stable fallback remains the executable
route.
