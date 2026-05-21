# Parse a MediaWiki XML dump in mediawiki/ and extract the intro paragraph of
# every Main-namespace page into data/intros.json. Mirrors scripts/extract-intros.js
# (which the Netlify build runs); this PS script exists so local dev without
# Node can still regenerate the file.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/extract-intros.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$mediawikiDir = Join-Path $root 'mediawiki'
$dataDir = Join-Path $root 'data'

if (-not (Test-Path $mediawikiDir)) {
    Write-Warning "No mediawiki/ directory at $mediawikiDir. Nothing to do."
    exit 0
}

$xmlFile = Get-ChildItem -Path $mediawikiDir -Filter '*.xml' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $xmlFile) {
    Write-Warning "No .xml files in mediawiki/. Nothing to do."
    exit 0
}

Write-Host "Reading $($xmlFile.FullName)..."
$xml = [System.IO.File]::ReadAllText($xmlFile.FullName)

function Get-Tag {
    param([string]$Block, [string]$Tag)
    $open = "<$Tag>"
    $close = "</$Tag>"
    $i = $Block.IndexOf($open)
    if ($i -lt 0) { return $null }
    $j = $Block.IndexOf($close, $i)
    if ($j -lt 0) { return $null }
    $val = $Block.Substring($i + $open.Length, $j - $i - $open.Length)
    return (Decode-Entities $val)
}

function Get-LatestText {
    param([string]$Block)
    $re = [regex]'<text[^>]*xml:space="preserve">([\s\S]*?)</text>'
    $matches = $re.Matches($Block)
    if ($matches.Count -eq 0) { return '' }
    return (Decode-Entities $matches[$matches.Count - 1].Groups[1].Value)
}

function Decode-Entities {
    param([string]$S)
    return $S `
        -replace '&lt;', '<' `
        -replace '&gt;', '>' `
        -replace '&quot;', '"' `
        -replace '&apos;', "'" `
        -replace '&nbsp;', ' ' `
        -replace '&amp;', '&'
}

function To-Slug {
    param([string]$Name)
    $s = $Name.Trim().ToLowerInvariant() -replace '\s+', '-'
    $s = $s -replace '[^a-z0-9\-]', ''
    return $s
}

function Extract-Intro {
    param([string]$Wikitext)
    if (-not $Wikitext) { return '' }
    if ($Wikitext -match '^\s*#REDIRECT') { return '' }

    $text = $Wikitext

    # Strip refs and comments first (refs may contain templates).
    $text = [regex]::Replace($text, '<ref[^>]*/>', '')
    $text = [regex]::Replace($text, '<ref\b[^>]*>[\s\S]*?</ref>', '')
    $text = [regex]::Replace($text, '<!--[\s\S]*?-->', '')

    # Strip templates iteratively from inside out.
    $prev = $null
    $guard = 0
    while ($text -ne $prev -and $guard -lt 20) {
        $prev = $text
        $text = [regex]::Replace($text, '\{\{[^{}]*\}\}', '')
        $guard++
    }

    # Cut at the first heading.
    $hMatch = [regex]::Match($text, '^==', 'Multiline')
    if ($hMatch.Success) { $text = $text.Substring(0, $hMatch.Index) }

    # Magic words.
    $text = [regex]::Replace($text, '__[A-Z]+__', '')

    # Links.
    $text = [regex]::Replace($text, '\[\[([^\]\|]+)\|([^\]]+)\]\]', '$2')
    $text = [regex]::Replace($text, '\[\[([^\]]+)\]\]', '$1')

    # External links.
    $text = [regex]::Replace($text, '\[https?://\S+\s+([^\]]+)\]', '$1')
    $text = [regex]::Replace($text, '\[(https?://\S+)\]', '$1')

    # Bold/italic markers.
    $text = [regex]::Replace($text, "'{2,5}", '')

    # Leftover HTML tags.
    $text = [regex]::Replace($text, '</?[^>]+>', '')

    # Leftover table/pipe rows.
    $text = [regex]::Replace($text, '^\s*\|[^\r\n]*\r?\n', '', 'Multiline')

    # First non-empty paragraph.
    $paragraphs = ($text -split "(\r?\n){2,}") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    if (-not $paragraphs) { return '' }
    $first = $paragraphs[0]

    # Collapse whitespace.
    return ([regex]::Replace($first, '\s+', ' ')).Trim()
}

# Split into <page>...</page> blocks (regex is fine on this dump format).
$pageRe = [regex]'<page>([\s\S]*?)</page>'
$blocks = $pageRe.Matches($xml)
Write-Host "Found $($blocks.Count) <page> blocks."

$intros = New-Object System.Collections.Generic.List[object]
$counter = 0
foreach ($m in $blocks) {
    $counter++
    $block = $m.Groups[1].Value
    $ns = Get-Tag -Block $block -Tag 'ns'
    if ($ns -ne '0') { continue }
    $title = Get-Tag -Block $block -Tag 'title'
    if (-not $title) { continue }
    $wikitext = Get-LatestText -Block $block
    $intro = Extract-Intro -Wikitext $wikitext
    if (-not $intro) { continue }
    $intros.Add([pscustomobject]@{
        slug  = To-Slug $title
        title = $title
        intro = $intro
    })
}

$intros = $intros | Sort-Object title

if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$out = [pscustomobject]@{
    generatedAt = (Get-Date).ToString('o')
    source      = $xmlFile.Name
    pages       = $intros
}

# ConvertTo-Json with depth so the nested pages array serializes fully.
$json = $out | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $dataDir 'intros.json'), $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "Wrote $($intros.Count) intros to data/intros.json."
