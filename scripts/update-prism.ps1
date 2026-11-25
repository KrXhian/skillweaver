param(
  [string]$PrismVersion = "1.29.0"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$outFile = Join-Path $repoRoot "ui\vendor\prism.min.js"
$outDir = Split-Path -Parent $outFile
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$baseUrl = "https://cdn.jsdelivr.net/npm/prismjs@$PrismVersion/components/"
$components = @(
  "prism-core.min.js",
  "prism-markup.min.js",
  "prism-css.min.js",
  "prism-clike.min.js",
  "prism-regex.min.js",
  "prism-javascript.min.js",
  "prism-typescript.min.js",
  "prism-jsx.min.js",
  "prism-tsx.min.js",
  "prism-python.min.js",
  "prism-rust.min.js",
  "prism-sql.min.js",
  "prism-json.min.js",
  "prism-bash.min.js",
  "prism-powershell.min.js",
  "prism-yaml.min.js",
  "prism-toml.min.js",
  "prism-markdown.min.js",
  "prism-c.min.js",
  "prism-cpp.min.js",
  "prism-csharp.min.js",
  "prism-java.min.js",
  "prism-go.min.js",
  "prism-docker.min.js",
  "prism-diff.min.js"
)

$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine("/*")
[void]$sb.AppendLine(" * PrismJS $PrismVersion (MIT License) - https://prismjs.com/")
[void]$sb.AppendLine(" * Offline single-file bundle for Skillweaver.")
[void]$sb.AppendLine(" * Regenerate via: .\scripts\update-prism.ps1")
[void]$sb.AppendLine(" */")

foreach ($component in $components) {
  $resp = Invoke-WebRequest -Uri ($baseUrl + $component) -UseBasicParsing -TimeoutSec 20
  if ($resp.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($resp.Content)) {
    throw "Failed to fetch $component from $baseUrl"
  }
  $clean = $resp.Content.Trim().TrimEnd(";") + ";"
  [void]$sb.AppendLine($clean)
}

[System.IO.File]::WriteAllText($outFile, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
$info = Get-Item $outFile
Write-Output ("Updated ui/vendor/prism.min.js (" + $info.Length + " bytes, " + $components.Count + " components)")
