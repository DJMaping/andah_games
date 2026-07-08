// Rebuild Ahokini (sheet6.xml) to match sibling country sheets:
// add GDP columns G-K, move Notes AA/AB -> L/M, drop L-Z filler, fix cols/dim/spans.
// Surgical: only sheet6.xml is rewritten; all other zip entries kept byte-identical.
const fs = require('fs'), JSZip = require('jszip'), path = require('path');

const XLSX = '.xlsx files/Population Growth(2).xlsx';
const OUT  = process.argv[2] || '.xlsx files/_ahokini_test.xlsx';

// ---- growth series design (whole-percent, GDP/cap growth per Earth year) ----
// Ahokini: mature, near-zero pop growth, aging. Anchor $12,000 in 2015.
const ANCHOR = 12000;
const war = {56:2.0,57:0.8,58:-0.5,59:-2.0,60:-3.5,61:-4.8,62:-4.5,63:-3.0,64:-1.2}; // Civil War 1703-11
const crisis = {27:-1.8, 37:-3.2, 38:-0.8, 42:-2.4}; // Great Crash / Slump / Austerity / Oil Crisis
function base(r){ if(r<=11)return 2.3; if(r<=26)return 3.0; if(r<=41)return 3.6; if(r<=55)return 4.2; return 4.6; }
function growth(r){
  if(r in crisis) return crisis[r];
  if(r in war) return war[r];
  return Math.round((base(r) + 0.35*Math.sin(r*1.7))*100)/100;
}

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(XLSX));
  let x = await zip.file('xl/worksheets/sheet6.xml').async('string');

  // split header / sheetData / footer
  const sdOpen = x.indexOf('<sheetData>');
  const sdClose = x.indexOf('</sheetData>') + '</sheetData>'.length;
  const head = x.slice(0, sdOpen);
  const body = x.slice(sdOpen + '<sheetData>'.length, x.indexOf('</sheetData>'));
  const foot = x.slice(sdClose);

  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b[^>]*?\/>|<c\b[^>]*?>[\s\S]*?<\/c>/g;
  const colOf = c => (c.match(/r="([A-Z]+)\d+"/)||[])[1];
  const vOf  = c => { const m = c.match(/<v>([^<]*)<\/v>/); return m ? m[1] : null; };

  const rows = {};   // r -> {attrs, cells:{col:markup}}
  let m;
  while ((m = rowRe.exec(body))) {
    const attrs = m[1];
    const rn = +attrs.match(/r="(\d+)"/)[1];
    const cells = {};
    let cm; const cre = new RegExp(cellRe.source, 'g');
    while ((cm = cre.exec(m[2]))) { const col = colOf(cm[0]); if (col) cells[col] = cm[0]; }
    rows[rn] = { attrs, cells };
  }

  // population (col C cached values) for J = I*C
  const C = {};
  for (let r = 2; r <= 67; r++) C[r] = parseFloat(vOf(rows[r].cells['C']));

  // compute per-capita (I), nominal (J), total growth (K)
  const I = {}, J = {}, K = {}, G = {};
  for (let r = 2; r <= 67; r++) G[r] = growth(r);
  I[2] = ANCHOR;
  for (let r = 3; r <= 67; r++) I[r] = I[r-1] / (1 + G[r-1]/100);
  for (let r = 2; r <= 67; r++) J[r] = I[r] * C[r];
  for (let r = 2; r <= 66; r++) K[r] = J[r] / J[r+1] - 1;

  const num = n => { // Excel-style scientific for small, plain otherwise (cosmetic only)
    if (!isFinite(n)) return '0';
    return String(n);
  };

  // build G-K cells for a data row
  function gkCells(r) {
    const g = `<c r="G${r}" s="28"><v>${G[r]}</v></c>`;
    const h = `<c r="H${r}" s="10"/>`;
    let iF;
    if (r === 2) iF = `IF(H2&lt;&gt;"",H2,${ANCHOR})`;
    else iF = `IF(H${r}&lt;&gt;"",H${r},I${r-1}/(1+IF(G${r-1}="",0,G${r-1})/100))`;
    const i = `<c r="I${r}" s="10"><f>${iF}</f><v>${num(I[r])}</v></c>`;
    const j = `<c r="J${r}" s="10"><f>IF(I${r}="","",I${r}*C${r})</f><v>${num(J[r])}</v></c>`;
    let k;
    if (r <= 66) k = `<c r="K${r}" s="11"><f>IFERROR(J${r}/J${r+1}-1,"")</f><v>${num(K[r])}</v></c>`;
    else k = `<c r="K${r}" s="11"/>`; // earliest row: no next year
    return g + h + i + j + k;
  }

  // reassemble rows
  const AF = ['A','B','C','D','E','F'];
  let out = '';
  for (let r = 1; r <= 67; r++) {
    const row = rows[r];
    const attrs = row.attrs.replace(/spans="1:\d+"/, 'spans="1:13"');
    let cells = '';
    // A-F verbatim
    for (const col of AF) if (row.cells[col]) cells += row.cells[col];
    if (r === 1) {
      // headers G1..M1 (shared-string indices 79..85, styles matching siblings)
      cells += '<c r="G1" s="2" t="s"><v>79</v></c><c r="H1" s="2" t="s"><v>80</v></c>'
             + '<c r="I1" s="2" t="s"><v>81</v></c><c r="J1" s="2" t="s"><v>82</v></c>'
             + '<c r="K1" s="2" t="s"><v>83</v></c><c r="L1" t="s"><v>84</v></c><c r="M1" t="s"><v>85</v></c>';
    } else {
      cells += gkCells(r);
      // move notes AA->L, AB->M (retarget the cell ref, keep style/value)
      if (row.cells['AA']) cells += row.cells['AA'].replace(/r="AA(\d+)"/, 'r="L$1"');
      if (row.cells['AB']) cells += row.cells['AB'].replace(/r="AB(\d+)"/, 'r="M$1"');
    }
    out += `<row${attrs}>${cells}</row>`;
  }

  // swap cols block + dimension to sibling shape
  const COLS = '<cols><col min="1" max="1" width="5.7265625" customWidth="1"/><col min="2" max="2" width="14.36328125" customWidth="1"/><col min="3" max="3" width="13.90625" customWidth="1"/><col min="4" max="4" width="14.26953125" customWidth="1"/><col min="5" max="5" width="13.90625" customWidth="1"/><col min="6" max="6" width="19.26953125" customWidth="1"/><col min="7" max="7" width="13" customWidth="1"/><col min="8" max="8" width="16" customWidth="1"/><col min="9" max="9" width="15" customWidth="1"/><col min="10" max="10" width="20" customWidth="1"/><col min="11" max="11" width="15" customWidth="1"/><col min="12" max="12" width="37.90625" customWidth="1"/></cols>';
  let newHead = head
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:M67"/>')
    .replace(/<cols>[\s\S]*?<\/cols>/, COLS);

  const newXml = newHead + '<sheetData>' + out + '</sheetData>' + foot;
  zip.file('xl/worksheets/sheet6.xml', newXml);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(OUT, buf);

  // sanity print
  console.log('WROTE', OUT);
  console.log('2015 GDP/cap $', I[2].toFixed(0), ' nominal $', (J[2]/1e9).toFixed(1)+'B');
  console.log('1950 GDP/cap $', I[67].toFixed(0), ' nominal $', (J[67]/1e9).toFixed(1)+'B');
  console.log('growth sample: 2015='+G[2]+'% 1990='+G[27]+'%(GreatCrash) 1980='+G[37]+'%(Slump) 1975='+G[42]+'%(Oil) war60='+G[60]+'%');
})();
