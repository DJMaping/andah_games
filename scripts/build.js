#!/usr/bin/env node
// Build orchestrator: data pipeline first, wiki fetch second.
// Each step is opt-out via env (SKIP_DATA=1, SKIP_WIKI=1).

import { buildData } from './build-data.js';
import { fetchWiki } from './fetch-wiki.js';
import { extractIntros } from './extract-intros.js';
import { buildRoutes } from './generate-routes.js';
import { bakeFlightNetwork } from './bake-flight-network.js';

async function main() {
    if (process.env.SKIP_DATA !== '1') {
        console.log('--- build:data ---');
        await buildData();
    } else {
        console.log('SKIP_DATA=1, skipping data pipeline.');
    }

    if (process.env.SKIP_ROUTES !== '1') {
        console.log('--- build:routes ---');
        await buildRoutes();
    } else {
        console.log('SKIP_ROUTES=1, skipping flight-route generation.');
    }

    if (process.env.SKIP_FLIGHT !== '1') {
        console.log('--- build:flight ---');
        await bakeFlightNetwork();
    } else {
        console.log('SKIP_FLIGHT=1, skipping flight-network bake.');
    }

    if (process.env.SKIP_INTROS !== '1') {
        console.log('--- build:intros ---');
        await extractIntros();
    } else {
        console.log('SKIP_INTROS=1, skipping intros pipeline.');
    }

    if (process.env.SKIP_WIKI !== '1') {
        console.log('--- build:wiki ---');
        await fetchWiki();
    } else {
        console.log('SKIP_WIKI=1, skipping wiki pipeline.');
    }

    console.log('Build complete.');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
