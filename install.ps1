# Install routr on Windows: one standalone binary (no Node, no Bun) plus the routr skill for your agents.
#   irm https://raw.githubusercontent.com/sirkirby/routr/main/install.ps1 | iex
# Settings: $env:ROUTR_INSTALL_DIR (default ~\.local\bin), $env:ROUTR_VERSION (default: latest release).
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the progress bar makes Invoke-WebRequest many times slower in Windows PowerShell
$dir = if ($env:ROUTR_INSTALL_DIR) { $env:ROUTR_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }
$asset = "routr-windows-x64.exe"
$base = if ($env:ROUTR_VERSION) { "https://github.com/sirkirby/routr/releases/download/v$($env:ROUTR_VERSION.TrimStart('v'))" } else { "https://github.com/sirkirby/routr/releases/latest/download" }
if ($env:ROUTR_DOWNLOAD_BASE) { $base = $env:ROUTR_DOWNLOAD_BASE }   # for testing against a local server

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("routr-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "routr: downloading $asset"
  Invoke-WebRequest "$base/$asset" -OutFile "$tmp\$asset" -UseBasicParsing
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$tmp\SHA256SUMS" -UseBasicParsing
  $want = (Get-Content "$tmp\SHA256SUMS" | Where-Object { $_ -match " $([regex]::Escape($asset))$" }) -replace " .*", ""
  $got = (Get-FileHash "$tmp\$asset" -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw "routr: checksum mismatch for $asset; nothing was installed" }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Move-Item -Force "$tmp\$asset" "$dir\routr.exe"
  $version = & "$dir\routr.exe" --version
  Write-Host "routr: installed $version to $dir\routr.exe"
  & "$dir\routr.exe" skill install | Out-Null
  Write-Host "routr: skill installed to ~\.agents\skills\routr"
  if (($env:PATH -split ";") -notcontains $dir) { Write-Host "routr: add $dir to your PATH so agents can run ``routr``" }
  Write-Host "routr: next, run: routr setup   (or ask your coding agent to ""set up routr"")"
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
