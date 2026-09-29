param([int]$Port = 4317)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Choose a port between 1024 and 65535.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 20 or newer, then reopen PowerShell.' }
if (-not $env:SIMCC_CODEX_BIN) {
    $cliCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($cliCommand) {
        $env:SIMCC_CODEX_BIN = $cliCommand.Source
    } else {
        $bundleDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        if (Test-Path -LiteralPath $bundleDirectory) {
            $cliCandidate = Get-ChildItem -LiteralPath $bundleDirectory -Filter codex.exe -Recurse -File |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($cliCandidate) { $env:SIMCC_CODEX_BIN = $cliCandidate.FullName }
        }
    }
}
$env:SIMCC_PORT = [string]$Port
Write-Host ('Open http://127.0.0.1:' + $Port + ' in your browser. Keep this terminal open.')
Write-Host 'Recorded mode works without API keys. Live providers use your configured account.'
& $nodeCommand.Source (Join-Path $PSScriptRoot 'server.mjs')
exit $LASTEXITCODE
