// Surgical note-adder for Population Growth(2).xlsx  (Notes + "What it means" columns)
// Leaves charts/tables/styles/other sheets untouched. Writes to an .edited.xlsx copy.
const fs = require("fs");
const JSZip = require("jszip");

const SRC = ".xlsx files/Population Growth(2).xlsx";
const OUT = ".xlsx files/Population Growth(2).edited.xlsx";

const ALL = JSON.parse(fs.readFileSync("_allsheets.json","utf8")); // 172 country sheets
const MASSIR = ["Canldives","Cloja","Dahe","Eparia","Etretes","Haiza","Ihner","Kaastini","Kusierna","Migoku","North Ayre","Oscairia","Oyreain","Pha Hii","Pruim Fijan","Prystr Hii","Ruylku","Sanagara","Shinam","Stinebar","Suenan","Taval","Ucrua","Vesozata","Welenu Fana","Western Migoku"];
const NORTH_MASSIR = ["Canldives","Haiza","Ihner","Migoku","Oscairia","Pruim Fijan","Ruylku","Shinam","Taval","Ucrua","Welenu Fana","Western Migoku"];
const GREATWAR = ["Dahe","Etretes",...NORTH_MASSIR];

const D = {
  arten:  "Arten Fiscal Crisis (1713-15): capital flight and imperial-debt default triggered by the Arten Revolution and the 1715 Declaration of Rights.",
  sinian: "Sinian Collapse (1716-17): the war-finance ruin of Siana during the Sinian Revolution, worsened by the nuclear bombing of Minalu.",
  oil:    "Oil Crisis (1725): a worldwide oil shortage after the MPU cartel restricted global supply - felt in every economy.",
  shadow: "Shadow Oil Scandal (1728): exposure of covert Raledrian manipulation of oil prices in neutral states.",
  massir: "Massiran Credit Crisis (1729): a credit crunch that began in Dahe's banking sector, spread across Massir, and forced the GTU's 'Global Austerity' response.",
  austerity:"GTU Global Austerity (1729): the world austerity doctrine adopted during the Massiran Credit Crisis.",
  gwar:   "Great War of Massir (from 1731): a major war across northern Massir that strained the region's economies.",
  crash:  "The Great Crash (1740): the global stock-market crash set off by the collapse of the Estijan Huan.",
  huan:   "Collapse of the Huan (1740): dissolution of the Estijan Huan, hyperinflating its currency and breaking the empire apart.",
  keiratam:"Keiratam War (1701-02): Ztesh's war with Erkizil over Keiratam, ending in a forced population transfer.",
  decol:  "Decolonisation (1700s): loss of colonial revenue as overseas territories broke away.",
  ihner:  "Ihnerian Civil War (1712-24): a twelve-year internal war that collapsed Ihner's economy.",
  fincen: "Fincen Civil War (1711-27): a prolonged internal conflict.",
  aetin:  "Aetintine Civil War (1710-34): a decades-long internal conflict.",
  emaradecol:"Emaran decolonisation (1715-19): loss of Candenat and Migoku and the Migoku Crisis.",
  seyt:   "Seytinemasi Civil War (1717-19): an internal conflict.",
  verste: "Verste regime collapse (1723): fall of the dictatorship and socialist takeover.",
  ocaun:  "Ocaun Famine (1738): a mass food shortage.",
  zenashan:"Zenashan Wars (1743-50): Ealdorii's costly interventions in Zenashan and war with Ukhdari.",
  daconia:"Estijan-Daconia War (1747): Estijan's invasion and overthrow of the Daconian government.",
  quian:  "Quian Union exit (1747): Ashain's departure from the Quian common market.",
  ahokini:"Ahokini Civil War (1703-11): an internal conflict.",
  islatan:"Islatan Stabilisation Crisis (1711): Emara's currency collapse as the 6th Republic fell, forcing a hard reset of the Islatan under the 7th Republic.",
  sokato: "Sokato Spice Bubble (1719-21): a speculative mania in colonial spice-trade companies after Oyreain's independence broke Siana's Sokato monopoly - ending in a crash.",
  slump:  "The Great Slump (1729-33): the worldwide depression that followed the 1729 Massiran Credit Crisis and the GTU's Global Austerity doctrine.",
  mahean: "Mahean Debt Crisis (1750-52): a chain of sovereign defaults across Mahea's commodity exporters after the borrowing boom reversed.",
  rearm:  "Rearmament Squeeze (1751-53): the Cold War arms race that diverted spending from civilian growth, beginning Estijan's long stagnation.",
};

