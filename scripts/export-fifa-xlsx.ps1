# Dump andah-fifa-data.js to .xlsx files/worldbuilding_fifa_rankings_with_debuff.xlsx
# so the spreadsheet matches the in-code rankings used by world-cup.html.
#
# Builds the .xlsx file directly (OOXML = zip of XML parts) so it works on
# machines without Excel or any Office automation library installed.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/export-fifa-xlsx.ps1

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$jsPath = Join-Path $root 'js\andah-fifa-data.js'
$xlsxDir = Join-Path $root '.xlsx files'
$xlsxPath = Join-Path $xlsxDir 'worldbuilding_fifa_rankings_with_debuff.xlsx'

Write-Host "Reading $jsPath..."
$raw = Get-Content $jsPath -Raw -Encoding UTF8

# Strip the JS variable declaration so the array is valid JSON.
$json = $raw -replace '^\s*const\s+\w+\s*=\s*', ''
$json = $json -replace ';\s*$', ''
$data = $json | ConvertFrom-Json
Write-Host "Loaded $($data.Count) teams."

if (-not (Test-Path $xlsxDir)) {
    New-Item -ItemType Directory -Path $xlsxDir | Out-Null
}

$columns = @(
    @{ key = 'rank';           type = 'n' },
    @{ key = 'name';           type = 's' },
    @{ key = 'continent';      type = 's' },
    @{ key = 'adjustedPoints'; type = 'n' },
    @{ key = 'population';     type = 'n' },
    @{ key = 'sportEarth';     type = 's' },
    @{ key = 'debuff';         type = 'n' }
)

function Xml-Escape {
    param([string]$s)
    if ($null -eq $s) { return '' }
    return ([System.Security.SecurityElement]::Escape($s))
}

function Column-Letter {
    param([int]$index)  # 1-based
    $s = ''
    while ($index -gt 0) {
        $rem = ($index - 1) % 26
        $s = ([char](65 + $rem)).ToString() + $s
        $index = [int][Math]::Floor(($index - 1) / 26)
    }
    return $s
}

# ── Build sheet1.xml ──
$rowsXml = New-Object System.Text.StringBuilder
[void]$rowsXml.Append('<row r="1">')
for ($i = 0; $i -lt $columns.Count; $i++) {
    $ref = (Column-Letter ($i + 1)) + '1'
    $label = Xml-Escape $columns[$i].key
    [void]$rowsXml.Append("<c r=""$ref"" t=""inlineStr"" s=""1""><is><t>$label</t></is></c>")
}
[void]$rowsXml.Append('</row>')

$rowIdx = 2
$sorted = $data | Sort-Object rank
foreach ($team in $sorted) {
    [void]$rowsXml.Append("<row r=""$rowIdx"">")
    for ($i = 0; $i -lt $columns.Count; $i++) {
        $col = $columns[$i]
        $ref = (Column-Letter ($i + 1)) + $rowIdx
        $value = $team.($col.key)
        if ($col.type -eq 'n') {
            if ($null -eq $value -or $value -eq '') {
                [void]$rowsXml.Append("<c r=""$ref""/>")
            } else {
                # Use InvariantCulture so decimals are written with a dot.
                $num = [Convert]::ToDouble($value, [System.Globalization.CultureInfo]::InvariantCulture)
                $numStr = $num.ToString([System.Globalization.CultureInfo]::InvariantCulture)
                [void]$rowsXml.Append("<c r=""$ref""><v>$numStr</v></c>")
            }
        } else {
            $text = Xml-Escape ([string]$value)
            [void]$rowsXml.Append("<c r=""$ref"" t=""inlineStr""><is><t xml:space=""preserve"">$text</t></is></c>")
        }
    }
    [void]$rowsXml.Append('</row>')
    $rowIdx++
}

$lastCol = Column-Letter $columns.Count
$lastRow = $rowIdx - 1
$dimensionRef = "A1:${lastCol}${lastRow}"

$sheetXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="$dimensionRef"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>$($rowsXml.ToString())</sheetData>
</worksheet>
"@

# ── Other OOXML parts ──
$contentTypesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>
'@

$rootRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
'@

$workbookXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="FIFA Rankings" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>
'@

$workbookRelsXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
'@

# Minimal styles.xml with two cellXfs: 0 = default, 1 = bold (for header).
$stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>
'@

# ── Write zip ──
if (Test-Path $xlsxPath) { Remove-Item $xlsxPath -Force }

$fs = [System.IO.File]::Create($xlsxPath)
try {
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        function Add-Entry {
            param($archive, [string]$name, [string]$content)
            $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
            $writer = New-Object System.IO.StreamWriter($entry.Open(), [System.Text.UTF8Encoding]::new($false))
            try { $writer.Write($content) } finally { $writer.Dispose() }
        }

        Add-Entry $zip '[Content_Types].xml' $contentTypesXml
        Add-Entry $zip '_rels/.rels' $rootRelsXml
        Add-Entry $zip 'xl/workbook.xml' $workbookXml
        Add-Entry $zip 'xl/_rels/workbook.xml.rels' $workbookRelsXml
        Add-Entry $zip 'xl/styles.xml' $stylesXml
        Add-Entry $zip 'xl/worksheets/sheet1.xml' $sheetXml
    } finally {
        $zip.Dispose()
    }
} finally {
    $fs.Dispose()
}

Write-Host "Wrote XLSX: $xlsxPath"
Write-Host "Rows: $($data.Count) teams, $($columns.Count) columns."
