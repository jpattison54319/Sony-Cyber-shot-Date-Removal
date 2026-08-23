$ErrorActionPreference = "Stop"

$DesktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ModelPath = Join-Path $DesktopRoot "models\big-lama.pt"
$SpecPath = Join-Path $DesktopRoot "DateStampCleaner.spec"
$WorkflowPath = Join-Path (Split-Path $DesktopRoot -Parent) "reference\python-workflow"
if (-not (Test-Path $SpecPath) -or -not (Test-Path $WorkflowPath)) {
    throw "Refusing to build outside the Date Stamp Cleaner source tree."
}
$AppVersion = if ($env:DATE_STAMP_APP_VERSION) { $env:DATE_STAMP_APP_VERSION.TrimStart("v") } else { "0.1.0" }
$env:DATE_STAMP_APP_VERSION = $AppVersion

python (Join-Path $DesktopRoot "scripts\fetch_model.py") --output $ModelPath
python (Join-Path $DesktopRoot "scripts\generate_icons.py")

Remove-Item (Join-Path $DesktopRoot "build") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DesktopRoot "dist") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DesktopRoot "release") -Recurse -Force -ErrorAction SilentlyContinue
New-Item (Join-Path $DesktopRoot "release") -ItemType Directory -Force | Out-Null

$env:DATE_STAMP_MODEL_PATH = $ModelPath
pyinstaller `
  --noconfirm `
  --clean `
  --workpath (Join-Path $DesktopRoot "build") `
  --distpath (Join-Path $DesktopRoot "dist") `
  $SpecPath

& (Join-Path $DesktopRoot "dist\Date Stamp Cleaner\Date Stamp Cleaner.exe") --self-check
if ($LASTEXITCODE -ne 0) {
    throw "The packaged application self-check failed."
}

$Iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $Iscc)) {
    throw "Inno Setup 6 was not found."
}
& $Iscc (Join-Path $DesktopRoot "installer\windows.iss")

Get-FileHash (Join-Path $DesktopRoot "release\DateStampCleaner-Windows-x64-Setup.exe") -Algorithm SHA256
