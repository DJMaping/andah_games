# Map pipeline

Turns the hand-drawn political map of Andah into clickable vector geometry for
`world-map.html`. Everything is derived; nothing here is hand-authored except
`data/map-label-overrides.json`, which records human decisions.

Run the stages in order. All of them are safe to re-run.

```bash
node --max-old-space-size=6144 tools/trace-map.cjs         # 1. raster -> regions
node --max-old-space-size=6144 tools/label-regions.cjs     # 2. regions -> countries
node --max-old-space-size=6144 tools/build-fixer-data.cjs  # 3. package for the fix-up page
node --max-old-space-size=6144 tools/build-geojson.cjs     # 4. regions -> GeoJSON
node tools/build-country-data.cjs                          # 5. gather the figures
```

Intermediate files land in `build/`, which is gitignored. The two files the site
actually loads are `data/andah-countries.geojson` and `data/andah-map-data.json`.

## 1. trace-map.cjs

Reads `maps/yap.png`, a 10000×4999 equirectangular map that is essentially three
colours: white sea, grey land, dark border lines.

- Classifies by colour, not palette index, so re-exporting the source cannot
  silently change what the map means.
- **Rescues unfilled countries.** A country drawn as an outline but never
  flood-filled reads as sea inside a ring of border and would vanish. Enclosed
  water is treated as land when what lies beyond its ring is open ocean rather
  than land; that distinction is what separates an unfilled country from an
  inland sea. Shomjind is one of these.
- Flood fills the land into regions, wrapping at the antimeridian.
- **Hands out the border pixels.** A drawn border belongs to nobody, so without
  this every country is inset by a pixel and neighbours are separated by a
  visible sliver. A border pixel is claimed only if it actually has land beside
  it: a real border has land on both sides, a maritime stub drawn into open
  water has sea on both sides. Flooding along the lines instead would turn every
  stub into a one-pixel spike of whichever country it touches at the coast.
- Measures each region with the cos(latitude) correction equirectangular needs.

## 2. label-regions.cjs

Works out which country each region is, from three independent sources:

- **Anchors** — `js/andah-map-coords.js`, 172 hand-placed points in the pixel
  space of `maps/map.png`, which is an exact 1:1 crop of `yap.png`.
- **Cities** — `data/flight-cities.json`, already on the same grid and tagged by
  nation.
- **Area** — every country's real area is known, so the traced area is checked
  against it. This is what catches merged countries and misplaced anchors.

It also repairs countries the source map has accidentally fused, by thickening
the drawn border until it separates them and re-filling each side; that
reproduces the artist's line. Only where the artwork provides no boundary at all
does it fall back to sharing the land out by known area, and those cases are
listed under "Boundaries this pipeline had to invent" in the report so they can
be drawn properly in the source.

`data/map-label-overrides.json` wins over everything. Each entry carries `at`, a
point inside its region, and is resolved by that point rather than by its id:
**region ids are renumbered whenever the source map gains or loses land**, so an
id alone would quietly start pointing at a different country. Use
`tools/migrate-overrides.cjs` if an old id-only file needs carrying across.

Reports go to `build/MAP_TRACE_REPORT.md`, including any anchors that have
drifted into a neighbour, with corrected positions in
`build/andah-map-coords.suggested.js`.

## 3. label-fixer.html

Open it (over http, not off disk) to correct anything the automatic pass got
wrong. Click a region, pick the right country, and **Download overrides** into
`data/`. Corrections live in browser storage as you go.

## 4. build-geojson.cjs

Traces the boundary as a graph of *arcs*, chains of edges separating the same
pair of countries, and simplifies each arc once. Simplifying countries
independently would move a shared border by a different amount on each side and
crack every frontier open.

Takes a Visvalingam tolerance in square pixels as its argument; the default,
0.25, is effectively lossless. Outer rings and holes are told apart by nesting
rather than winding, because which way a ring comes out depends on the direction
the boundary happened to be walked.

Output follows the GeoJSON spec, which winds exterior rings counterclockwise.
**d3 reads a ring as the region to its left in spherical terms, which is the
opposite convention**, so `js/world-map.js` detects and reverses inverted rings
on load rather than assuming either way round.

## 5. build-country-data.cjs

Merges `data/countries.json` (the Janus spreadsheet figures) with the
`{{Infobox country}}` block of each wiki article in the miraheze-local checkout,
and computes every world rank so the ranks always agree with the figures shown.
Pass the path to that checkout as an argument if it is not in the default place.

## Diagnostics

`crop-check.cjs <lon> <lat> <span> <out.png>` and `region-zoom.cjs <id> <mag>
<out.png>` render the source artwork beside the traced result, which is how the
border-stub and fused-region problems were found. `diagnose-align.cjs` works out
how `map.png` relates to `yap.png`.
