# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A static website of geography games, data visualisations, and a wiki mirror for **Andah** — a fully fictional world with its own countries, flags, capitals, populations, economies, and history. Deployed to Netlify at **[www.djmapping.com](https://www.djmapping.com)**.

The editorial source of truth for Andah's world data lives on the [Andah Miraheze Wiki](https://andah.miraheze.org/wiki/Main_Page). This site mirrors that wiki and builds interactive games on top of it.

## Games and pages

- **Flag games** — Guess the Flag, Guess Flag Name, Silhouette Flag, Type the Country
- **Stat games** — Bigger or Smaller, Higher or Lower, Closest Match, Richer or Poorer
- **City games** — City Higher or Lower, City Country Quiz
- **Trivia** — Capital Quiz
- **Map games** — Type the Map
- **Simulations** — 1764 World Cup Simulator
- **Explorer** — interactive map, sortable table, and charts (`explore.html`)
- **Flight Network** — gravity-model flight network on a 3D globe + 2D map (`flight-network.html`)
- **Wiki mirror** — pre-fetched from Miraheze (`wiki.html`, `wiki/`)

## Tech stack

- Vanilla HTML/CSS/JS — no frontend framework
- Node ≥ 20 for the build pipeline
- Deployed via Netlify (config in `netlify.toml`)
- `npm run serve` → local dev server at `http://localhost:3000`

## Project layout

| Path | Purpose |
|------|---------|
| `index.html` | Landing page / game menu |
| `*.html` | One file per game + explore.html / wiki.html |
| [css/](css/) | Shared styles |
| [js/](js/) | Page scripts + hand-authored data (capitals, cities, stats, map coords) |
| [views/](views/) | Explorer modules (map, table, charts, time-series, wiki view, formatting) |
| [data/](data/) | Build outputs (countries.json, wiki-index.json, intros.json, airports/routes) |
| [flags/](flags/) | Flag images (one per country) |
| [maps/](maps/) | World map image (andah-political.png, andah-city-dots.png) |
| [.xlsx files/](.xlsx%20files/) | Source spreadsheets for the data pipeline |
| [scripts/](scripts/) | Build scripts |
| [netlify/functions/](netlify/functions/) | Scheduled function for daily Netlify rebuild trigger |
| [docs/datasets.md](docs/datasets.md) | Operator guide for datasets and wiki rebuilds |

## Build pipeline

`npm run build` runs [scripts/build.js](scripts/build.js), which orchestrates these steps in order. Each is opt-out via its env var, and each is also runnable standalone via the matching `npm run build:*` script (see `package.json`):

| Step | Script | Output | Skip env var |
|------|--------|--------|--------------|
| Data | [build-data.js](scripts/build-data.js) | [data/countries.json](data/countries.json) + [data/datasets.json](data/datasets.json) from [.xlsx files/](.xlsx%20files/) | `SKIP_DATA=1` |
| Routes | [generate-routes.js](scripts/generate-routes.js) | [data/airports.json](data/airports.json) + [data/routes.json](data/routes.json) (gravity model) | `SKIP_ROUTES=1` |
| Flight | [bake-flight-network.js](scripts/bake-flight-network.js) | [data/flight-network.json](data/flight-network.json) (pre-rendered network) | `SKIP_FLIGHT=1` |
| Intros | [extract-intros.js](scripts/extract-intros.js) | [data/intros.json](data/intros.json) | `SKIP_INTROS=1` |
| Wiki | [fetch-wiki.js](scripts/fetch-wiki.js) | `wiki/*.html` + [data/wiki-index.json](data/wiki-index.json) | `SKIP_WIKI=1` |

Each step is an exported async function (`buildData`, `buildRoutes`, etc.) imported and awaited by `build.js` — they are not separate processes, so a throw in one aborts the build.

Fast local loop (skips the slow, network-bound wiki fetch):
```bash
SKIP_WIKI=1 npm run build
```

The wiki step requires `MIRAHEZE_USER_AGENT` env var (e.g. `AndahGames/1.0 (https://www.djmapping.com)`), or Miraheze will reject requests.

[build-fifa-data.js](scripts/build-fifa-data.js) (`build:fifa` → World Cup sim data) is **not** part of `npm run build`; run it on demand.

## Two data layers (important)

The site has **two parallel data sources**, and which one a page uses depends on the page:

