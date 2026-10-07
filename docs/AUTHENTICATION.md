# Authentication

HolyCodex uses the upstream native `codex-login` storage and authentication manager. Its
Sign in with ChatGPT (SIWC) path is a distinct public-client registration, not an alias for
the official Codex application. Browser login begins with `dynamic_agent_client`; OpenAI
issues a per-installation `oaiapp_…` client ID, which is stored with the account/workspace
identity, persistent host ID, granted scopes, and expiry in the existing protected
`auth.json` token record. Token secrets stay in upstream auth storage; SIWC does not add a
proxy or a second credential store.

The SIWC access token is used only for the public OpenAI API resource and only when the
validated grant includes both `resource.invoke` and
`chatgpt.tokens.use.direct`. A requested scope is not treated as a granted scope. The
official Codex client ID is never used as a HolyCodex fallback or refresh identity.
Refresh uses the issued client ID and resource at the official SIWC token endpoint, and
refresh updates are serialized with login/logout and persisted atomically through the
existing auth store.

Sign in using the browser on the machine that owns the registration. Device-code login
is unsupported for SIWC; failure is explicit and does not fall back to official Codex
credentials. Existing official Codex credentials are not silently adopted as HolyCodex
registrations. The provider and client identity remain HolyCodex-branded in the native
login flow.

## Isolated regression check

From PowerShell, run `tests/auth/run-siwc-tests.ps1 -UpstreamPath <upstream-checkout>`.
The script prefers `just test --locked -p codex-login --lib siwc` when Python is usable.
If `python --version` fails because `python` resolves to the WindowsApps launcher rather
than an installed interpreter, it invokes the equivalent upstream Windows recipe directly:

```powershell
$env:RUST_MIN_STACK = '8388608'
$env:NEXTEST_PROFILE = 'local'
cargo +1.95.0 nextest run --no-fail-fast --locked -p codex-login --lib siwc
```

The script scopes `CODEX_HOME`, `RUST_MIN_STACK`, and `NEXTEST_PROFILE` to its process
and restores their prior values in `finally`; its unique home is under this repository's
`.tmp/auth-tests`, never the user's normal Codex home. These tests use local
cryptographic fixtures and serialized-request checks, and never request real user
consent. A live account's direct plan-usage grant can only be confirmed by that account's
completed browser authorization.
