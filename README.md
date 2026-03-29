# dosh

Realtime shared expense splitting app with weighted ratios.

## Stack
- `backend/`: Node.js + WebSocket server, server-authoritative state
- `frontend/`: Vite + React + TypeScript client

## Product flow
1. Password gate (`money` by default)
2. Enter your display name
3. Add expenses and see shared balances + settle-up plan update live for everyone

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

Frontend supports:
- `VITE_API_BASE_URL` (optional; defaults to `http://localhost:3000` on localhost)
