// Removes ALL charts+drawings from Population Growth(2).xlsx, keeps data tables,
// and widens each sheet's Notes column to 3x the default width. In-place (verified after).
const fs = require("fs");
const JSZip = require("jszip");
const FILE = ".xlsx files/Population Growth(2).xlsx";

const colIdx = L => { let n=0; for(const ch of L) n=n*26+(ch.charCodeAt(0)-64); return n; };

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(FILE));
  const paths = Object.keys(zip.files);

  // 1) delete every chart + drawing part (incl their _rels)
  let deleted = 0;
  paths.forEach(p => { if (/^xl\/(charts|drawings)\//.test(p)) { zip.remove(p); deleted++; } });

  // 2) clean Content_Types overrides for charts/drawings
  let ct = await zip.file("[Content_Types].xml").async("string");
  ct = ct.replace(/<Override PartName="\/xl\/(charts|drawings)\/[^"]*"[^>]*\/>/g, "");
  zip.file("[Content_Types].xml", ct);

  // 3) per worksheet: drop <drawing>, drop drawing rel, widen Notes column
  let widened = 0, dropped = 0;
  for (const p of paths) {
    const m = p.match(/^xl\/worksheets\/(sheet\d+)\.xml$/);
    if (!m) continue;
    let xml = await zip.file(p).async("string");

    // drop the drawing anchor
    if (/<drawing r:id="[^"]*"\/>/.test(xml)) { xml = xml.replace(/<drawing r:id="[^"]*"\/>/, ""); dropped++; }

    // find the Notes column (the inline-string header cell == "Notes")
    const nm = xml.match(/<c r="([A-Z]+)1" t="inlineStr"><is><t[^>]*>Notes<\/t>/);
    if (nm) {
      const idx = colIdx(nm[1]);
      const def = parseFloat((xml.match(/defaultColWidth="([\d.]+)"/)||[])[1] || "8.43");
      const w = (def * 3).toFixed(4);
      const colTag = `<col min="${idx}" max="${idx}" width="${w}" customWidth="1"/>`;
      if (/<cols>/.test(xml)) xml = xml.replace("</cols>", colTag + "</cols>");
      else xml = xml.replace(/<sheetData/, `<cols>${colTag}</cols><sheetData`);
      widened++;
    }
    zip.file(p, xml);

    // remove the drawing relationship from this sheet's rels (keep table/printer rels)
    const relPath = `xl/worksheets/_rels/${m[1]}.xml.rels`;
    if (zip.file(relPath)) {
      let rels = await zip.file(relPath).async("string");
      rels = rels.replace(/<Relationship [^>]*Type="[^"]*\/drawing"[^>]*\/>/g, "");
      zip.file(relPath, rels);
    }
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(FILE, buf);
  console.log(`deleted chart/drawing parts: ${deleted} | drawing anchors dropped: ${dropped} | Notes cols widened: ${widened}`);
  console.log("size:", (buf.length/1024/1024).toFixed(2)+"MB");
})().catch(e => { console.error("ERR", e); process.exit(1); });