const S = {};
const add = (sheet, year, noteL, defKey) => { (S[sheet] = S[sheet] || {})[year] = [noteL, D[defKey]]; };

// Arten Fiscal Crisis 1715
add("Areoix Lie",1715,"Arten Fiscal Crisis - epicentre: capital flight & imperial-debt default after the Declaration of Rights.","arten");
["Terressin","Pelines","Jau","Acetoa","Feio Lie"].forEach(c=>add(c,1715,"Arten Fiscal Crisis - trade & financial fallout across the region.","arten"));
// Sinian Collapse 1717
add("Siana",1717,"Sinian Collapse - treasury ruin, loss of colonies, surrender of its nuclear arsenal.","sinian");
add("Oyreain",1717,"Won independence amid Siana's collapse & the Minalu bombing.","sinian");
add("Sanagara",1717,"Won independence amid Siana's collapse.","sinian");
// Oil Crisis 1725 - EVERYONE
ALL.forEach(c=>add(c,1725,"Oil Crisis - hit by the global oil shortage & price spike (MPU supply cut).","oil"));
// Shadow Oil Scandal 1728
add("Raledria",1728,"Shadow Oil Scandal - exposed as manipulating oil in neutral states.","shadow");
// Massiran Credit Crisis 1729 - ALL Massir nations
MASSIR.forEach(c=>add(c,1729,"Massiran Credit Crisis - regional banking & credit crunch spreading from Dahe.","massir"));
add("Dahe",1729,"Massiran Credit Crisis - epicentre: banking sector collapsed, saved only by government bailouts.","massir");
add("Vesozata",1729,"Massiran Credit Crisis - cargo ships seized by Dahe; trade & relations collapsed.","massir");
add("Pelugrotoa",1729,"Massiran Credit Crisis - oil-price collapse -> inflation & deadly food riots.","massir");
add("Sunsokua",1729,"Massiran Credit Crisis - oil-price collapse -> inflation & deadly food riots.","massir");
["Raledria","Emara","Estijan"].forEach(c=>add(c,1729,"GTU 'Global Austerity' doctrine adopted amid the Massiran Credit Crisis.","austerity"));
// Great War of Massir 1731 - Dahe + Etretes + North Massir
GREATWAR.forEach(c=>add(c,1731,"Great War of Massir begins - northern-Massir war economy.","gwar"));
// Great Crash & Collapse of the Huan 1740
add("Estijan",1740,"Collapse of the Huan (Jan) & the Great Crash (Mar) - hyperinflation & empire dissolution.","huan");
["Ikzen","Darewa","Ealdorii","Fermori","Eldavpir"].forEach(c=>add(c,1740,"Collapse of the Huan - secession & transition shock.","huan"));
["Dahe","Raledria","Emara","Etirha","Areoix Lie","Lycroa","Verusa","Ashain"].forEach(c=>add(c,1740,"The Great Crash - global stock-market crash & recession.","crash"));
// Nation-level
add("Ztesh",1702,"Keiratam War with Erkizil & forced population transfer.","keiratam");
add("Erkizil",1702,"Keiratam War with Ztesh & population transfer.","keiratam");
add("Easuhura",1714,"Decolonisation shock - serial loss of colonies (Amcha, North Ayre, Disal Nila).","decol");
add("Ihner",1712,"Ihnerian Civil War begins - 12-year economic collapse (to 1724).","ihner");
add("Fincen",1711,"Fincen Civil War begins (to 1727).","fincen");
add("Aetintio",1710,"Aetintine Civil War begins (to 1734).","aetin");
add("Emara",1719,"Decolonisation - loss of Candenat & Migoku; the Migoku Crisis.","emaradecol");
add("Seytinemas",1717,"Seytinemasi Civil War (1717-19).","seyt");
add("Verste",1723,"Regime collapse - fall of the dictatorship, socialist takeover.","verste");
add("Ocaun",1738,"Ocaun Famine.","ocaun");
add("Ealdorii",1743,"Zenashan Wars & war with Ukhdari (1743-50).","zenashan");
add("Estijan",1747,"Estijan-Daconia War - invasion & overthrow of Daconia.","daconia");
add("Ashain",1747,"Left the Quian Union - loss of the common market.","quian");
add("Ukhdari",1747,"War with Ealdorii.","zenashan");
add("Ahokini",1703,"Ahokini Civil War (1703-11).","ahokini");
// --- restored (canon-compatible) crises ---
add("Emara",1711,"Islatan Stabilisation Crisis - 6th Republic falls; the Islatan is reset under the 7th Republic.","islatan");
["Siana","Oyreain","Taval"].forEach(c=>add(c,1721,"Sokato Spice Bubble bursts - colonial spice-trade mania & crash.","sokato"));
["Dahe","Raledria","Areoix Lie","Pelugrotoa","Estijan","Etirha","Emara","Lycroa","Verusa","Ztesh","Sunsokua","Ukhdari","United Delet","New Misos","Ashain","Seytinemas","Siana","Easuhura","Inania","Quidic","Ealdorii","Vayvele","Sanagara","Praesyu","Verste"].forEach(c=>add(c,1730,"The Great Slump - global depression after the Massiran Credit Crisis & Global Austerity.","slump"));
["Pelugrotoa","Sunsokua","Seytinemas","Inania","Vayvele","Trian","Dual Cenryia","Chaenia","Selaja","Sadain","Sivoso","Otiiric","Isnti","Exilium","Ocaun","Lieri","Taing","Inrea","Galca","Taoisia","Ozinia","Byllu","Rtesania","Amcha","Cruthi Anoso"].forEach(c=>add(c,1750,"Mahean Debt Crisis - continent-wide defaults after over-borrowing.","mahean"));
["Estijan","Raledria","Dahe"].forEach(c=>add(c,1752,"Rearmament Squeeze - Cold War military budgets crowd out civilian growth.","rearm"));

