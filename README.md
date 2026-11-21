# GAZ Walkie-Talkie

Push-to-talk walkie-talkie for phones and browsers.

- **Web app:** https://talk.gazgoc.com.ng (also served at https://gaz-walkie.ioghenevwogaga.workers.dev)
- **Voice relay:** Cloudflare Worker + Durable Object (`worker.js`), deployed automatically from this repo on every push to `main`.

## How it works
- Everyone on the same channel hears whoever holds the talk button; one speaker per channel at a time.
- Tap a person to talk to them privately.
- Voice is sent as 8 kHz mu-law (walkie-talkie quality, about 8 KB/s while talking).

## Files
- `worker.js` – the relay (WebSocket endpoint at `/ws`, health check at `/health`).
- `wrangler.jsonc` – Cloudflare config (Durable Object binding and migration).
