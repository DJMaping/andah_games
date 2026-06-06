// Scheduled function: hits the Netlify build hook once per day to refresh the
// pre-built wiki mirror. Set NETLIFY_BUILD_HOOK_URL in the Netlify UI to a
// build hook you create under Site settings > Build & deploy > Build hooks.

import { schedule } from '@netlify/functions';

export const handler = schedule('@daily', async () => {
    const hook = process.env.NETLIFY_BUILD_HOOK_URL;
    if (!hook) {
        return {
            statusCode: 500,
            body: 'NETLIFY_BUILD_HOOK_URL is not set'
        };
    }
    const res = await fetch(hook, { method: 'POST' });
    return {
        statusCode: res.ok ? 200 : 502,
        body: res.ok ? 'rebuild triggered' : `hook failed: ${res.status}`
    };
});
