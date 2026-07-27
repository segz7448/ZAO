# ZAO Backend Discovery Worker

Lets the phone app automatically learn the PC's current Cloudflare
Tunnel URL, with nobody ever typing or copying a URL by hand. See
`discovery-worker.js`'s own header comment for the full explanation of
why this exists and how it fits together with
`server/scripts/setup-permanent-tunnel.js`.

## Deploy (one-time, from this folder)

```
npm install -g wrangler        # if you don't have it already
wrangler login

wrangler kv:namespace create ZAO_DISCOVERY
# copy the "id" it prints into wrangler.toml's kv_namespaces section

wrangler secret put PUBLISH_TOKEN
# paste any secret value when prompted - setup-permanent-tunnel.js will
# ask you for this same value later

wrangler deploy
```

The last command prints your Worker's URL, something like:
`https://zao-discovery.<your-subdomain>.workers.dev`

That URL is permanent (it's Cloudflare's own workers.dev domain, not a
rotating tunnel) - put it into the app once, in Settings > Backend
Connection > Discovery Worker URL. After that, the app looks up its own
backend URL automatically every time it needs it; you never touch a URL
again, even if the PC's tunnel gets recreated.
