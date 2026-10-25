/**
 * stamp-version.cjs - put a content hash on the map's script tag.
 *
 * Browsers hold on to js/world-map.js hard. Without a changing URL a visitor
 * keeps running whatever version they first loaded, so an edit can be live on
 * the server and invisible to everyone until they hard-refresh. Run this after
 * touching the script; it rewrites the query in world-map.html to a hash of the
 * file's contents, which changes only when the file does.
 *
 * Usage: node tools/stamp-version.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'js', 'world-map.js');
const PAGE = path.join(ROOT, 'world-map.html');

const hash = crypto.createHash('sha1').update(fs.readFileSync(SCRIPT)).digest('hex').slice(0, 8);
const before = fs.readFileSync(PAGE, 'utf8');
const after = before.replace(
  /<script src="js\/world-map\.js(?:\?v=[0-9a-f]+)?"><\/script>/,
  `<script src="js/world-map.js?v=${hash}"></script>`
);

if (after === before && !before.includes(`?v=${hash}`)) {
  console.error('could not find the world-map.js script tag in world-map.html');
  process.exit(1);
}
fs.writeFileSync(PAGE, after);
console.log(before === after ? `already stamped ${hash}` : `stamped world-map.js as ${hash}`);
