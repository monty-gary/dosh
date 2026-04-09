# dosh

Realtime shared expense splitting app with weighted ratios.

## Stack
- `backend/`: Node.js + WebSocket server, server-authoritative state
- `frontend/`: Vite + React + TypeScript client

## Product flow
1. Password gate
2. Add expenses and see shared balances + settle-up plan update live for everyone

## Data model
- participants (named clients)
- expenses (`description`, `amount`, `paidBy`, weighted beneficiaries)
- derived balances
- derived settle-up transfers

## Scripts
From repo root:

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Other checks:

```bash
npm run build
npm run check:backend
```

## Environment
Backend supports:
- `PORT` (default `3000`)
- `DOSH_PASSWORD` (default `money`)
- `CORS_ORIGIN` (default `*`)
- `DOSH_TOKEN_SECRET` (default `dosh-demo-token-secret`) – secret key for signing session tokens across instances.
- `DOSH_TOKEN_TTL_MS` (default `0`, meaning no expiration) – optional TTL in milliseconds for issued tokens.

Frontend supports:
- `VITE_API_BASE_URL` (optional; defaults to `http://localhost:3000` on localhost)

## Deploy
- Frontend is configured for GitHub Pages under `/dosh/` via `.github/workflows/pages.yml` (runs on pushes to `main` and `dev`).
- Production API calls should target your hosted backend (for example Render):
  - Set `VITE_API_BASE_URL` at build time, or
  - Update `PRODUCTION_FALLBACK_API` in `frontend/src/api.ts`.
- Local development behavior is unchanged: `localhost` still uses `http://localhost:3000`.