// ---- helpers ----
const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const colLetter = n => { let s=""; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=Math.floor((n-1)/26);} return s; };
const colIdx = L => { let n=0; for(const ch of L) n=n*26+(ch.charCodeAt(0)-64); return n; };
const cellXML = (ref,text) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(SRC));
  const wbxml = await zip.file("xl/workbook.xml").async("string");
  const rels  = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const relMap = {}; [...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].forEach(m=>relMap[m[1]]=m[2]);
  const nameToPath = {};
  [...wbxml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].forEach(m=>{ nameToPath[m[1]]="xl/"+relMap[m[2]].replace(/^\//,""); });

  let totalApplied=0, totalMissing=0, sheetsTouched=0;
  for (const sheet of Object.keys(S)) {
    const path = nameToPath[sheet];
    if (!path) { console.log("MISSING SHEET:",sheet); continue; }
    let xml = await zip.file(path).async("string");
    const dim = xml.match(/<dimension ref="A1:([A-Z]+)(\d+)"\/>/);
    const lastColL = dim ? dim[1] : "K", maxRow = dim ? dim[2] : null;
    const defIdx = colIdx(lastColL)+2, noteL = colLetter(colIdx(lastColL)+1), defL = colLetter(defIdx);
    const yearRow = {}; [...xml.matchAll(/<c r="B(\d+)"[^>]*>\s*<v>(\d+)<\/v>/g)].forEach(m=>{ yearRow[m[2]]=+m[1]; });
    xml = xml.replace(/(<row r="1"[^>]*spans=")([^"]*)("[^>]*>)([\s\S]*?)(<\/row>)/,
      (mm,a,sp,b,body,end)=>`${a}1:${defIdx}${b}${body}${cellXML(noteL+"1","Notes")}${cellXML(defL+"1","What it means")}${end}`);
    for (const [yr,[nL,dM]] of Object.entries(S[sheet])) {
      const row = yearRow[yr];
      if (!row) { totalMissing++; continue; }
      const re = new RegExp(`(<row r="${row}"[^>]*spans=")([^"]*)("[^>]*>)([\\s\\S]*?)(<\\/row>)`);
      if (!re.test(xml)) { totalMissing++; continue; }
      xml = xml.replace(re,(mm,a,sp,b,body,end)=>`${a}1:${defIdx}${b}${body}${cellXML(noteL+row,nL)}${cellXML(defL+row,dM)}${end}`);
      totalApplied++;
    }
    if (dim) xml = xml.replace(/<dimension ref="A1:[A-Z]+\d+"\/>/, `<dimension ref="A1:${defL}${maxRow}"/>`);
    zip.file(path, xml); sheetsTouched++;
  }
  const buf = await zip.generateAsync({type:"nodebuffer",compression:"DEFLATE"});
  fs.writeFileSync(OUT, buf);
  console.log(`sheets touched: ${sheetsTouched} | notes applied: ${totalApplied} | missing rows: ${totalMissing}`);
  console.log("WROTE:", OUT, (buf.length/1024/1024).toFixed(2)+"MB");
})().catch(e=>{console.error("ERR",e);process.exit(1);});
