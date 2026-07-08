// _fix_gdp_growth_percent.cjs
// Make column G ("GDP/cap growth") accept a WHOLE-percent number: type 2.5 -> 2.5%
// (instead of Excel's percentage cell turning 2.5 into 250%).
//
// Surgical, zip-level edit of the LIVE workbook — leaves tables, drawings, shared
// strings, and every other sheet byte-untouched. Steps:
//   1. styles.xml: add numFmt 166 = 0.00"%"  (literal % sign, NO x100 scaling)
//                  add a new cellXf (clone of s=11) using that fmt -> new index NEW_S
//   2. On each GDP country sheet (gated by the signature per-capita formula):
//        a. every G growth cell  s="11" -> s="NEW_S"
//        b. any existing G value (a fraction) x100 so 0.0269 -> 2.69 (still 2.69%)
//        c. master formula  I2/(1+IF(G2="",0,G2))  ->  .../100)  (shared deps inherit)
//   K cells (also s=11, a real percent output) are left ALONE — only r="G.." touched.

const JSZip = require('jszip');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '.xlsx files');
const SRC = path.join(DIR, 'Population Growth(2).xlsx');
const BACKUP = path.join(DIR, 'Population Growth(2) (pre-percent-fix backup).xlsx');

const OLD_S = '11';                 // existing G/K style: numFmtId 10 = 0.00%
const NEW_S = '28';                 // new style index (current cellXfs count = 28)
// Column I is split into SEVERAL shared-formula groups (si=5 I3:I34, si=8 I35:I66, …),
// each with its own literal master  I{n}/(1+IF(G{n}="",0,G{n})).  Patch EVERY one.
const SIG_RE = /I(\d+)\/\(1\+IF\(G\1="",0,G\1\)\)/g;
const SIG_FIXED = 'I$1/(1+IF(G$1="",0,G$1)/100)';
const round = (n) => Number(n.toFixed(10));  // kill FP dust from x100

async function main() {
  // Preserve the pristine pre-fix backup; never clobber it on a rerun.
  if (!fs.existsSync(BACKUP)) {
    fs.writeFileSync(BACKUP, fs.readFileSync(SRC));
    console.log('Backup written:', path.basename(BACKUP));
  } else {
    console.log('Backup already exists — rebuilding SRC from it (idempotent).');
    fs.writeFileSync(SRC, fs.readFileSync(BACKUP));
  }
  const buf = fs.readFileSync(SRC);

  const zip = await JSZip.loadAsync(buf);

  // --- 1. styles.xml -------------------------------------------------------
  let styles = await zip.file('xl/styles.xml').async('string');

  if (!styles.includes('numFmtId="166"')) {
    styles = styles
      .replace('<numFmts count="2">', '<numFmts count="3">')
      .replace('</numFmts>', '<numFmt numFmtId="166" formatCode="0.00&quot;%&quot;"/></numFmts>');
  }
  if (!/cellXfs count="29"/.test(styles)) {
    const newXf = '<xf numFmtId="166" fontId="1" fillId="0" borderId="0" xfId="0" '
      + 'applyNumberFormat="1" applyFont="1" applyAlignment="1">'
      + '<alignment horizontal="center" vertical="center"/></xf>';
    styles = styles
      .replace(/<cellXfs count="28">/, '<cellXfs count="29">')
      .replace('</cellXfs>', newXf + '</cellXfs>');
  }
  zip.file('xl/styles.xml', styles);

  // --- 2. each GDP country sheet ------------------------------------------
  const parts = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  const report = [];
  for (const part of parts) {
    let xml = await zip.file(part).async('string');
    if (!SIG_RE.test(xml)) continue;              // not a GDP country sheet -> skip
    SIG_RE.lastIndex = 0;                          // reset after .test()

    // b. convert existing G value cells (fractions) x100, and restyle them
    let valConv = 0;
    xml = xml.replace(
      /<c r="G(\d+)" s="11"([^>]*)><v>([^<]+)<\/v>/g,
      (m, row, attrs, v) => { valConv++; return `<c r="G${row}" s="${NEW_S}"${attrs}><v>${round(Number(v) * 100)}</v>`; }
    );
    // a. restyle the remaining (empty) G cells
    const before = xml;
    xml = xml.replace(/<c r="G(\d+)" s="11"/g, `<c r="G$1" s="${NEW_S}"`);
    const emptyConv = (before.match(/<c r="G\d+" s="11"/g) || []).length;

    // c. patch EVERY shared-formula master (one per I-group)
    let fmlFixed = 0;
    xml = xml.replace(SIG_RE, (m, n) => { fmlFixed++; return `I${n}/(1+IF(G${n}="",0,G${n})/100)`; });

    zip.file(part, xml);
    report.push({ part, valConv, emptyConv, fmlFixed });
  }

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(SRC, out);

  // --- report -------------------------------------------------------------
  const sheets = report.length;
  const values = report.reduce((a, r) => a + r.valConv, 0);
  const empties = report.reduce((a, r) => a + r.emptyConv, 0);
  const badFml = report.filter((r) => r.fmlFixed < 1);
  const fmls = report.map((r) => r.fmlFixed);
  console.log('GDP country sheets edited   :', sheets);
  console.log('G value cells converted x100:', values);
  console.log('G empty cells restyled      :', empties);
  console.log('Formula masters patched     :', fmls.reduce((a, b) => a + b, 0),
    `(per sheet min ${Math.min(...fmls)} / max ${Math.max(...fmls)})`);
  console.log('Sheets missing formula patch:', badFml.length ? badFml.map((r) => r.part).join(', ') : '(none)');
  report.filter((r) => r.valConv).forEach((r) => console.log('  values on', r.part, '=', r.valConv));
}
main().catch((e) => { console.error(e); process.exit(1); });
