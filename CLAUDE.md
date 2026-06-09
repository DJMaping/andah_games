# Andah Games — Claude Code Guide

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

```
index.html              Landing page / game menu
*.html                  One file per game + explore.html / wiki.html
css/                    Shared styles
js/                     Page scripts + hand-authored data (capitals, cities, stats, map coords)
views/                  Explorer modules (map, table, charts, time-series, wiki view, formatting)
data/                   Build outputs (countries.json, wiki-index.json, intros.json, airports/routes)
flags/                  Flag images (one per country)
maps/                   World map image (andah-political.png, andah-city-dots.png)
.xlsx files/            Source spreadsheets for the data pipeline
scripts/                Build scripts
netlify/functions/      Scheduled function for daily Netlify rebuild trigger
docs/datasets.md        Operator guide for datasets and wiki rebuilds
```

## Build pipeline

`npm run build` runs `scripts/build.js`, which orchestrates:

| Step | Script | Output | Skip env var |
|------|--------|--------|--------------|
| Data | `build-data.js` | `data/countries.json` from `.xlsx files/` | `SKIP_DATA=1` |
| Routes | `generate-routes.js` | `data/airports.json` + `data/routes.json` | `SKIP_ROUTES=1` |
| Intros | `extract-intros.js` | `data/intros.json` | `SKIP_INTROS=1` |
| Wiki | `fetch-wiki.js` | `wiki/*.html` + `data/wiki-index.json` | `SKIP_WIKI=1` |

Fast local loop (skips slow wiki fetch):
```bash
SKIP_WIKI=1 npm run build
```

The wiki step requires `MIRAHEZE_USER_AGENT` env var (e.g. `AndahGames/1.0 (https://www.djmapping.com)`), or Miraheze will reject requests.

## Data conventions

`data/countries.json` is built from `.xlsx files/`. In those spreadsheets:
- Numeric columns → metrics
- String columns → categorical filters
- `<metric>_history` sheets → time-series data

Labels and formatting overrides go in `data-sources.json`. Full details in `docs/datasets.md`.

## Flight network

`flight-network.html` loads airports from (in priority order):
1. `data/flight-cities.json` — hand-tagged via `flight-tagger.html`
2. `generate-routes.js` build output
3. In-browser fallback generated from country data

Gravity model tunables live in `views/flight-config.js`.

## Deployment

Netlify builds from `netlify.toml` (`npm run build`, publishes repo root). Two env vars must be set in the Netlify UI:
- `MIRAHEZE_USER_AGENT` — for the wiki fetch
- `NETLIFY_BUILD_HOOK_URL` — used by `netlify/functions/trigger-rebuild.js` to trigger a daily rebuild
