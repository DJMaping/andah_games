# Datasets & wiki rebuild — operator guide

Short notes for keeping the Explore section and Wiki mirror in sync.

## Adding a new Excel dataset

1. Drop the `.xlsx` into [`.xlsx files/`](../.xlsx%20files/).
2. Run `npm run build` (locally) or push to main (Netlify rebuilds on push).
3. `data/countries.json` is regenerated. Any new numeric columns become metrics; any new string columns become categorical filters.

Hidden rules the build follows:

- Each data sheet must have a column called `name`, `country`, or `country_name` (case-insensitive) — that's the primary key.
- Numeric columns → `metrics.<columnHeader>`.
- String columns (other than the name column) → `categorical.<columnHeader>`.
- Sheets named `<metric>_history` are interpreted as time-series.
  - Long format: columns `name`, `year`, plus one value column.
  - Wide format: columns `name`, `2000`, `2001`, ... — each numeric column header is treated as a year.
- Sheet names starting with `_` are reserved (skipped silently).

## Customizing how a metric is shown

Create `data-sources.json` at the repo root if it doesn't exist, then add overrides:

```json
{
  "metrics": {
    "population": { "label": "Population", "format": "integer", "scale": "linear" },
    "gdpNominal": { "label": "GDP (nominal)", "format": "currency", "scale": "log" },
    "literacyRate": { "label": "Literacy", "format": "percent", "unit": "%", "hidden": false }
  }
}
```

- `format`: `integer` | `currency` | `percent` | `number`
- `scale`: `linear` | `log` (used by both map color scale and chart axes)
- `hidden`: `true` to remove from UI (table, charts, map dropdown)

## Mapping a country to a wiki page

By design: **country name in Excel == wiki page title on Miraheze**.

- Spaces become underscores per MediaWiki convention.
- Renaming a wiki page or an Excel `name` cell will silently break the link until both match again.
- Verify the mapping after a rebuild via `data/wiki-index.json` — each country slug should appear in `pages[]`.

## Triggering a rebuild

- **Automatic (daily):** the Netlify scheduled function `netlify/functions/trigger-rebuild.js` POSTs to a build hook every 24h.
- **Manual from anywhere:** `curl -X POST <build-hook-url>` (the URL is private — don't commit it).
- **Manual locally:** `npm run build`. Don't forget `MIRAHEZE_USER_AGENT` in your env, or the API may reject requests.

## Netlify one-time setup

1. Site settings → Build & deploy → **Build hooks** → Add build hook → copy URL.
2. Site settings → Environment variables:
   - `NETLIFY_BUILD_HOOK_URL` = (the URL above)
   - `MIRAHEZE_USER_AGENT` = `AndahGames/1.0 (https://www.djmapping.com; contact: your-email@example.com)`
3. Push to main once; Netlify auto-discovers the scheduled function from `netlify/functions/`.
4. Check Functions tab — `trigger-rebuild` should be listed with a `@daily` schedule.

If your Netlify plan doesn't include scheduled functions, replace the function with an external cron service (e.g. cron-job.org) that POSTs to the same build hook URL.

## Local dev

```bash
npm install
# optional: pre-set env vars
export MIRAHEZE_USER_AGENT="AndahGames/local"

# Just the data pipeline (fast)
SKIP_WIKI=1 npm run build

# Just the wiki pipeline
SKIP_DATA=1 npm run build

# Everything
npm run build

# Serve the site
npm run serve
```

Then open <http://localhost:3000/explore.html> and <http://localhost:3000/wiki/>.

## Future work

- Replace the dot-style world map with polygon-based choropleth once GeoJSON outlines exist. The renderer interface in [`views/world-map.js`](../views/world-map.js) is forward-compatible — only the inner draw loop changes.
- Add a continent filter once the Excel files include a `continent` column.
