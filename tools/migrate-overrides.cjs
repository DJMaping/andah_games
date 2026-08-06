/**
 * migrate-overrides.cjs - carry hand corrections across a renumbering.
 *
 * Region ids come from the order the flood fill happens to meet each landmass,
 * so editing the source map renumbers everything after the edit. An override
 * file keyed only by id would then quietly point at the wrong countries. This
 * re-keys an old file onto the current map by looking up a point known to lie
 * inside each old region, and writes the result in the richer format that
 * carries that point along, so no future renumbering can break it again.
 *
 * Usage: node tools/migrate-overrides.cjs <old-regions.json> <old-overrides.json> <out.json>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const [oldRegionsPath, oldOverridesPath, outPath] = process.argv.slice(2);
if (!oldRegionsPath || !oldOverridesPath || !outPath) {
  console.error('need <old-regions.json> <old-overrides.json> <out.json>');
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(path.join(BUILD, 'regions-final.json'), 'utf8'));
const labels = new Uint16Array(zlib.gunzipSync(fs.readFileSync(path.join(BUILD, 'labels-final.u16.gz'))).buffer);
const W = meta.width, H = meta.height;
const now = new Map(meta.regions.map((r) => [r.id, r]));

const old = JSON.parse(fs.readFileSync(oldRegionsPath, 'utf8'));
const oldById = new Map(old.regions.map((r) => [r.id, r]));
const raw = JSON.parse(fs.readFileSync(oldOverridesPath, 'utf8'));
const table = raw.overrides || raw;

const out = {};
const lost = [];
const collided = [];
let moved = 0, same = 0;

for (const [key, entry] of Object.entries(table)) {
  if (key.startsWith('_')) continue;
  const value = entry && typeof entry === 'object' ? entry.name : entry;
  const oldId = Number(key);
  const src = oldById.get(oldId);
  const at = entry && typeof entry === 'object' && Array.isArray(entry.at)
    ? entry.at
    : (src && src.interior ? [src.interior.x, src.interior.y] : null);
  if (!at) { lost.push({ key, value, why: 'no interior point recorded for that region' }); continue; }

  const newId = labels[at[1] * W + at[0]];
  if (!newId || !now.has(newId)) { lost.push({ key, value, why: `its interior point is no longer land` }); continue; }
  if (out[newId] && out[newId].name !== value) {
    collided.push({ newId, keep: out[newId].name, drop: value });
    continue;
  }
  out[newId] = { name: value, at };
  if (String(newId) === key) same++; else moved++;
}

fs.writeFileSync(outPath, JSON.stringify({
  _note: 'Hand corrections to the automatic map labelling. Each entry is keyed by region id but also carries "at", a point inside that region, which is what actually resolves it. Region ids are renumbered whenever the source map changes; the point is not. null name means unidentified, "__ignore__" means artefact. Read by tools/label-regions.cjs.',
  _migratedFrom: path.basename(oldOverridesPath),
  overrides: out,
}, null, 1));

console.log(`migrated ${Object.keys(out).length} of ${Object.keys(table).filter((k) => !k.startsWith('_')).length} corrections`);
console.log(`  ${same} kept their id, ${moved} were renumbered`);
if (collided.length) {
  console.log(`  ${collided.length} collided (two old regions are now one):`);
  for (const c of collided) console.log(`    region ${c.newId}: kept ${c.keep}, dropped ${c.drop}`);
}
if (lost.length) {
  console.log(`  ${lost.length} could not be carried across:`);
  for (const l of lost) console.log(`    ${l.key} -> ${l.value}: ${l.why}`);
}
console.log(`wrote ${outPath}`);
