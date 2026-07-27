#!/usr/bin/env node
/**
 * ZAO - Permanent Cloudflare Tunnel Setup
 *
 * WHY THIS EXISTS: start.bat's default (`cloudflared tunnel --url ...`,
 * a "Quick Tunnel") gets a brand new random hostname
 * (https://random-words-1234.trycloudflare.com) every single time it
 * starts - Cloudflare's Quick Tunnels are anonymous by design and don't
 * support a fixed hostname at all. That means re-entering the Remote URL
 * in the app's Settings every time the PC restarts the tunnel.
 *
 * This script uses Cloudflare's real API (needs an API token, see setup
 * below) to instead create a NAMED tunnel tied to your own Cloudflare
 * account, which gets a hostname that never changes
 * (e.g. https://zao.yourdomain.com) - run this once, then every future
 * start.bat run reuses the same URL forever.
 *
 * HARD REQUIREMENT, NOT OPTIONAL: a permanent hostname can only exist on
 * a domain - there is no way to get a stable public URL from Cloudflare
 * without one, API token or not (this is how DNS works, not a
 * Cloudflare restriction). If you don't have a domain in your Cloudflare
 * account yet, add one first (Cloudflare doesn't sell domains itself,
 * but accepts domains bought anywhere - Namecheap, Porkbun, a free
 * provider, etc.) - then come back and run this script.
 *
 * ALSO PUBLISHES TO THE DISCOVERY WORKER (optional, but this is what
 * makes the phone never need the hostname typed in at all - see
 * cloudflare-worker/discovery-worker.js): after creating the tunnel,
 * this script generates a random per-install deviceId (saved locally so
 * re-runs reuse it) and POSTs the resulting hostname to your deployed
 * discovery Worker. The phone app then looks its backend URL up by that
 * same deviceId automatically (src/services/backend/discoveryClient.js)
 * instead of anyone typing a URL into Settings. Skip this step (leave
 * the Worker URL prompt blank) if you'd rather just copy the hostname
 * into Settings manually once - the tunnel itself works either way.
 *
 * ONE-TIME SETUP:
 *   1. Add a domain to your Cloudflare account (dash.cloudflare.com),
 *      if you haven't already.
 *   2. Create an API token at https://dash.cloudflare.com/profile/api-tokens
 *      - use the "Edit Cloudflare Workers" template, or a custom token
 *        with these permissions: Account.Cloudflare Tunnel:Edit,
 *        Zone.DNS:Edit (scoped to your zone).
 *   3. (Optional but recommended) Deploy the discovery Worker first -
 *      see cloudflare-worker/README.md - so this script can publish to
 *      it in the same run.
 *   4. Run:  node server/scripts/setup-permanent-tunnel.js
 *      It will prompt for your API token, domain, desired subdomain
 *      (e.g. "zao" for zao.yourdomain.com), and optionally your
 *      discovery Worker's URL + publish token.
 *   5. It writes server/tunnel-config.json and a credentials file under
 *      server/.cloudflared/ - start.bat automatically detects these on
 *      its next run and uses the named tunnel instead of a Quick Tunnel.
 *
 * This only needs to run ONCE per PC. Re-run it only if you want to
 * change the subdomain, rotate the tunnel, or point it at a different
 * Cloudflare account - re-running always re-publishes to the same
 * deviceId, so the phone picks up the change automatically with no
 * Settings edit needed.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEVICE_ID_PATH = path.join(__dirname, '..', '.zao-device-id');
const CONFIG_PATH = path.join(__dirname, '..', 'tunnel-config.json');
const CREDS_DIR = path.join(__dirname, '..', '.cloudflared');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

/**
 * Same as ask(), but masks what's typed with asterisks instead of
 * echoing it in plain text - used for the two real secrets this script
 * asks for (the Cloudflare API token, the discovery Worker's publish
 * token). Plain readline.question() echoes input as typed, which is
 * fine for a domain name or subdomain choice but not for a credential
 * with real account access - someone screen-sharing, recording their
 * terminal, or with someone else in the room shouldn't have a real
 * secret shown on screen as they type it.
 */
function askSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let input = '';
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(input.trim());
        return;
      }
      if (char === '\u0003') {
        // Ctrl+C - let the process exit normally rather than swallowing it silently.
        process.stdout.write('\n');
        process.exit(1);
      }
      if (char === '\u007f' || char === '\b') {
        // Backspace - remove the last character and its displayed asterisk.
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      input += char;
      process.stdout.write('*');
    };

    stdin.on('data', onData);
  });
}

async function cfFetch(apiToken, endpoint, options = {}) {
  const res = await fetch(`${CF_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    const message = json.errors?.map((e) => e.message).join('; ') || res.statusText;
    throw new Error(`Cloudflare API error (${res.status}): ${message}`);
  }
  return json;
}

async function main() {
  console.log('=== ZAO Permanent Cloudflare Tunnel Setup ===\n');

  if (fs.existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    console.log(`A tunnel is already configured: https://${existing.hostname}`);
    const redo = await ask('Set up a new one and replace it? (y/N): ');
    if (redo.toLowerCase() !== 'y') {
      console.log('Keeping existing setup. Nothing changed.');
      return;
    }
  }

  const apiToken = await askSecret('Cloudflare API token (from dash.cloudflare.com/profile/api-tokens): ');
  if (!apiToken) throw new Error('An API token is required.');

  console.log('\nLooking up your account and zones...');
  const accountsRes = await cfFetch(apiToken, '/accounts');
  const accounts = accountsRes.result || [];
  if (!accounts.length) throw new Error('No Cloudflare account found for this token. Check the token has Account-level access.');
  const accountId = accounts[0].id;
  console.log(`Using account: ${accounts[0].name} (${accountId})`);

  const zonesRes = await cfFetch(apiToken, '/zones');
  const zones = zonesRes.result || [];
  if (!zones.length) {
    throw new Error(
      'No domains (zones) found in this Cloudflare account. A permanent tunnel needs a domain - ' +
      'add one at dash.cloudflare.com first (Cloudflare doesn\'t sell domains, but accepts ones bought elsewhere), then re-run this script.'
    );
  }
  console.log('\nDomains available in this account:');
  zones.forEach((z, i) => console.log(`  ${i + 1}. ${z.name}`));
  const zoneChoice = zones.length === 1 ? '1' : await ask(`Which domain? (1-${zones.length}): `);
  const zone = zones[Number(zoneChoice) - 1];
  if (!zone) throw new Error('Invalid choice.');

  const subdomain = (await ask('Subdomain for ZAO (e.g. "zao" for zao.' + zone.name + '): ')) || 'zao';
  const hostname = `${subdomain}.${zone.name}`;

  const tunnelName = `zao-${crypto.randomBytes(3).toString('hex')}`;
  console.log(`\nCreating tunnel "${tunnelName}"...`);
  const tunnelSecret = crypto.randomBytes(32).toString('base64');
  const createRes = await cfFetch(apiToken, `/accounts/${accountId}/cfd_tunnel`, {
    method: 'POST',
    body: JSON.stringify({ name: tunnelName, tunnel_secret: tunnelSecret }),
  });
  const tunnel = createRes.result;
  console.log(`Tunnel created: ${tunnel.id}`);

  // Point the tunnel at the local backend (see config.js's PORT).
  console.log('Configuring tunnel route -> http://localhost:8080 ...');
  await cfFetch(apiToken, `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: 'http://localhost:8080' },
          { service: 'http_status:404' },
        ],
      },
    }),
  });

  console.log(`Pointing ${hostname} at the tunnel (DNS)...`);
  await cfFetch(apiToken, `/zones/${zone.id}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CNAME',
      name: subdomain,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
    }),
  }).catch(async (err) => {
    // A record for this subdomain may already exist from a previous
    // attempt - that's fine, not fatal, cloudflared will still work as
    // long as it eventually points at this tunnel's id.
    if (!/already exists/i.test(err.message)) throw err;
    console.log('  (DNS record already existed - leaving it as-is; update it manually in the dashboard if it points at a different tunnel.)');
  });

  // cloudflared needs a local credentials file (tunnel id + secret) to
  // run this named tunnel - this is the on-disk equivalent of what
  // `cloudflared tunnel login` + `cloudflared tunnel create` would have
  // produced interactively; writing it directly here is what lets this
  // whole setup happen via the API with no browser login step.
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  const credsPath = path.join(CREDS_DIR, `${tunnel.id}.json`);
  fs.writeFileSync(credsPath, JSON.stringify({
    AccountTag: accountId,
    TunnelSecret: tunnelSecret,
    TunnelID: tunnel.id,
  }, null, 2));
  // Owner-read/write only - this file is a real secret (the tunnel's
  // credential, equivalent to a password for it), and on a shared PC
  // the default file permissions would otherwise let any other local
  // account read it. chmod is a no-op on Windows (NTFS permissions work
  // differently and this call is simply ignored there rather than
  // throwing), so this only tightens things on macOS/Linux where it
  // actually applies - not a regression on Windows either way.
  try { fs.chmodSync(credsPath, 0o600); } catch (err) { /* best-effort */ }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    tunnelId: tunnel.id,
    tunnelName,
    hostname,
    credentialsFile: credsPath,
  }, null, 2));

  console.log('\n=== Tunnel created ===');
  console.log(`Your permanent URL: https://${hostname}`);
  console.log('(DNS can take a minute or two to start resolving.)');

  await maybePublishToDiscoveryWorker(hostname);

  console.log('\nFrom now on, start.bat will automatically use this named tunnel instead of a rotating Quick Tunnel.');
}

