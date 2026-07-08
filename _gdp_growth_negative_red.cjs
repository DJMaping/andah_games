// _gdp_growth_negative_red.cjs
// Make NEGATIVE values in the "GDP/cap growth" column (G) show in RED across every
// GDP country sheet, keeping the 2-decimal "%" look from _fix_gdp_growth_percent.cjs.
//
// How: purely a styles.xml numFmt edit — no per-cell or conditional-formatting churn.
// Column G cells use exactly three cellXfs, and those styles appear on column G ONLY
// (verified), so retargeting their number formats is safe:
//   • numFmt 166  0.00"%"                (style 28  — 2dp, no red)
//   • numFmt 167  0.0"%";[Red]-0.0"%"    (styles 29,30 — 1dp, already red)
// Both are rewritten to the SAME two-section format:
//       0.00"%";[Red]-0.00"%"
// → positives/zeros: "3.21%"   negatives: red "-4.30%".  Unifies G to 2dp + red,
//   preserves style 30's highlight fill, and touches no other column.
//
// Surgical, zip-level edit of the LIVE workbook (JSZip) — leaves the 440 charts,
// tables, drawings, and every other byte untouched. Idempotent; keeps one backup.
//
// Usage: node _gdp_growth_negative_red.cjs   (CLOSE the workbook in Excel first!)

const JSZip = require('jszip');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '.xlsx files');
const SRC = path.join(DIR, 'Population Growth(2).xlsx');
const BACKUP = path.join(DIR, 'Population Growth(2) (pre-negative-red backup).xlsx');

// XML-encoded format strings (double-quotes stored as &quot;).
const FMT_166_OLD = '<numFmt numFmtId="166" formatCode="0.00&quot;%&quot;"/>';
const FMT_167_OLD = '<numFmt numFmtId="167" formatCode="0.0&quot;%&quot;;[Red]\\-0.0&quot;%&quot;"/>';
const FMT_166_NEW = '<numFmt numFmtId="166" formatCode="0.00&quot;%&quot;;[Red]\\-0.00&quot;%&quot;"/>';
const FMT_167_NEW = '<numFmt numFmtId="167" formatCode="0.00&quot;%&quot;;[Red]\\-0.00&quot;%&quot;"/>';

async function main() {
  if (!fs.existsSync(SRC)) { console.error('Workbook not found:', SRC); process.exit(1); }

  // Refuse to run while Excel holds the file (would EBUSY or get clobbered on save).
  try { fs.closeSync(fs.openSync(SRC, 'r+')); }
  catch (e) { console.error('Workbook is LOCKED (', e.code, ') — close it in Excel first, then rerun.'); process.exit(1); }

  if (!fs.existsSync(BACKUP)) {
    fs.writeFileSync(BACKUP, fs.readFileSync(SRC));
    console.log('Backup written:', path.basename(BACKUP));
  } else {
    console.log('Backup already exists — leaving it as the pristine pre-fix copy.');
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(SRC));
  let styles = await zip.file('xl/styles.xml').async('string');

  let n166 = 0, n167 = 0;
  if (styles.includes(FMT_166_OLD)) { styles = styles.replace(FMT_166_OLD, FMT_166_NEW); n166 = 1; }
  if (styles.includes(FMT_167_OLD)) { styles = styles.replace(FMT_167_OLD, FMT_167_NEW); n167 = 1; }

  const already = styles.includes(FMT_166_NEW) && styles.includes(FMT_167_NEW);
  if (!n166 && !n167) {
    console.log(already ? 'Already applied — nothing to do (idempotent).'
                        : 'Expected numFmt 166/167 not found — aborting, no write.');
    if (!already) process.exit(1);
    return;
  }

  zip.file('xl/styles.xml', styles);
  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(SRC, out);

  console.log('numFmt 166 (style 28)  updated:', n166 ? 'yes' : 'no (was already 2dp+red?)');
  console.log('numFmt 167 (styles 29,30) updated:', n167 ? 'yes' : 'no');
  console.log('Column G is now uniformly  0.00"%"  with RED negatives. Charts/tables untouched.');
}
main().catch((e) => { console.error(e); process.exit(1); });
