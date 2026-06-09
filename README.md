# Andah Games

Geography games, data visualisations, and a wiki mirror for the fictional world of **Andah**.

A static site, deployed to Netlify at **[www.djmapping.com](https://www.djmapping.com)**. The content (country stats, cities, flags) describes an invented world; the editorial source of truth lives on the [Andah Miraheze Wiki](https://andah.miraheze.org/wiki/Main_Page), and this site mirrors and builds on top of it.

## What's here

The landing page ([`index.html`](index.html)) links out to everything:

- **Simulations** — [1764 World Cup Simulator](world-cup.html).
- **Flag games** — Guess the Flag, Guess Flag Name, Silhouette Flag, Type the Country.
- **Stat games** — Bigger or Smaller, Higher or Lower, Closest Match, Richer or Poorer.
- **Trivia** — Capital Quiz.
- **Map games** — Type the Map.
- **City games** — City Higher or Lower, City Country Quiz.
- **Explore the data** — the [Country Explorer](explore.html) (interactive map, sortable table, and charts), the [Flight Network](flight-network.html) (a gravity-model flight network on a 3D globe + 2D map), and the [Andah Wiki mirror](wiki.html).

The Explorer is fed by `data/countries.json`, which is built from the spreadsheets in [`.xlsx files/`](.xlsx%20files/). The wiki mirror is pre-fetched from Miraheze so the site stays fast and survives wiki outages.

## Project layout

```
.
├── index.html              Landing page / game menu
├── *.html                  One file per game + explore.html / wiki.html
├── css/                    Site styles (style.css)
├── js/                     Page scripts + hand-authored data (capitals, cities, stats, map coords)
├── views/                  Explorer modules (map, table, charts, time-series, wiki view, formatting)
├── data/                   Build outputs + source CSVs (countries.json, wiki-index.json, intros.json)
├── flags/                  Flag images (one per country)
├── maps/                   map.png — the hand-coordinated world map
├── .xlsx files/            Source spreadsheets for the data pipeline
├── scripts/                Build pipeline (see below)
├── netlify/functions/      Scheduled function that triggers the daily rebuild
├── docs/datasets.md        Operator guide for datasets + wiki rebuilds
├── mediawiki/              Wiki XML export
├── netlify.toml            Build + redirect config
└── CNAME                   Custom domain (www.djmapping.com)
```

## Build pipeline

`npm run build` runs [`scripts/build.js`](scripts/build.js), which orchestrates three steps (each skippable via env var):

| Step | Script | Output | Skip with |
| --- | --- | --- | --- |
| Data | `build-data.js` | `data/countries.json` from `.xlsx files/` | `SKIP_DATA=1` |
| Routes | `generate-routes.js` | `data/airports.json` + `data/routes.json` (gravity model) | `SKIP_ROUTES=1` |
| Intros | `extract-intros.js` | `data/intros.json` | `SKIP_INTROS=1` |
| Wiki | `fetch-wiki.js` | `wiki/*.html` + `data/wiki-index.json` from the Miraheze API | `SKIP_WIKI=1` |

The data step reads every sheet flexibly: numeric columns become metrics, string columns become categorical filters, and `<metric>_history` sheets become time-series. The conventions (and how to override metric labels/formatting via `data-sources.json`) are documented in [`docs/datasets.md`](docs/datasets.md).

> The wiki step needs a descriptive `MIRAHEZE_USER_AGENT` env var, or Miraheze rejects the requests.

### Flight network data

The [Flight Network](flight-network.html) page draws its airports from one of (in priority order): `data/flight-cities.json` (city airports tagged with [`flight-tagger.html`](flight-tagger.html)), the `generate-routes.js` build output, or — as a last resort — a network generated in-browser from the country data. `flight-tagger.html` is a one-off tool: it auto-detects the city dots in `maps/andah-city-dots.png`, overlays them on `maps/andah-political.png`, lets you label each with a city + nation, and exports `flight-cities.json`. The gravity model + render tunables live in [`views/flight-config.js`](views/flight-config.js).

### Individual scripts

```bash
npm run build:data     # xlsx → data/countries.json
npm run build:routes   # gravity model → data/airports.json + data/routes.json
npm run build:intros   # → data/intros.json
npm run build:wiki     # Miraheze API → wiki/*.html + data/wiki-index.json
npm run build:fifa     # build-fifa-data.js (World Cup sim data)
```

## Local development

Requires **Node ≥ 20**.

```bash
npm install

# Fast loop — data only, skip the network-bound wiki fetch
SKIP_WIKI=1 npm run build

# Full build
npm run build

# Serve the site locally
npm run serve
```

Then open <http://localhost:3000/index.html> (or `/explore.html`, `/wiki/`).

## Deployment

Netlify builds from `netlify.toml`: it runs `npm run build` and publishes the repo root. Two pieces of config live in the Netlify UI (not in the repo):

- `MIRAHEZE_USER_AGENT` — descriptive UA for the wiki fetch, e.g. `AndahGames/1.0 (https://www.djmapping.com)`.
- `NETLIFY_BUILD_HOOK_URL` — used by the scheduled function [`netlify/functions/trigger-rebuild.js`](netlify/functions/trigger-rebuild.js), which POSTs to the build hook daily to refresh the data + wiki mirror.

Pretty wiki URLs (`/wiki/<slug>` → `/wiki.html?p=<slug>`) are handled by a redirect in `netlify.toml`. Full operator setup is in [`docs/datasets.md`](docs/datasets.md).

---

Made by **DJMapping**. Data sourced from the [Andah Miraheze Wiki](https://andah.miraheze.org/wiki/Main_Page).
