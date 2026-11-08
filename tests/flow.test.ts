/**
 * End-to-end flow test: real router + services + generated migration SQL,
 * running against an in-process Postgres (PGlite). Blobs is replaced by an
 * in-memory store. Run with: npm test
 */
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema.ts";

const pg = new PGlite();
const testDb = drizzle({ client: pg, schema });
const blobs = new Map<string, { data: ArrayBuffer; metadata: any }>();

mock.module(new URL("../db/index.ts", import.meta.url).href, { namedExports: { db: testDb } });
mock.module("@netlify/blobs", {
  namedExports: {
    getStore: () => ({
      set: async (k: string, data: ArrayBuffer, o: any) => void blobs.set(k, { data, metadata: o?.metadata }),
      getWithMetadata: async (k: string) => blobs.get(k) ?? null,
    }),
  },
});

process.env.PAYMENT_ADMIN_PASSWORD = "test-password-123";
delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

let route: (req: Request) => Promise<Response>;
let cookie = "";
const BASE = "http://localhost:8889/api/payments";

async function call(path: string, opts: { method?: string; body?: unknown; admin?: boolean; form?: FormData; origin?: string } = {}) {
  const headers: Record<string, string> = { host: "localhost:8889" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.admin) headers.cookie = cookie;
  if (opts.origin) headers.origin = opts.origin;
  const res = await route(
    new Request(BASE + path, {
      method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
      headers,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    }),
  );
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  const dir = new URL("../netlify/database/migrations/", import.meta.url);
  for (const m of readdirSync(dir).sort()) {
    await pg.exec(readFileSync(new URL(`${m}/migration.sql`, dir), "utf8"));
  }
  ({ routePaymentRequest: route } = await import("../src/payments/router.ts"));
});

let session = "";
let bill: any;

test("admin endpoints require sign-in", async () => {
  assert.equal((await call("/admin/overview")).status, 401);
  assert.equal((await call("/admin/login", { body: { name: "Asha", password: "nope" } })).status, 401);
  const ok = await call("/admin/login", { body: { name: "Asha", password: "test-password-123" } });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get("set-cookie")!.split(";")[0];
  assert.match(ok.headers.get("set-cookie")!, /HttpOnly/);
  assert.equal((await call("/admin/overview", { admin: true })).status, 200);
  // Tampered cookie rejected
  const bad = cookie.slice(0, -3) + "abc";
  const r = await route(new Request(BASE + "/admin/overview", { headers: { cookie: bad } }));
  assert.equal(r.status, 401);
  // Cross-origin mutation blocked even with a valid cookie
  assert.equal((await call("/admin/settings", { method: "PUT", body: {}, admin: true, origin: "https://evil.example" })).status, 403);
});

test("admin configures UPI, bank, tax and QR", async () => {
  const s = await call("/admin/settings", {
    method: "PUT",
    admin: true,
    body: {
      upiId: "tero@okhdfcbank", upiPayeeName: "Tero Restro & Cafe", accountHolderName: "Tero Restro and Cafe",
      bankName: "HDFC Bank", accountNumber: "5010 0123 456789", ifscCode: "hdfc0001234", branch: "Main Road",
      taxRatePercent: "5", taxLabel: "GST",
    },
  });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.ifscCode, "HDFC0001234");
  assert.equal(s.json.accountNumber, "50100123456789");
  assert.equal((await call("/admin/settings", { method: "PUT", admin: true, body: { ifscCode: "XYZ" } })).status, 400);
  assert.equal((await call("/admin/settings", { method: "PUT", admin: true, body: { upiId: "not-a-upi" } })).status, 400);

  const notImage = new FormData();
  notImage.append("qr", new File(["<script>alert(1)</script>"], "x.png", { type: "image/png" }));
  assert.equal((await call("/admin/qr", { admin: true, form: notImage })).status, 400);

  const png = new FormData();
  png.append("qr", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "qr.png"));
  const up = await call("/admin/qr", { admin: true, form: png });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.hasQrImage, true);
  const img = await route(new Request(BASE + "/qr"));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
});

