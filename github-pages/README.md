# GitHub Pages version

A static, server-less version of the app: the calculation that `app.py` does
in Python runs in the browser instead (`index.html`).

The PVGIS API does not send CORS headers, so a browser can't call it directly.
A small Cloudflare Worker (`worker/`) forwards the PVGIS endpoints the app
uses (`PVcalc`, `DRcalc`, `printhorizon`, and single-year `seriescalc` for the
power planner) and adds the missing header. It also caches
PVGIS results at the edge for 30 days, so repeated calculations are fast.
Address search calls OpenStreetMap Nominatim directly (it allows CORS).

```
Browser (GitHub Pages) ──> Cloudflare Worker ──> re.jrc.ec.europa.eu/api/v5_3
          └──────────────> nominatim.openstreetmap.org
```

## 1. Deploy the Cloudflare Worker (free tier is enough)

```bash
cd github-pages/worker
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the worker URL, e.g.
`https://pvgis-proxy.<your-subdomain>.workers.dev`.

`ALLOWED_ORIGINS` in `wrangler.toml` lists the sites allowed to use the proxy
(`https://felix-albrecht.github.io` and `http://localhost:8000`). Requests from
other origins get a 403, so the worker can't be used as an open proxy for your
site. Note that this only stops other *websites*; scripts that fake the
`Origin` header can still call it, which is fine for a proxy restricted to
two read-only PVGIS endpoints.

## 2. Point the page at the worker

In `index.html`, set:

```js
const PROXY_URL = 'https://pvgis-proxy.<your-subdomain>.workers.dev';
```

## 3. Publish on GitHub Pages

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `master`. The workflow `.github/workflows/pages.yml` publishes
   `github-pages/index.html` whenever something in `github-pages/` changes
   (or run it manually from the Actions tab).
3. The app is then at `https://felix-albrecht.github.io/PV-production-predictor/`.

## Local testing

```bash
cd github-pages/worker && npx wrangler dev          # worker on http://localhost:8787
```

```bash
cd github-pages && python3 -m http.server 8000      # page on http://localhost:8000 (modules need http, not file://)
```

Temporarily set `PROXY_URL = 'http://localhost:8787'` in `index.html`.

## Differences from the Flask version

- Sections are calculated in parallel instead of one after another.
- Results are cached in the browser tab (per parameter set) and at the
  Cloudflare edge, instead of in the Flask process.
- Both PVGIS calls per section run in parallel.
