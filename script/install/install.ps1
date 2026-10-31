# MerakCode installer for Windows
#
#   irm https://github.com/{{REPOSITORY}}/releases/latest/download/install.ps1 | iex
#
# Installs into %USERPROFILE%\.merakcode\versions\<version>\ and puts the `merak` command in
# %USERPROFILE%\.merakcode\bin, which is added to the user PATH. Upgrade later with `merak upgrade`.
#
# Environment variables:
#   MERAKCODE_VERSION         version to install (default: latest release)
#   MERAKCODE_INSTALL_DIR     install directory (default: MERAKCODE_HOME, else %USERPROFILE%\.merakcode)
#   MERAKCODE_BIN_DIR         where the commands go (default: <install directory>\bin)
#   MERAKCODE_DOWNLOAD_BASE   download location (default: GitHub Releases; set it to use a mirror)
#   MERAKCODE_NO_MODIFY_PATH  set to 1 to leave the user PATH alone
#
# Keep this file ASCII-only: Windows PowerShell 5.1 does not decode a downloaded script as UTF-8,
# so non-ASCII text turns into garbage and can even break variable names next to it.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repository = "{{REPOSITORY}}"
$root = if ($env:MERAKCODE_INSTALL_DIR) { $env:MERAKCODE_INSTALL_DIR } elseif ($env:MERAKCODE_HOME) { $env:MERAKCODE_HOME } else { Join-Path $HOME ".merakcode" }
$bin = if ($env:MERAKCODE_BIN_DIR) { $env:MERAKCODE_BIN_DIR } else { Join-Path $root "bin" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") { "arm64" } else { "x64" }

# Windows PowerShell 5.1 does not enable TLS 1.2 by default; GitHub requires it
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$version = $env:MERAKCODE_VERSION
if (-not $version) {
  $version = (Invoke-RestMethod "https://api.github.com/repos/$repository/releases/latest").tag_name -replace "^v", ""
}
$base = if ($env:MERAKCODE_DOWNLOAD_BASE) { $env:MERAKCODE_DOWNLOAD_BASE.TrimEnd("/") } else { "https://github.com/$repository/releases/download/v$version" }
$name = "merakcode-$version-windows-$arch"

$work = Join-Path ([IO.Path]::GetTempPath()) ("merakcode-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  Write-Host "Downloading MerakCode $version (windows-$arch)"
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $work "SHA256SUMS") -UseBasicParsing
  Invoke-WebRequest "$base/$name.zip" -OutFile (Join-Path $work "$name.zip") -UseBasicParsing
  $line = Get-Content (Join-Path $work "SHA256SUMS") | Where-Object { $_ -match "  $([regex]::Escape("$name.zip"))$" } | Select-Object -First 1
  if (-not $line) { throw "$name.zip is not listed in SHA256SUMS" }
  $expected = ($line -split "\s+")[0]
  $sha = [Security.Cryptography.SHA256]::Create()
  $archive = [IO.File]::OpenRead((Join-Path $work "$name.zip"))
  try {
    $actual = [BitConverter]::ToString($sha.ComputeHash($archive)).Replace("-", "").ToLowerInvariant()
  } finally {
    $archive.Dispose()
    $sha.Dispose()
  }
  if ($actual -ne $expected) { throw "Checksum mismatch: the download is incomplete or has been tampered with" }

  # The tar.exe that ships with Windows 10+ is much faster than Expand-Archive
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path $tar) {
    & $tar -xf (Join-Path $work "$name.zip") -C $work
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $name.zip" }
  } else {
    Expand-Archive (Join-Path $work "$name.zip") -DestinationPath $work
  }

  $versions = Join-Path $root "versions"
  $target = Join-Path $versions $version
  New-Item -ItemType Directory -Force -Path $versions, $bin | Out-Null
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item (Join-Path $work $name) $target
  # The command forwards to the current version; `merak upgrade` rewrites it the same way
  Set-Content -Path (Join-Path $bin "merak.cmd") -Value "@echo off`r`n`"$target\bin\merak.cmd`" %*" -Encoding ASCII -NoNewline
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

$path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($env:MERAKCODE_NO_MODIFY_PATH -ne "1" -and -not (($path -split ";") -contains $bin)) {
  [Environment]::SetEnvironmentVariable("Path", (@($bin) + ($path -split ";" | Where-Object { $_ })) -join ";", "User")
  Write-Host "Added $bin to your user PATH (takes effect in new terminals)"
}
$env:Path = "$bin;$env:Path"
Write-Host ""
Write-Host "MerakCode $version is installed. Run 'merak --help' to see the commands."