test("customer sees a server-computed bill in INR with tax", async () => {
  const o = await call("/admin/test-orders", { admin: true, body: { tableNumber: "5", items: [{ id: "espresso-bull", quantity: 2 }, { id: "coco-crumbel", quantity: 1 }] } });
  assert.equal(o.status, 201, JSON.stringify(o.json));
  session = o.json.sessionId;
  await call("/admin/test-orders", { admin: true, body: { tableNumber: "5", sessionId: session, items: [{ id: "espresso-bull", quantity: 1 }] } });

  const r = await call(`/bill?session=${session}&table=5`);
  assert.equal(r.status, 200);
  bill = r.json.bill;
  assert.equal(r.json.currency, "INR");
  assert.equal(bill.subtotalPaise, (250 * 3 + 180) * 100); // ₹930
  assert.equal(bill.taxPaise, 4650); // 5% = ₹46.50
  assert.equal(bill.totalPaise, 97650);
  assert.equal(bill.paymentStatus, "UNPAID");
  assert.equal(bill.lines.find((l: any) => l.id === "espresso-bull").quantity, 3);
  assert.equal(r.json.paymentOptions.bank.ifscCode, "HDFC0001234");
  assert.equal((await call(`/bill?session=${session}&table=6`)).status, 400);
});

const submit = (over: Record<string, unknown> = {}) =>
  call("/submit", {
    body: { sessionId: session, tableNumber: "5", billId: bill.id, expectedTotalPaise: bill.totalPaise, method: "UPI_QR", utr: "4123 5678 9012", amount: "976.50", ...over },
  });

test("submission validation: amount manipulation, bad UTR, stale bill", async () => {
  assert.equal((await submit({ amount: "1" })).json.code, "AMOUNT_MISMATCH");
  assert.equal((await submit({ amount: "976.49" })).json.code, "AMOUNT_MISMATCH");
  assert.equal((await submit({ expectedTotalPaise: 100 })).json.code, "BILL_CHANGED");
  assert.equal((await submit({ utr: "12345" })).json.code, "INVALID_UTR");
  assert.equal((await submit({ method: "CASH" })).json.code, "INVALID_METHOD");
  assert.equal((await submit({ tableNumber: "7" })).json.code, "TABLE_MISMATCH");
  // Nothing was recorded
  assert.equal((await call(`/bill?session=${session}`)).json.bill.paymentStatus, "UNPAID");
});

test("valid submission only reaches PAYMENT_PENDING; duplicates blocked", async () => {
  const r = await submit();
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, "PAYMENT_PENDING");
  const b = await call(`/bill?session=${session}`);
  assert.equal(b.json.bill.paymentStatus, "PAYMENT_PENDING");
  assert.equal(b.json.paymentOptions, null, "bank details hidden once nothing to pay");
  assert.equal((await submit({ utr: "999988887777" })).json.code, "ALREADY_PENDING");

  // Same UTR on another table's bill is rejected
  const o2 = await call("/admin/test-orders", { admin: true, body: { tableNumber: "8", items: [{ id: "crunchy-mocha", quantity: 1 }] } });
  const b2 = (await call(`/bill?session=${o2.json.sessionId}`)).json.bill;
  const dup = await call("/submit", { body: { sessionId: o2.json.sessionId, tableNumber: "8", billId: b2.id, expectedTotalPaise: b2.totalPaise, method: "UPI_QR", utr: "412356789012", amount: (b2.totalPaise / 100).toFixed(2) } });
  assert.equal(dup.json.code, "DUPLICATE_UTR");
});

