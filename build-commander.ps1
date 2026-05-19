param(
    [switch]$KeepBuildArtifacts
)

$ErrorActionPreference = "Stop"

# Build relative to the repo root so the script works from VS Code, PowerShell,
# or a file explorer double-click.
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$companionDir = Join-Path $repoRoot "companion_commander"
$specPath = Join-Path $companionDir "SynchroCommander.spec"
$distPath = Join-Path $companionDir "dist_rebuild"
$workPath = Join-Path $companionDir "build_rebuild"
$finalDistPath = Join-Path $companionDir "dist"
$releasePath = Join-Path $companionDir "release"
$releaseEnvFixPath = Join-Path $companionDir "release_envfix"
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$pythonExe = if (Test-Path $venvPython) { $venvPython } else { "python" }

if (-not (Test-Path $specPath)) {
    throw "Could not find companion_commander\SynchroCommander.spec"
}

Write-Host "Building SynchroCommander from $specPath"

# PyInstaller can trip over stale or locked files, so each build starts from
# fresh temporary output folders.
if (Test-Path $distPath) {
    Remove-Item -LiteralPath $distPath -Recurse -Force
}
if (Test-Path $workPath) {
    Remove-Item -LiteralPath $workPath -Recurse -Force
}

Push-Location $companionDir
try {
    & $pythonExe -m PyInstaller "SynchroCommander.spec" --noconfirm --distpath "dist_rebuild" --workpath "build_rebuild"
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$rebuiltExe = Join-Path $distPath "SynchroCommander.exe"
if (-not (Test-Path $rebuiltExe)) {
    throw "Build finished without producing $rebuiltExe"
}

foreach ($targetDir in @($finalDistPath, $releasePath, $releaseEnvFixPath)) {
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir | Out-Null
    }
    Copy-Item -LiteralPath $rebuiltExe -Destination (Join-Path $targetDir "SynchroCommander.exe") -Force
}

if (-not $KeepBuildArtifacts) {
    if (Test-Path $distPath) {
        Remove-Item -LiteralPath $distPath -Recurse -Force
    }
    if (Test-Path $workPath) {
        Remove-Item -LiteralPath $workPath -Recurse -Force
    }
}

Write-Host "SynchroCommander build complete."
Write-Host "Updated outputs:"
Write-Host "  $finalDistPath\SynchroCommander.exe"
Write-Host "  $releasePath\SynchroCommander.exe"
Write-Host "  $releaseEnvFixPath\SynchroCommander.exe"