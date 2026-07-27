/**
 * ZAO - Backend Discovery Worker
 *
 * WHAT THIS IS FOR: the phone app needs to learn the PC's current
 * backend URL (the Cloudflare Tunnel hostname from
 * setup-permanent-tunnel.js) WITHOUT the person ever typing it in - see
 * that script's own header and server/README.md for why a URL has to
 * exist somewhere even though nobody wants to see or type it.
 *
 * This Worker is that "somewhere": a tiny, permanent, always-the-same
 * URL (this Worker's own workers.dev address, or a custom route you
 * attach it to) that the phone can always reach, which looks up the
 * PC's CURRENT tunnel hostname in KV and returns it. The PC-side setup
 * script (setup-permanent-tunnel.js) is what WRITES that KV entry every
 * time it creates or changes a tunnel; this Worker only ever READS it.
 *
 * FLOW:
 *   1. setup-permanent-tunnel.js creates the Cloudflare Tunnel (as
 *      before) AND calls this Worker's /publish endpoint to store the
 *      resulting hostname in KV, keyed by a random per-install deviceId
 *      the script generates once and saves locally.
 *   2. The phone app (see src/services/backend/discoveryClient.js)
 *      calls this Worker's /lookup endpoint with that same deviceId on
 *      launch, gets back the current hostname, and uses it as
 *      backend_remote_url automatically - no manual Settings entry.
 *
 * SECURITY: deviceId acts as a shared secret between one person's phone
 * and their own PC - anyone who has it can read (not write) that one
 * KV entry, so treat it like a password. /publish requires a
 * Bearer token (PUBLISH_TOKEN, set as a Worker secret) so only the
 * PC-side script - which has that token from config.js's AUTH_TOKEN
 * setup - can write entries; /lookup only requires knowing the
 * deviceId, since the phone has no separate secret store to protect a
 * second token in.
 *
 * DEPLOY:
 *   1. Create a KV namespace: wrangler kv:namespace create ZAO_DISCOVERY
 *   2. Put its id in wrangler.toml (see the companion file)
 *   3. Set the publish token:  wrangler secret put PUBLISH_TOKEN
 *      (use the same value as config.js's AUTH_TOKEN, or any secret -
 *      setup-permanent-tunnel.js will ask for whichever you choose)
 *   4. wrangler deploy
 *   5. Note the resulting workers.dev URL - that's what
 *      discoveryClient.js on the phone is configured to call, and what
 *      setup-permanent-tunnel.js publishes to.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/publish' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const expected = `Bearer ${env.PUBLISH_TOKEN}`;
      if (!constantTimeEqual(auth, expected)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch (err) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
      }
      const { deviceId, hostname } = body || {};
      if (!deviceId || typeof deviceId !== 'string' || deviceId.length < 16) {
        return jsonResponse({ error: 'deviceId is required and must be a real random id (16+ chars)' }, 400);
      }
      if (!hostname || typeof hostname !== 'string') {
        return jsonResponse({ error: 'hostname is required' }, 400);
      }
      await env.ZAO_DISCOVERY.put(deviceId, JSON.stringify({ hostname, updatedAt: Date.now() }));
      return jsonResponse({ success: true });
    }

    if (url.pathname === '/lookup' && request.method === 'GET') {
      const deviceId = url.searchParams.get('deviceId');
      if (!deviceId) return jsonResponse({ error: 'deviceId query param is required' }, 400);
      const stored = await env.ZAO_DISCOVERY.get(deviceId);
      if (!stored) return jsonResponse({ error: 'No backend registered for this deviceId yet' }, 404);
      const parsed = JSON.parse(stored);
      return jsonResponse({ success: true, hostname: parsed.hostname, updatedAt: parsed.updatedAt });
    }

    return jsonResponse({ error: 'Not found. Use POST /publish or GET /lookup?deviceId=...' }, 404);
  },
};

/**
 * Constant-time string comparison - a plain `a !== b` check on a secret
 * token is vulnerable to a timing attack (an attacker measuring tiny
 * response-time differences to guess the token one character at a time),
 * which matters here specifically because this is a public-facing
 * Worker endpoint anyone on the internet can hit repeatedly. Uses the
 * Web Crypto API's timingSafeEqual-equivalent approach available in the
 * Workers runtime - XORs every byte regardless of where a mismatch
 * occurs, so comparison time never depends on how many characters
 * matched before the first difference.
 */
function constantTimeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    // Different lengths can never be equal, but returning immediately
    // would itself leak timing info (a short guess fails faster than a
    // long one) - compare aBytes against itself for the same amount of
    // work before returning false, so the timing is indistinguishable
    // from a same-length mismatch.
    let result = 0;
    for (let i = 0; i < aBytes.length; i++) result |= aBytes[i] ^ aBytes[i];
    return false;
  }
  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
