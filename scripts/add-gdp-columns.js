// add-gdp-columns.js
// Adds GDP input + formula columns to every country sheet in
// ".xlsx files/Population Growth(2).xlsx".
//
// This edits the .xlsx *surgically* at the raw-XML level (via JSZip): it appends
// cells G–K to each data row and leaves every other part — the 440 embedded
// charts, 204 tables/AutoFilters, drawings, styles, shared strings, data
// validations — byte-for-byte untouched. A full-workbook rewrite (e.g. exceljs)
// cannot preserve all that and makes Excel show a "repair" prompt, so we don't
// use one.
//
// Columns added (to the right of the existing population data A–F):
//   G  GDP/cap growth        — INPUT: per-capita growth rate into that Earth Year (percent)
//   H  GDP/cap override ($)  — INPUT (optional): pin an exact per-capita $ for that year
//   I  GDP per Capita ($)    — FORMULA: 2015 anchor (from js/andah-stats.js), compounded backward
//   J  GDP (nominal, $)      — FORMULA: I * Population
//   K  GDP growth (total)    — FORMULA: J(thisYear)/J(olderYear) - 1
//
// Math (rows run newest→oldest; row 2 = 2015):
//   perCap(2015)  = override ?? anchor
//   perCap(Y-1)   = override ?? perCap(Y) / (1 + growth(Y))     [blank growth = 0%]
//
// Always rebuilds from the pristine backup, so it's fully idempotent AND repairs
// a previously-mangled file. NOTE: because it rebuilds from backup, it does NOT
// preserve GDP numbers you typed into the live file — type your growth rates in
// Google Sheets / Excel and keep that as your master; re-run this only to
// (re)generate a clean template.
//
// Usage: node scripts/add-gdp-columns.js

import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
// GDP_OUT lets tests write elsewhere without touching the live workbook.
const XLSX_PATH = process.env.GDP_OUT || path.join(ROOT, '.xlsx files', 'Population Growth(2).xlsx');
const BACKUP_PATH = path.join(ROOT, '.xlsx files', 'Population Growth(2).backup.xlsx');
const STATS_PATH = path.join(ROOT, 'js', 'andah-stats.js');

const SUMMARY_SHEETS = new Set(['GlobalContinent Population', 'Geoscheme Population']);

// Reuse existing styles so we touch zero style definitions:
//   s=2  header text · s=12 number (#,##0) · s=13 percent (0.00%)
const S_HEAD = '2', S_NUM = '12', S_PCT = '13';
const HEADERS = ['GDP/cap growth', 'GDP/cap override ($)', 'GDP per Capita ($)', 'GDP (nominal, $)', 'GDP growth (total)'];

const xesc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loadAnchors() {
  const src = fs.readFileSync(STATS_PATH, 'utf8');
  const stats = new Function(`${src}; return andahStats;`)();
  return new Map(stats.map((s) => [s.name, s.gdpPerNominal]));
}

// Build the five G–K cells for a data row. We embed BOTH the formula and its
// cached value (the initial all-growth-empty state, so per-capita == anchor for
// every year). This makes the file a completely standard .xlsx that shows real
// numbers immediately on open; Excel (fullCalcOnLoad) and Google Sheets recompute
// as soon as a growth rate is typed.
function dataCells(r, lastRow, anchor, popMap) {
  const fI = r === 2
    ? `IF(H2<>"",H2,${anchor})`
    : `IF(H${r}<>"",H${r},I${r - 1}/(1+IF(G${r - 1}="",0,G${r - 1})))`;
  const fJ = `IF(I${r}="","",I${r}*C${r})`;
  const fK = `IFERROR(J${r}/J${r + 1}-1,"")`;

  const pop = popMap.get(r);
  const popOlder = popMap.get(r + 1);
  const vI = anchor;                                   // flat: no growth entered yet
  const vJ = pop != null ? anchor * pop : null;
  const vK = (r < lastRow && pop != null && popOlder) ? pop / popOlder - 1 : null;
  const cache = (v) => (v != null ? `<v>${v}</v>` : '');

  const g = `<c r="G${r}" s="${S_PCT}"/>`;
  const h = `<c r="H${r}" s="${S_NUM}"/>`;
  const i = `<c r="I${r}" s="${S_NUM}"><f>${xesc(fI)}</f>${cache(vI)}</c>`;
  const j = `<c r="J${r}" s="${S_NUM}"><f>${xesc(fJ)}</f>${cache(vJ)}</c>`;
  const k = r < lastRow
    ? `<c r="K${r}" s="${S_PCT}"><f>${xesc(fK)}</f>${cache(vK)}</c>`
    : `<c r="K${r}" s="${S_PCT}"/>`;
  return g + h + i + j + k;
}

function headerCells() {
  return HEADERS.map((text, idx) => {
    const col = 'GHIJK'[idx];
    return `<c r="${col}1" s="${S_HEAD}" t="inlineStr"><is><t>${xesc(text)}</t></is></c>`;
  }).join('');
}

// Strip any pre-existing G–K cells from a row's inner XML (handles stray labels).
function stripGK(inner) {
  return inner
    .replace(/<c r="[G-K]\d+"[^>]*\/>/g, '')
    .replace(/<c r="[G-K]\d+"[^>]*>[\s\S]*?<\/c>/g, '');
}