1. **Hand-authored classic scripts** in [js/andah-*.js](js/) — `andah-stats.js`, `andah-capitals.js`, `andah-cities.js`, `andah-map-coords.js`, `andah-fifa-data.js`. These are plain `<script>` files that declare their data with a top-level `const`. The **games** (flag/stat/city/trivia/map/world-cup pages) load these directly via `<script src="js/andah-….js">` and read the global. To change game data, edit these files by hand.
2. **Built JSON** in [data/*.json](data/) — produced by the build pipeline from [.xlsx files/](.xlsx%20files/). The **Explorer** (`explore.html`) and **Flight Network** (`flight-network.html`) are ES modules that `fetch()` these.

[views/data.js](views/data.js) is the bridge. The Explorer prefers `data/countries.json`; if it's missing (e.g. local dev before a build), it falls back to `js/andah-stats.js`, loading that classic script via dynamic `<script>` injection plus a tiny bridge that copies the `const` onto `window` (a `const` in classic-script scope is otherwise invisible to ES modules). The `_fallback: true` flag on the returned data signals this happened.

So: editing a spreadsheet only affects the Explorer/Flight pages after a build; editing `js/andah-*.js` affects the games immediately and the Explorer's fallback.

### Authoring tools

Several `*-tagger.html` / `*-editor.html` pages are one-off, browser-based authoring tools, **not** part of the deployed game set. They let you place/label data on the map and **export a file you then commit by hand**:
- `map-tagger.html` → exports [js/andah-map-coords.js](js/andah-map-coords.js)
- `flight-tagger.html` / `flight-cities-editor.html` → exports [data/flight-cities.json](data/flight-cities.json)

## Data conventions

[data/countries.json](data/countries.json) is built from [.xlsx files/](.xlsx%20files/). In those spreadsheets:
- Numeric columns → metrics
- String columns → categorical filters
- `<metric>_history` sheets → time-series data

Schema inference lives in [scripts/util/schema.js](scripts/util/schema.js). Labels and formatting overrides go in `data-sources.json` (read by `build-data.js`). Full details in [docs/datasets.md](docs/datasets.md).

## GDP Explorer

`gdp-explorer.html` + [js/gdp-explorer.js](js/gdp-explorer.js) visualize AND author historical GDP.
Excel is **retired** — the page loads from two repo JSONs and edits happen in-browser:

- [data/gdp-history.json](data/gdp-history.json) — fixed population substrate + 2015 anchors, one array per country
  (`{name, anchor, rows:[[earthYear, year, pop], …]}`, newest-first, 172 countries × 66 years).
- [data/gdp-growth.json](data/gdp-growth.json) — the **only file DJ edits**: sparse authored layer
  `{countries:{<name>:{growth:{<year>:rate}, overrides:{<year>:$}}}}`. `growth[Y]` = per-capita growth into
  Earth Year Y; `overrides[Y]` = an exact per-capita $ pin.

Data model (unchanged math): per-capita history compounds **backward from each country's 2015 anchor**:
`perCap(Y-1) = override ?? perCap(Y)/(1+growth(Y))`. Blank growth = 0% placeholder; a year is "determined"
only if every step back from 2015 had a growth input or a pin.

- **Authoring** lives in the page's **Edit** mode (View/Edit toggle), targeting the country-over-time view:
  (a) **$ checkpoints + interpolate** — pin a per-capita $ at a few years, then "Interpolate" fills the growth
  curve between pins/anchor with constant CAGR; (b) **draggable growth curve** — drag the purple GDP/cap growth
  line (via `chartjs-plugin-dragdata`, vendored in [js/vendor/](js/vendor/)); (c) **archetype presets**. Edits
  autosave to localStorage (draft); **"Download gdp-growth.json"** exports the sparse file — replace `data/gdp-growth.json`
  and commit it to deploy (same "export a file you commit" pattern as the tagger/editor tools).
- `npm run gdp:build` ([scripts/build-gdp-history.js](scripts/build-gdp-history.js)) regenerates both JSONs from the
  workbook; it was the **one-time migration** and is only needed if population history changes. Anchors come from
  `gdpPerNominal` in [js/andah-stats.js](js/andah-stats.js).
- **Deprecated:** `scripts/add-gdp-columns.js` / `npm run gdp:columns` and the `.xlsx files/Population Growth(2).xlsx`
  round-trip are no longer part of the workflow (kept for reference only).
- Charts via Chart.js (vendored). Continent colors come from `data/countries.json` `categorical.Continent`
  (degrades gracefully if absent).

## Flight network

`flight-network.html` loads airports from (in priority order):
1. [data/flight-cities.json](data/flight-cities.json) — hand-tagged via `flight-tagger.html`
2. [generate-routes.js](scripts/generate-routes.js) build output
3. In-browser fallback generated from country data

Gravity model tunables live in [views/flight-config.js](views/flight-config.js).

## Deployment

Netlify builds from [netlify.toml](netlify.toml) (`npm run build`, publishes repo root). Two env vars must be set in the Netlify UI:
- `MIRAHEZE_USER_AGENT` — for the wiki fetch
- `NETLIFY_BUILD_HOOK_URL` — used by [netlify/functions/trigger-rebuild.js](netlify/functions/trigger-rebuild.js) to trigger a daily rebuild
