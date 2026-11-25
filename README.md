# INTEL CEG MYS RETRO NIGHT • SHAKE-it CHALLENGE

Phone shake game for ~150 players: phones are controllers, the big screen shows the live race.

## Two versions

| Version | Phones (QR code) | Big screen | Backend |
|---|---|---|---|
| **Cloudflare** (main) | https://hanif1993.github.io/CEG-Retro-Shake/ | https://hanif1993.github.io/CEG-Retro-Shake/screen.html?key=YOUR_HOST_KEY | Cloudflare Worker + Durable Object (`cloudflare-server/`) |
| **Supabase** (backup) | https://hanif1993.github.io/CEG-Retro-Shake/supabase/ | https://hanif1993.github.io/CEG-Retro-Shake/supabase/screen.html | Supabase Realtime |

The QR code on each big screen points to the matching phone page automatically.

## Cloudflare server (`cloudflare-server/`)

- `worker.js` — game server: runs the round timer, keeps every score, only the big screen (with `HOST_KEY`) can start/reset.
- `wrangler.toml` — Cloudflare config (Workers Free plan, SQLite Durable Object).

Deploy (no install needed): Cloudflare dashboard → Workers & Pages → Create → Import a repository →
this repo, **Root directory = `cloudflare-server`**, project name `ceg-retro-shake`.
Live server: https://ceg-retro-shake.m-hanifhalim93.workers.dev (check `/health` → `ok`).
Every push to `main` redeploys it automatically.

Then add the secret **`HOST_KEY`** (Settings → Variables and Secrets) — that's the big-screen password.

Or from a PC with Node.js:

```bash
cd cloudflare-server
npx wrangler login
npx wrangler deploy
npx wrangler secret put HOST_KEY
```

After deploying, `WORKER_URL` at the top of the script in `index.html` and `screen.html` must be the
Worker address (`https://ceg-retro-shake.<your-subdomain>.workers.dev`). Check it with `/health` → `ok`.

## Event-day checklist

- Rehearse with 20+ real phones (iPhone + Android) on the venue Wi-Fi, then press **RESET ALL**.
- Laptop: plugged in, sleep off, big screen in its own full-screen window.
- MC: "Open in Safari/Chrome, tap Allow, keep your screen on."
- Cloudflare free quota resets daily at 8 am Malaysia time (00:00 UTC).
