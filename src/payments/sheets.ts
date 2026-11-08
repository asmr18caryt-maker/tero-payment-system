/**
 * Google Sheets sync for payment records.
 *
 * Writes one row per payment (or per exception-closed bill) to a dedicated
 * "Payments" tab, keyed by Record ID in column A. Re-syncing the same record
 * UPDATES its row in place, so status changes never create duplicate rows and
 * existing order rows/tabs are never touched.
 *
 * Uses a Google service account (the same credentials as the existing order
 * sync can be reused). If not configured, sync is skipped silently and the
 * payment flow is unaffected.
 */
import { createSign } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bills, payments } from "../../db/schema.js";
import { formatIST, METHOD_LABELS, type PaymentMethod } from "./core.js";

const HEADER = [
  "Record ID",
  "Bill ID",
  "Table Session ID",
  "Table",
  "Payment Method",
  "UTR / Reference",
  "Amount Paid (₹)",
  "Bill Amount (₹)",
  "Payment Status",
  "Submitted At (IST)",
  "Verified At (IST)",
  "Verified By",
  "Receipt No.",
  "Notes",
];
const LAST_COL = "N";

function config() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!spreadsheetId || !email || !key) return null;
  return { spreadsheetId, email, key, tab: process.env.GOOGLE_SHEETS_PAYMENTS_TAB || "Payments" };
}

export function sheetsConfigured() {
  return config() !== null;
}

let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(email: string, key: string): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`Google auth failed (${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function upsertRow(row: (string | number)[]) {
  const cfg = config();
  if (!cfg) return;
  const token = await accessToken(cfg.email, cfg.key);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${cfg.spreadsheetId}/values`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const tab = `'${cfg.tab.replace(/'/g, "''")}'`;
  const call = async (url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json() as Promise<any>;
  };

  const colA = await call(`${base}/${encodeURIComponent(`${tab}!A:A`)}`, { method: "GET" });
  const ids: string[] = (colA.values ?? []).map((r: string[]) => r[0]);
  if (!ids.length) {
    await call(`${base}/${encodeURIComponent(`${tab}!A1:${LAST_COL}1`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [HEADER] }),
    });
    ids.push(HEADER[0]);
  }
  const idx = ids.indexOf(String(row[0]));
  if (idx >= 0) {
    const r = idx + 1;
    await call(`${base}/${encodeURIComponent(`${tab}!A${r}:${LAST_COL}${r}`)}?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [row] }),
    });
  } else {
    await call(`${base}/${encodeURIComponent(`${tab}!A:${LAST_COL}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values: [row] }),
    });
  }
}

const rupees = (p: number) => (p / 100).toFixed(2);

/** Best effort: never throws; records the outcome on the payment row. */
export async function syncPaymentToSheets(paymentId: string): Promise<{ synced: boolean; error?: string }> {
  if (!sheetsConfigured()) return { synced: false, error: "not configured" };
  try {
    const [row] = await db.select({ p: payments, b: bills }).from(payments).innerJoin(bills, eq(payments.billId, bills.id)).where(eq(payments.id, paymentId));
    if (!row) return { synced: false, error: "not found" };
    const { p, b } = row;
    await upsertRow([
      p.id,
      b.id,
      p.sessionId,
      p.tableNumber,
      METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      p.utr,
      rupees(p.amountPaise),
      rupees(p.billAmountPaise),
      p.status,
      formatIST(p.submittedAt),
      formatIST(p.verifiedAt),
      p.verifiedBy ?? "",
      p.status === "PAID" ? (b.receiptNumber ?? "") : "",
      p.rejectionReason ?? "",
    ]);
    await db.update(payments).set({ sheetsSyncedAt: new Date(), sheetsSyncError: null }).where(eq(payments.id, paymentId));
    return { synced: true };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
    console.error("Sheets sync failed", paymentId, message);
    await db.update(payments).set({ sheetsSyncError: message }).where(eq(payments.id, paymentId)).catch(() => {});
    return { synced: false, error: message };
  }
}

export async function syncExceptionCloseToSheets(billId: string): Promise<void> {
  if (!sheetsConfigured()) return;
  try {
    const [b] = await db.select().from(bills).where(eq(bills.id, billId));
    if (!b) return;
    await upsertRow([
      b.id,
      b.id,
      b.sessionId,
      b.tableNumber,
      "Closed by admin (exception)",
      "",
      "",
      rupees(b.totalPaise),
      `CLOSED_EXCEPTION (${b.paymentStatus})`,
      "",
      formatIST(b.closedAt),
      b.closedBy ?? "",
      "",
      b.closeReason ?? "",
    ]);
  } catch (err) {
    console.error("Sheets sync failed for bill", billId, err instanceof Error ? err.message : err);
  }
}
