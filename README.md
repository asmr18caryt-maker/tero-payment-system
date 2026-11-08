# Tero Payment Module

Manual **UPI QR** and **Bank Transfer** billing for Tero Restro & Cafe. Payments stay **PAYMENT_PENDING** until a staff member verifies them, and approving a payment closes the table session and creates a digital receipt. Payments are also synced to Google Sheets.

**Stack:** Netlify Functions (TypeScript) · Postgres via Drizzle ORM (Netlify Database / Neon) · Netlify Blobs (QR image) · vanilla HTML/JS pages · Google Sheets API (service account).

## Pages
- `/pay/?table=5&session=TBL-5-…`: running bill, PAY BILL, checkout, payment status
- `/receipt/?bill=…&session=…`: digital receipt
- `/kitchen/payments/`: staff verification, bills, settings, test orders

## Run locally
```bash
npm install
npm test                                     # 17 unit + integration tests (in-memory Postgres)
PAYMENT_ADMIN_PASSWORD=yourpass netlify dev --port 8889
```

## Environment variables
`PAYMENT_ADMIN_PASSWORD` (required), `PAYMENT_SESSION_SECRET`, `GOOGLE_SHEETS_SPREADSHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_SHEETS_PAYMENTS_TAB`.

## Roadmap: merging into the existing Tero app (Next.js on Vercel)
1. Mount `routePaymentRequest` from `src/payments/router.ts` at `app/api/payments/[...path]/route.ts`.
2. Change `src/payments/orders-source.ts` to read the existing orders table, using prices from the server-side menu.
3. Change `getAdmin()` in `src/payments/auth.ts` to check the existing kitchen sign-in.
4. Change `src/payments/qr-storage.ts` to use Vercel Blob, and change `db/index.ts` to use the Neon driver.
5. Add a PAY BILL link to the existing View Running Bill sheet, and call `isSessionClosed()` in `POST /api/orders`.
6. Apply the SQL in `netlify/database/migrations/` to Neon. It only creates new `payment_*` and `billing_*` tables.
