# Congress Vibe Check

A web app that presents congressional voting activity through the lens of absurd (and occasionally insightful) correlations. Think "Is the full moon making Congress weird?" meets "Who paid for that vote?"

## Stack

- **Frontend**: React + TypeScript + Tailwind CSS (Vite)
- **API Layer**: Cloudflare Workers (Hono) — proxies and caches external APIs
- **Hosting**: Cloudflare Pages (frontend) + Cloudflare Workers (API)

## Data Sources (Phase 1 / Tier 1)

- **Congress.gov API** — bills, votes, members, amendments
- **OpenFEC API** — campaign contributions, candidate financials
- **Open-Meteo** — historical weather data (DC)
- **USGS Earthquake API** — seismic activity
- **Sunrise-Sunset API** — daylight data
- **Lunar phase** — computed (no external API)

## Development

### Frontend

```bash
npm install
npm run dev        # starts Vite dev server on :5175
```

### API (Cloudflare Worker)

```bash
cd api
npm install
npm run dev        # starts Wrangler dev server on :8787
```

The Vite dev server proxies `/api/*` requests to the Worker dev server automatically.

### API Keys

The Worker needs two secrets for full functionality:

```bash
cd api
wrangler secret put CONGRESS_API_KEY    # from api.data.gov
wrangler secret put OPENFEC_API_KEY     # from api.open.fec.gov
```

For local development, create `api/.dev.vars`:

```
CONGRESS_API_KEY=your_key_here
OPENFEC_API_KEY=your_key_here
```

## Deployment

### Frontend (Cloudflare Pages)

```bash
npm run build      # outputs to dist/
```

### API (Cloudflare Worker)

```bash
cd api
npm run deploy
```

## Project Structure

```
├── api/                   # Cloudflare Worker (Hono)
│   └── src/
│       ├── apis/          # Individual API wrappers
│       ├── index.ts       # Worker entry point
│       └── types.ts       # Environment types
├── src/                   # React frontend
│   ├── components/        # UI components (search panels)
│   ├── hooks/             # useApi hook
│   ├── App.tsx            # Main app with tab navigation
│   └── index.css          # Tailwind + custom styles
├── public/                # Static assets + headers/redirects
└── package.json           # Frontend dependencies
```