test("receipt unavailable until verified; only admins can approve", async () => {
  assert.equal((await call(`/receipt?bill=${bill.id}&session=${session}`)).json.code, "NOT_PAID");
  const ov = await call("/admin/overview", { admin: true });
  const p = ov.json.pending.find((x: any) => x.billId === bill.id);
  assert.ok(p);
  assert.equal(p.utr, "412356789012");
  assert.equal(p.amountMatches, true);
  assert.equal((await route(new Request(`${BASE}/admin/payments/${p.paymentId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmReceived: true }) }))).status, 401);
  assert.equal((await call(`/admin/payments/${p.paymentId}/approve`, { admin: true, body: {} })).json.code, "CONFIRMATION_REQUIRED");
});

test("concurrent approvals confirm exactly once, then bill closes with receipt", async () => {
  const ov = await call("/admin/overview", { admin: true });
  const p = ov.json.pending.find((x: any) => x.billId === bill.id);
  const results = await Promise.all([1, 2, 3].map(() => call(`/admin/payments/${p.paymentId}/approve`, { admin: true, body: { confirmReceived: true } })));
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.json)));
  const again = await call(`/admin/payments/${p.paymentId}/approve`, { admin: true, body: { confirmReceived: true } });
  assert.equal(again.json.code, "ALREADY_PROCESSED");
  assert.equal((await call(`/admin/payments/${p.paymentId}/reject`, { admin: true, body: { reason: "too late" } })).json.code, "ALREADY_PROCESSED");

  const b = (await call(`/bill?session=${session}`)).json.bill;
  assert.equal(b.paymentStatus, "PAID");
  assert.equal(b.closed, true);
  assert.equal(b.closeType, "VERIFIED_PAYMENT");
  assert.match(b.receiptNumber, /^TERO-\d{8}-[A-Z0-9]{6}$/);

  const rc = await call(`/receipt?bill=${bill.id}&session=${session}`);
  assert.equal(rc.status, 200);
  assert.equal(rc.json.payment.amountPaise, 97650);
  assert.ok(!JSON.stringify(rc.json).includes("412356789012"), "receipt masks the full UTR");
  assert.equal((await call(`/receipt?bill=${bill.id}&session=TBL-5-1000000000000`)).status, 404);

  // History is preserved and the closed session can't take more orders.
  assert.equal((await call("/admin/test-orders", { admin: true, body: { tableNumber: "5", sessionId: session, items: [{ id: "espresso-bull", quantity: 1 }] } })).json.code, "BILL_CLOSED");
  const all = await call("/admin/overview", { admin: true });
  assert.equal(all.json.bills.find((x: any) => x.id === bill.id).payments.length, 1);
});

test("reject → customer resubmits → approve; exception close", async () => {
  const o = await call("/admin/test-orders", { admin: true, body: { tableNumber: "3", items: [{ id: "apple-pie-crunchy", quantity: 2 }] } });
  const s = o.json.sessionId;
  let b = (await call(`/bill?session=${s}`)).json.bill;
  const body = { sessionId: s, tableNumber: "3", billId: b.id, expectedTotalPaise: b.totalPaise, method: "BANK_TRANSFER", utr: "N123456789012345", amount: (b.totalPaise / 100).toFixed(2) };
  assert.equal((await call("/submit", { body })).status, 201);
  let p = (await call("/admin/overview", { admin: true })).json.pending.find((x: any) => x.billId === b.id);
  assert.equal((await call(`/admin/payments/${p.paymentId}/reject`, { admin: true, body: { reason: "" } })).json.code, "REASON_REQUIRED");
  assert.equal((await call(`/admin/payments/${p.paymentId}/reject`, { admin: true, body: { reason: "Not received yet" } })).status, 200);
  const view = (await call(`/bill?session=${s}`)).json;
  assert.equal(view.bill.paymentStatus, "REJECTED");
  assert.equal(view.latestPayment.rejectionReason, "Not received yet");
  assert.ok(view.paymentOptions, "customer can pay again");

  // Customer adds an order after rejection: bill refreshes, old total refused.
  await call("/admin/test-orders", { admin: true, body: { tableNumber: "3", sessionId: s, items: [{ id: "coco-crumbel", quantity: 1 }] } });
  assert.equal((await call("/submit", { body })).json.code, "BILL_CHANGED");
  b = (await call(`/bill?session=${s}`)).json.bill;
  const body2 = { ...body, billId: b.id, expectedTotalPaise: b.totalPaise, amount: (b.totalPaise / 100).toFixed(2) };
  assert.equal((await call("/submit", { body: body2 })).status, 201, "rejected UTR may be resubmitted");
  p = (await call("/admin/overview", { admin: true })).json.pending.find((x: any) => x.billId === b.id);
  assert.equal(p.priorRejectionsForUtr, 1);
  assert.equal((await call(`/admin/bills/${b.id}/close-exception`, { admin: true, body: { reason: "cash at counter" } })).json.code, "PAYMENT_PENDING");
  assert.equal((await call(`/admin/payments/${p.paymentId}/approve`, { admin: true, body: { confirmReceived: true } })).status, 200);

  // Exception close for a table paying cash
  const c = await call("/admin/test-orders", { admin: true, body: { tableNumber: "9", items: [{ id: "crunchy-mocha", quantity: 1 }] } });
  const cb = (await call(`/bill?session=${c.json.sessionId}`)).json.bill;
  assert.equal((await call(`/admin/bills/${cb.id}/close-exception`, { admin: true, body: { reason: "no" } })).json.code, "REASON_REQUIRED");
  assert.equal((await call(`/admin/bills/${cb.id}/close-exception`, { admin: true, body: { reason: "Paid ₹231 cash at counter" } })).status, 200);
  const after = (await call(`/bill?session=${c.json.sessionId}`)).json.bill;
  assert.equal(after.closed, true);
  assert.equal(after.closeType, "ADMIN_EXCEPTION");
  assert.equal(after.paymentStatus, "UNPAID", "exception close never fakes a PAID status");
  assert.equal((await call(`/admin/bills/${cb.id}/close-exception`, { admin: true, body: { reason: "again please" } })).json.code, "BILL_CLOSED");
});

test("audit trail records every action", async () => {
  const rows = await testDb.select().from(schema.paymentAuditLog);
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ["ADMIN_LOGIN", "ADMIN_LOGIN_FAILED", "PAYMENT_SUBMITTED", "PAYMENT_APPROVED", "PAYMENT_REJECTED", "BILL_CLOSED_EXCEPTION"]) {
    assert.ok(actions.has(a), a);
  }
});

test("Google Sheets sync upserts by payment id (no duplicate rows)", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID = "sheet123";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "svc@example.iam.gserviceaccount.com";
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");

  const sheet: string[][] = [];
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com")) return Response.json({ access_token: "tok", expires_in: 3600 });
    const method = init.method ?? "GET";
    const range = decodeURIComponent(url.split("/values/")[1].split("?")[0]);
    calls.push(`${method} ${range}`);
    if (method === "GET") return Response.json({ values: sheet.map((r) => [r[0]]) });
    const values = JSON.parse(init.body).values[0];
    if (url.includes(":append")) sheet.push(values);
    else {
      const row = Number(/!A(\d+):/.exec(range)![1]);
      sheet[row - 1] = values;
    }
    return Response.json({});
  }) as typeof fetch;

  try {
    const { syncPaymentToSheets } = await import("../src/payments/sheets.ts");
    const o = await call("/admin/test-orders", { admin: true, body: { tableNumber: "11", items: [{ id: "crunchy-mocha", quantity: 1 }] } });
    const b = (await call(`/bill?session=${o.json.sessionId}`)).json.bill;
    const sub = await call("/submit", { body: { sessionId: o.json.sessionId, tableNumber: "11", billId: b.id, expectedTotalPaise: b.totalPaise, method: "UPI_QR", utr: "777766665555", amount: (b.totalPaise / 100).toFixed(2) } });
    assert.equal(sub.status, 201);
    assert.equal(sheet.length, 2, "header + one row");
    assert.equal(sheet[0][0], "Record ID");
    assert.equal(sheet[1][8], "PAYMENT_PENDING");
    await call(`/admin/payments/${sub.json.paymentId}/approve`, { admin: true, body: { confirmReceived: true } });
    assert.equal(sheet.length, 2, "status change updates the same row");
    assert.equal(sheet[1][8], "PAID");
    assert.equal(sheet[1][5], "777766665555");
    assert.equal(sheet[1][2], o.json.sessionId);
    assert.ok(sheet[1][10], "verification timestamp written");
    assert.match(sheet[1][12], /^TERO-/);
    const again = await syncPaymentToSheets(sub.json.paymentId);
    assert.equal(again.synced, true);
    assert.equal(sheet.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  }
});
