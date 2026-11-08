# AGENTS.md

Standalone payment module for Tero Restro & Cafe. The main app is a separate private Next.js/Vercel repo, so don't recreate menu or ordering features here. See README.md for the merge roadmap.

## Layout
- `db/schema.ts`: Drizzle schema. All tables are prefixed `payment_` or `billing_`. Migrations live in `netlify/database/migrations/` (generate them with `npx drizzle-kit generate --name …` and never edit applied ones).
- `src/payments/core.ts`: pure helpers (paise math, UTR and session validation).
- `src/payments/service.ts`: bill sync, submit, approve, reject, exception close, receipt and admin overview.
- `src/payments/router.ts`: all `/api/payments/*` routes as `(Request) => Response`. `netlify/functions/payments.mts` is a thin wrapper around it.
- Connection points to swap when merging: `orders-source.ts`, `auth.ts` (getAdmin), `qr-storage.ts`, `db/index.ts`.
- `sheets.ts`: upserts rows by Record ID in column A of the "Payments" tab.
- `public/`: static pages. `assets/ui.js` builds the DOM with textContent only; don't use innerHTML.
- `tests/`: node:test with PGlite and a mocked Blobs store (`npm test`).

## Rules and non-obvious decisions
- Money is always integer **paise**. The server recomputes the bill; it never trusts amounts sent by the client.
- Customers can only set a bill to PAYMENT_PENDING. PAID and REJECTED are admin-only, applied with a conditional UPDATE inside a transaction. Partial unique indexes block duplicate UTRs and double confirmation.
- A bill is frozen while PAYMENT_PENDING, PAID or closed. Closing with an exception keeps its paymentStatus and sets closeType to ADMIN_EXCEPTION.
- Staff auth is an HMAC-signed HttpOnly SameSite=Strict cookie with an Origin check on mutations. Failed logins are rate-limited through the audit log.
- Session ids match `TBL-<table|Counter>-<ms>`, the same format and localStorage key (`activeSessionId`) the main app uses.