// Widen the new G–K columns so wide GDP numbers don't show as "####".
const COL_DEFS =
  '<col min="7" max="7" width="13" customWidth="1"/>' +
  '<col min="8" max="8" width="16" customWidth="1"/>' +
  '<col min="9" max="9" width="15" customWidth="1"/>' +
  '<col min="10" max="10" width="20" customWidth="1"/>' +
  '<col min="11" max="11" width="15" customWidth="1"/>';

function editSheet(xml, anchor) {
  // add G–K column widths (existing <cols> only defines columns 1–6)
  xml = xml.replace(/(<cols>[\s\S]*?)<\/cols>/, (m, inner) =>
    inner.includes('min="7"') ? m : inner + COL_DEFS + '</cols>');

  const sdStart = xml.indexOf('<sheetData>');
  const sdEnd = xml.indexOf('</sheetData>');
  if (sdStart === -1 || sdEnd === -1) return { xml, touched: 0 };
  const head = xml.slice(0, sdStart + '<sheetData>'.length);
  const body = xml.slice(sdStart + '<sheetData>'.length, sdEnd);
  const tail = xml.slice(sdEnd);

  // last data row + population per row (cached values from col C)
  const popMap = new Map();
  for (const m of body.matchAll(/<c r="C(\d+)"[^>]*>[\s\S]*?<v>([^<]+)<\/v>[\s\S]*?<\/c>/g)) {
    popMap.set(+m[1], Number(m[2]));
  }
  let lastRow = 0;
  for (const m of body.matchAll(/<c r="C(\d+)"/g)) lastRow = Math.max(lastRow, +m[1]);
  if (lastRow < 2) return { xml, touched: 0 };

  let touched = 0;
  const newBody = body.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (full, rStr, attrs, inner) => {
    const r = +rStr;
    let add = '';
    if (r === 1) add = headerCells();
    else if (r >= 2 && r <= lastRow) add = dataCells(r, lastRow, anchor, popMap);
    else return full; // rows beyond the data block: leave alone
    touched++;
    return `<row r="${r}"${attrs}>${stripGK(inner)}${add}</row>`;
  });

  return { xml: head + newBody + tail, touched };
}

async function main() {
  if (!fs.existsSync(BACKUP_PATH)) {
    // First ever run: the current file is still pristine — snapshot it as the backup.
    if (!fs.existsSync(XLSX_PATH)) { console.error('Workbook not found:', XLSX_PATH); process.exit(1); }
    fs.copyFileSync(XLSX_PATH, BACKUP_PATH);
    console.log('Backup created from current file:', path.basename(BACKUP_PATH));
  }

  const anchors = loadAnchors();
  const zip = await JSZip.loadAsync(fs.readFileSync(BACKUP_PATH)); // always build from the clean backup

  // map sheet name -> worksheet part
  const wbx = await zip.file('xl/workbook.xml').async('string');
  const sheets = [...wbx.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)]
    .map((m) => ({ name: m[1], rid: m[2] }));
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const relmap = {};
  for (const m of rels.matchAll(/<Relationship [^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"[^>]*\/>/g)) relmap[m[1]] = m[2];

  const report = { processed: 0, skipped: [], noAnchor: [], chartsMoved: 0 };
  for (const s of sheets) {
    if (SUMMARY_SHEETS.has(s.name)) { report.skipped.push(s.name); continue; }
    const anchor = anchors.get(s.name);
    if (anchor == null) { report.noAnchor.push(s.name); continue; }
    const part = 'xl/' + relmap[s.rid].replace(/^\//, '');
    const sheetNum = relmap[s.rid].match(/sheet(\d+)\.xml/)[1];
    const xml = await zip.file(part).async('string');
    const { xml: out, touched } = editSheet(xml, anchor);
    if (touched > 0) { zip.file(part, out); report.processed++; }
    else { report.skipped.push(`${s.name} (no data rows)`); continue; }

    // Move this sheet's embedded charts (both anchored at col G=6) rightward to
    // col M=12 so they no longer float over the new G–K input columns. This only
    // repositions the picture; each chart's data series live in xl/charts/* and
    // are untouched.
    const relPart = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    const relFile = zip.file(relPart);
    if (relFile) {
      const rr = await relFile.async('string');
      const dm = rr.match(/drawings\/(drawing\d+\.xml)/);
      if (dm) {
        const dPart = 'xl/drawings/' + dm[1];
        const dxml = await zip.file(dPart).async('string');
        const moved = dxml.replace(/<xdr:from><xdr:col>6<\/xdr:col>/g, '<xdr:from><xdr:col>12</xdr:col>');
        if (moved !== dxml) { zip.file(dPart, moved); report.chartsMoved++; }
      }
    }
  }

  // force Excel to recalc the new formulas on open (Google Sheets always recalcs)
  const wbxOut = wbx.includes('<calcPr')
    ? wbx.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="0" fullCalcOnLoad="1"/>')
    : wbx.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>');
  zip.file('xl/workbook.xml', wbxOut);

  const outBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(XLSX_PATH, outBuf);

  console.log('--- add-gdp-columns (surgical) report ---');
  console.log('Country sheets processed:', report.processed);
  console.log('Skipped:', report.skipped.join(', ') || '(none)');
  console.log('Sheets with no andah-stats anchor:', report.noAnchor.length ? report.noAnchor.join(', ') : '(none)');
  console.log('Sheets whose charts were shifted clear of G–K:', report.chartsMoved);
  console.log('Rebuilt from clean backup; charts/tables/styles preserved untouched.');
  console.log('Saved:', path.basename(XLSX_PATH));
}

main().catch((err) => { console.error(err); process.exit(1); });