/**
 * Optional step: if the person has deployed the discovery Worker (see
 * cloudflare-worker/README.md), publish this hostname to it so the
 * phone app finds it automatically - see discoveryClient.js on the
 * phone side. Skippable (blank Worker URL) for anyone who'd rather just
 * paste the hostname into Settings manually once.
 */
async function maybePublishToDiscoveryWorker(hostname) {
  console.log('\n--- Optional: auto-publish to your discovery Worker ---');
  console.log('(So the phone app finds this URL automatically - no manual Settings entry.');
  console.log(' Leave blank to skip and enter the URL into Settings yourself instead.)');
  const workerUrl = await ask('Discovery Worker URL (e.g. https://zao-discovery.you.workers.dev), or blank to skip: ');
  if (!workerUrl) {
    console.log('Skipped - remember to paste the URL above into the app\'s Settings > Backend Connection > Remote URL.');
    return;
  }
  const publishToken = await askSecret('Discovery Worker publish token (the one you set with `wrangler secret put PUBLISH_TOKEN`): ');
  if (!publishToken) {
    console.log('No token given - skipping publish. You can re-run this script later to publish.');
    return;
  }

  // One random id per PC install, generated once and reused on every
  // re-run so the phone keeps looking up the same key even after the
  // tunnel is recreated - this file is what ties "this PC" to "this
  // phone's lookup" together; back it up if you ever migrate to a new PC.
  let deviceId;
  if (fs.existsSync(DEVICE_ID_PATH)) {
    deviceId = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
  } else {
    deviceId = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(DEVICE_ID_PATH, deviceId);
    try { fs.chmodSync(DEVICE_ID_PATH, 0o600); } catch (err) { /* best-effort, see credsPath's own chmod comment above */ }
  }

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, '')}/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${publishToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deviceId, hostname }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || res.statusText);
    console.log('\nPublished! The phone app will now find this backend automatically.');
    console.log(`Enter these ONCE in the app's Settings > Backend Connection > Auto-discovery:`);
    console.log(`  Discovery Worker URL: ${workerUrl}`);
    console.log(`  Device ID: ${deviceId}`);
    console.log('After that one-time entry, you never need to touch a URL again, even if this tunnel is recreated.');
  } catch (err) {
    console.log(`\nCould not publish to the discovery Worker: ${err.message}`);
    console.log('The tunnel itself still works - just paste the hostname into Settings manually, or fix the Worker URL/token and re-run this script.');
  }
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exitCode = 1;
});
