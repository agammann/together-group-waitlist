$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeExecutable = (Get-Command node -ErrorAction SilentlyContinue).Source
$packageRunner = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
if (-not $nodeExecutable) { throw 'Install Node.js 24 LTS, then run this script again.' }
if (-not $packageRunner) {
    $bundledRunner = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (Test-Path -LiteralPath $bundledRunner) { $packageRunner = $bundledRunner }
    else { throw 'Install pnpm with npm install -g pnpm, then run this script again.' }
}
if (-not (Test-Path -LiteralPath 'node_modules\vite\bin\vite.js')) {
    & $packageRunner install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& $nodeExecutable 'node_modules\vite\bin\vite.js' build
if ($LASTEXITCODE -ne 0) { throw 'The build failed.' }
& $nodeExecutable --env-file-if-exists=.env server.mjs
