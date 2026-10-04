param(
    [Parameter(Mandatory = $true)]
    [string] $UpstreamPath
)

$ErrorActionPreference = 'Stop'
$upstreamRoot = (Resolve-Path -LiteralPath $UpstreamPath).Path
$manifestPath = Join-Path $upstreamRoot 'codex-rs/Cargo.toml'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Upstream Cargo manifest not found: $manifestPath"
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$isolatedHome = Join-Path $repoRoot ('.tmp/auth-tests/' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $isolatedHome -Force | Out-Null

$hadCodexHome = Test-Path Env:CODEX_HOME
$previousCodexHome = $env:CODEX_HOME
$hadRustMinStack = Test-Path Env:RUST_MIN_STACK
$previousRustMinStack = $env:RUST_MIN_STACK
$hadNextestProfile = Test-Path Env:NEXTEST_PROFILE
$previousNextestProfile = $env:NEXTEST_PROFILE
$exitCode = 0
try {
    $env:CODEX_HOME = $isolatedHome
    $env:RUST_MIN_STACK = '8388608'
    $env:NEXTEST_PROFILE = 'local'
    Push-Location (Join-Path $upstreamRoot 'codex-rs')
    try {
        $python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue
        $justCommand = Get-Command just -CommandType Application -ErrorAction SilentlyContinue
        $pythonAvailable = $false
        if ($python) {
            & $python.Source --version *> $null
            $pythonAvailable = $LASTEXITCODE -eq 0
        }

        if ($pythonAvailable -and $justCommand) {
            & $justCommand.Source test --locked -p codex-login --lib siwc
            $exitCode = $LASTEXITCODE
        }
        else {
            if (-not $pythonAvailable) {
                Write-Host 'Python is unavailable (the WindowsApps launcher is not an interpreter).'
            }
            else {
                Write-Host 'just is unavailable.'
            }
            Write-Host 'Using the upstream Windows just test recipe directly:'
            Write-Host 'RUST_MIN_STACK=8388608 NEXTEST_PROFILE=local cargo +1.95.0 nextest run --no-fail-fast --locked -p codex-login --lib siwc'
            cargo +1.95.0 nextest run --no-fail-fast --locked -p codex-login --lib siwc
            $exitCode = $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($hadCodexHome) {
        $env:CODEX_HOME = $previousCodexHome
    }
    else {
        Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue
    }
    if ($hadRustMinStack) {
        $env:RUST_MIN_STACK = $previousRustMinStack
    }
    else {
        Remove-Item Env:RUST_MIN_STACK -ErrorAction SilentlyContinue
    }
    if ($hadNextestProfile) {
        $env:NEXTEST_PROFILE = $previousNextestProfile
    }
    else {
        Remove-Item Env:NEXTEST_PROFILE -ErrorAction SilentlyContinue
    }
}

exit $exitCode
