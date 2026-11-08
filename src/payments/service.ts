/**
 * Billing + manual payment verification logic.
 *
 * Rules enforced here (server-side, never trusting the browser):
 *  - The bill amount is always computed on the server from the session's orders.
 *  - A customer submission can only ever move a bill to PAYMENT_PENDING.
 *  - Only an authenticated admin can move a payment to PAID or REJECTED, and
 *    only from PAYMENT_PENDING (conditional UPDATE => no double confirmation).
 *  - The submitted amount must equal the outstanding bill exactly.
 *  - A UTR can only be attached to one pending/paid payment (DB unique index).
 *  - A table session is closed only by admin approval or an explicit,
 *    reasoned admin exception.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { bills, payments, paymentAuditLog, billingOrders } from "../../db/schema.js";
import {
  PaymentError,
  computeBill,
  parseSession,
  isPaymentMethod,
  normalizeUtr,
  validateUtr,
  parseRupeesToPaise,
  randomId,
  istDateStamp,
  formatINR,
  isUniqueViolation,
  isPositiveInt,
  METHOD_LABELS,
  type BillLine,
  type PaymentMethod,
} from "./core.js";
import { loadSessionOrders } from "./orders-source.js";
import { getSettings, publicPaymentDetails } from "./settings.js";
import { TEST_MENU } from "./menu-catalog.js";

export type BillRow = typeof bills.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function audit(
  q: Tx | typeof db,
  entry: { billId?: string | null; paymentId?: string | null; action: string; actor: string; details?: unknown },
) {
  await q.insert(paymentAuditLog).values({
    billId: entry.billId ?? null,
    paymentId: entry.paymentId ?? null,
    action: entry.action,
    actor: entry.actor,
    details: (entry.details ?? null) as any,
  });
}

function isFrozen(b: BillRow) {
  return Boolean(b.closedAt) || b.paymentStatus === "PAYMENT_PENDING" || b.paymentStatus === "PAID";
}

/**
 * Returns the session's bill, creating it or refreshing its snapshot from the
 * current orders. Bills that are pending verification, paid or closed are
 * frozen so the amount the admin verifies is the amount the customer paid.
 */
export async function syncBill(sessionId: string, tableNumber: string): Promise<{ bill: BillRow | null; newOrderCount: number }> {
  const [orders, [existing]] = await Promise.all([
    loadSessionOrders(sessionId),
    db.select().from(bills).where(eq(bills.sessionId, sessionId)),
  ]);

  if (existing && isFrozen(existing)) {
    const known = new Set(existing.orderIds as string[]);
    return { bill: existing, newOrderCount: orders.filter((o) => !known.has(o.id)).length };
  }
  if (!orders.length) return { bill: existing ?? null, newOrderCount: 0 };

  const settings = await getSettings();
  const c = computeBill(orders, settings.taxRateBps);
  const snapshot = {
    orderIds: c.orderIds,
    lineItems: c.lines,
    subtotalPaise: c.subtotalPaise,
    taxRateBps: c.taxRateBps,
    taxLabel: settings.taxLabel,
    taxPaise: c.taxPaise,
    totalPaise: c.totalPaise,
  };

  if (existing) {
    const changed =
      existing.totalPaise !== c.totalPaise ||
      existing.taxRateBps !== c.taxRateBps ||
      JSON.stringify(existing.orderIds) !== JSON.stringify(c.orderIds);
    if (!changed) return { bill: existing, newOrderCount: 0 };
    // Only refresh while still payable; a concurrent submission wins.
    const [updated] = await db
      .update(bills)
      .set({ ...snapshot, updatedAt: new Date() })
      .where(and(eq(bills.id, existing.id), inArray(bills.paymentStatus, ["UNPAID", "REJECTED"]), isNull(bills.closedAt)))
      .returning();
    if (updated) return { bill: updated, newOrderCount: 0 };
    return syncBill(sessionId, tableNumber);
  }

  await db
    .insert(bills)
    .values({ id: randomId("BILL", 10), sessionId, tableNumber, ...snapshot })
    .onConflictDoNothing({ target: bills.sessionId });
  const [created] = await db.select().from(bills).where(eq(bills.sessionId, sessionId));
  return { bill: created, newOrderCount: 0 };
}

function maskUtr(utr: string) {
  return utr.length <= 4 ? utr : "•".repeat(Math.min(utr.length - 4, 8)) + utr.slice(-4);
}

function billView(b: BillRow) {
  return {
    id: b.id,
    sessionId: b.sessionId,
    tableNumber: b.tableNumber,
    lines: b.lineItems as BillLine[],
    orderCount: (b.orderIds as string[]).length,
    subtotalPaise: b.subtotalPaise,
    taxLabel: b.taxLabel,
    taxRateBps: b.taxRateBps,
    taxPaise: b.taxPaise,
    totalPaise: b.totalPaise,
    paymentStatus: b.paymentStatus,
    receiptNumber: b.receiptNumber,
    paidAt: b.paidAt,
    closed: Boolean(b.closedAt),
    closeType: b.closeType,
    closedAt: b.closedAt,
    updatedAt: b.updatedAt,
  };
}

/** Customer-facing bill for the running-bill / checkout page. */
export async function getCustomerBill(rawSession: unknown, rawTable: unknown) {
  const { sessionId, tableNumber } = parseSession(rawSession, rawTable);
  const { bill, newOrderCount } = await syncBill(sessionId, tableNumber);
  if (!bill) return { bill: null, latestPayment: null, newOrderCount: 0, paymentOptions: null, currency: "INR" };

  const [latest] = await db
    .select()
    .from(payments)
    .where(eq(payments.billId, bill.id))
    .orderBy(desc(payments.submittedAt))
    .limit(1);

  const payable = !bill.closedAt && (bill.paymentStatus === "UNPAID" || bill.paymentStatus === "REJECTED");
  return {
    currency: "INR",
    bill: billView(bill),
    newOrderCount,
    latestPayment: latest
      ? {
          method: latest.method,
          methodLabel: METHOD_LABELS[latest.method as PaymentMethod],
          utrMasked: maskUtr(latest.utr),
          amountPaise: latest.amountPaise,
          status: latest.status,
          submittedAt: latest.submittedAt,
          verifiedAt: latest.verifiedAt,
          rejectionReason: latest.rejectionReason,
        }
      : null,
    // Bank/UPI details are only sent when there is something to pay.
    paymentOptions: payable ? publicPaymentDetails(await getSettings()) : null,
  };
}

export interface SubmitInput {
  sessionId: unknown;
  tableNumber: unknown;
  billId: unknown;
  expectedTotalPaise: unknown;
  method: unknown;
  utr: unknown;
  amount: unknown;
}

export async function submitPayment(input: SubmitInput) {
  const { sessionId, tableNumber } = parseSession(input.sessionId, input.tableNumber);
  if (!isPaymentMethod(input.method)) throw new PaymentError(400, "INVALID_METHOD", "Choose UPI QR Code or Bank Transfer.");
  const method = input.method;
  const utr = normalizeUtr(input.utr);
  const utrError = validateUtr(method, utr);
  if (utrError) throw new PaymentError(400, "INVALID_UTR", utrError);
  const amountPaise = parseRupeesToPaise(input.amount);
  if (amountPaise === null) throw new PaymentError(400, "INVALID_AMOUNT", "Enter the amount you paid, e.g. 850 or 850.50.");

  const settings = await getSettings();
  const details = publicPaymentDetails(settings);
  if (method === "UPI_QR" && !details.upi.available) throw new PaymentError(400, "METHOD_UNAVAILABLE", "UPI payment is not set up yet. Please pay at the counter.");
  if (method === "BANK_TRANSFER" && !details.bank.available) throw new PaymentError(400, "METHOD_UNAVAILABLE", "Bank transfer is not set up yet. Please pay at the counter.");

  const { bill } = await syncBill(sessionId, tableNumber);
  if (!bill) throw new PaymentError(404, "NO_BILL", "There are no orders on this table yet.");
  if (bill.closedAt) throw new PaymentError(409, "BILL_CLOSED", "This bill is already closed.");
  if (bill.paymentStatus === "PAID") throw new PaymentError(409, "ALREADY_PAID", "This bill is already paid.");
  if (bill.paymentStatus === "PAYMENT_PENDING") {
    throw new PaymentError(409, "ALREADY_PENDING", "A payment for this bill is already waiting for verification.");
  }
  if (input.billId !== bill.id || input.expectedTotalPaise !== bill.totalPaise) {
    throw new PaymentError(409, "BILL_CHANGED", "Your bill was updated (new items or tax). Please review the new total before paying.");
  }
  if (amountPaise !== bill.totalPaise) {
    throw new PaymentError(
      400,
      "AMOUNT_MISMATCH",
      `The amount entered (${formatINR(amountPaise)}) does not match your bill (${formatINR(bill.totalPaise)}). Please pay and enter the exact bill amount, or ask our staff for help.`,
    );
  }

  const [dupe] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.utr, utr), inArray(payments.status, ["PAYMENT_PENDING", "PAID"])))
    .limit(1);
  if (dupe) throw new PaymentError(409, "DUPLICATE_UTR", "This UTR / reference number has already been submitted.");

  const paymentId = randomId("PAY", 12);
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .update(bills)
        .set({ paymentStatus: "PAYMENT_PENDING", updatedAt: new Date() })
        .where(
          and(
            eq(bills.id, bill.id),
            inArray(bills.paymentStatus, ["UNPAID", "REJECTED"]),
            isNull(bills.closedAt),
            eq(bills.totalPaise, amountPaise),
          ),
        )
        .returning({ id: bills.id });
      if (!locked) throw new PaymentError(409, "BILL_CHANGED", "Your bill changed while submitting. Please refresh and try again.");
      await tx.insert(payments).values({
        id: paymentId,
        billId: bill.id,
        sessionId,
        tableNumber,
        method,
        utr,
        amountPaise,
        billAmountPaise: bill.totalPaise,
        status: "PAYMENT_PENDING",
      });
      await audit(tx, {
        billId: bill.id,
        paymentId,
        action: "PAYMENT_SUBMITTED",
        actor: `customer:table-${tableNumber}`,
        details: { method, amountPaise },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err, "active_utr")) throw new PaymentError(409, "DUPLICATE_UTR", "This UTR / reference number has already been submitted.");
    if (isUniqueViolation(err)) throw new PaymentError(409, "ALREADY_PENDING", "A payment for this bill is already waiting for verification.");
    throw err;
  }
  return { paymentId, billId: bill.id, status: "PAYMENT_PENDING" as const };
}

export async function approvePayment(paymentId: unknown, adminName: string, confirmReceived: unknown) {
  if (typeof paymentId !== "string") throw new PaymentError(400, "INVALID_ID", "Invalid payment id.");
  if (confirmReceived !== true) {
    throw new PaymentError(400, "CONFIRMATION_REQUIRED", "Confirm that you found this exact amount and UTR in the bank/UPI statement.");
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    const [p] = await tx
      .update(payments)
      .set({ status: "PAID", verifiedAt: now, verifiedBy: adminName })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "PAYMENT_PENDING")))
      .returning();
    if (!p) {
      const [cur] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId));
      if (!cur) throw new PaymentError(404, "NOT_FOUND", "Payment not found.");
      throw new PaymentError(409, "ALREADY_PROCESSED", `This payment was already processed (${cur.status}).`);
    }
    const [b] = await tx.select().from(bills).where(eq(bills.id, p.billId)).for("update");
    if (!b || b.closedAt) throw new PaymentError(409, "BILL_CLOSED", "This bill is already closed.");
    if (b.paymentStatus !== "PAYMENT_PENDING" || p.amountPaise !== b.totalPaise) {
      throw new PaymentError(409, "AMOUNT_MISMATCH", "Payment amount no longer matches the bill. Reject it and ask the customer to resubmit.");
    }
    const receiptNumber = `TERO-${istDateStamp(now)}-${randomId("R", 6).slice(2)}`;
    const [updated] = await tx
      .update(bills)
      .set({
        paymentStatus: "PAID",
        receiptNumber,
        paidAt: now,
        closeType: "VERIFIED_PAYMENT",
        closedAt: now,
        closedBy: adminName,
        updatedAt: now,
      })
      .where(and(eq(bills.id, b.id), eq(bills.paymentStatus, "PAYMENT_PENDING"), isNull(bills.closedAt)))
      .returning();
    if (!updated) throw new PaymentError(409, "ALREADY_PROCESSED", "This bill was already processed.");
    await audit(tx, {
      billId: b.id,
      paymentId: p.id,
      action: "PAYMENT_APPROVED",
      actor: `admin:${adminName}`,
      details: { amountPaise: p.amountPaise, receiptNumber },
    });
    return { payment: p, bill: updated };
  });
}

export async function rejectPayment(paymentId: unknown, adminName: string, reason: unknown) {
  if (typeof paymentId !== "string") throw new PaymentError(400, "INVALID_ID", "Invalid payment id.");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3 || why.length > 300) throw new PaymentError(400, "REASON_REQUIRED", "Give a short reason for rejecting (shown to the customer).");
  return db.transaction(async (tx) => {
    const [p] = await tx
      .update(payments)
      .set({ status: "REJECTED", verifiedAt: new Date(), verifiedBy: adminName, rejectionReason: why })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "PAYMENT_PENDING")))
      .returning();
    if (!p) {
      const [cur] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId));
      if (!cur) throw new PaymentError(404, "NOT_FOUND", "Payment not found.");
      throw new PaymentError(409, "ALREADY_PROCESSED", `This payment was already processed (${cur.status}).`);
    }
    await tx
      .update(bills)
      .set({ paymentStatus: "REJECTED", updatedAt: new Date() })
      .where(and(eq(bills.id, p.billId), eq(bills.paymentStatus, "PAYMENT_PENDING")));
    await audit(tx, { billId: p.billId, paymentId: p.id, action: "PAYMENT_REJECTED", actor: `admin:${adminName}`, details: { reason: why } });
    return { payment: p };
  });
}

/** Admin closes a session without a verified online payment (e.g. paid cash). */
export async function closeBillWithException(billId: unknown, adminName: string, reason: unknown) {
  if (typeof billId !== "string") throw new PaymentError(400, "INVALID_ID", "Invalid bill id.");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5 || why.length > 300) throw new PaymentError(400, "REASON_REQUIRED", "Write the reason for closing without a verified payment (min 5 characters).");
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(bills).where(eq(bills.id, billId)).for("update");
    if (!b) throw new PaymentError(404, "NOT_FOUND", "Bill not found.");
    if (b.closedAt) throw new PaymentError(409, "BILL_CLOSED", "This bill is already closed.");
    if (b.paymentStatus === "PAYMENT_PENDING") throw new PaymentError(409, "PAYMENT_PENDING", "Approve or reject the pending payment first.");
    const now = new Date();
    const [updated] = await tx
      .update(bills)
      .set({ closeType: "ADMIN_EXCEPTION", closeReason: why, closedAt: now, closedBy: adminName, updatedAt: now })
      .where(and(eq(bills.id, b.id), isNull(bills.closedAt)))
      .returning();
    await audit(tx, { billId: b.id, action: "BILL_CLOSED_EXCEPTION", actor: `admin:${adminName}`, details: { reason: why } });
    return { bill: updated };
  });
}

export async function getReceipt(rawBillId: unknown, rawSession: unknown) {
  const { sessionId } = parseSession(rawSession);
  if (typeof rawBillId !== "string") throw new PaymentError(400, "INVALID_ID", "Invalid bill id.");
  const [b] = await db.select().from(bills).where(and(eq(bills.id, rawBillId), eq(bills.sessionId, sessionId)));
  if (!b) throw new PaymentError(404, "NOT_FOUND", "Receipt not found.");
  if (b.paymentStatus !== "PAID" || !b.receiptNumber) {
    throw new PaymentError(409, "NOT_PAID", "A receipt is available once our staff verifies your payment.");
  }
  const [p] = await db.select().from(payments).where(and(eq(payments.billId, b.id), eq(payments.status, "PAID")));
  return {
    restaurant: "Tero Restro & Cafe",
    receiptNumber: b.receiptNumber,
    bill: billView(b),
    payment: p
      ? {
          id: p.id,
          method: p.method,
          methodLabel: METHOD_LABELS[p.method as PaymentMethod],
          utrMasked: maskUtr(p.utr),
          amountPaise: p.amountPaise,
          submittedAt: p.submittedAt,
          verifiedAt: p.verifiedAt,
        }
      : null,
  };
}

/** Everything the admin Payment Verification panel needs in one call. */
export async function getAdminOverview() {
  const pendingRows = await db
    .select({ p: payments, b: bills })
    .from(payments)
    .innerJoin(bills, eq(payments.billId, bills.id))
    .where(eq(payments.status, "PAYMENT_PENDING"))
    .orderBy(payments.submittedAt);

  const pendingUtrs = pendingRows.map((r) => r.p.utr);
  const priorRejections = pendingUtrs.length
    ? await db
        .select({ utr: payments.utr, n: sql<number>`count(*)::int` })
        .from(payments)
        .where(and(inArray(payments.utr, pendingUtrs), eq(payments.status, "REJECTED")))
        .groupBy(payments.utr)
    : [];
  const rejMap = new Map(priorRejections.map((r) => [r.utr, r.n]));

  const pending = await Promise.all(
    pendingRows.map(async ({ p, b }) => {
      const orders = await loadSessionOrders(b.sessionId);
      const known = new Set(b.orderIds as string[]);
      return {
        paymentId: p.id,
        billId: b.id,
        sessionId: b.sessionId,
        tableNumber: p.tableNumber,
        method: p.method,
        methodLabel: METHOD_LABELS[p.method as PaymentMethod],
        utr: p.utr,
        amountPaise: p.amountPaise,
        billAmountPaise: b.totalPaise,
        amountMatches: p.amountPaise === b.totalPaise,
        submittedAt: p.submittedAt,
        priorRejectionsForUtr: rejMap.get(p.utr) ?? 0,
        newOrdersAfterSubmission: orders.filter((o) => !known.has(o.id)).length,
        lines: b.lineItems,
      };
    }),
  );

  const recentBills = await db.select().from(bills).orderBy(desc(bills.updatedAt)).limit(100);
  const billIds = recentBills.map((b) => b.id);
  const billPayments = billIds.length
    ? await db.select().from(payments).where(inArray(payments.billId, billIds)).orderBy(desc(payments.submittedAt))
    : [];
  const byBill = new Map<string, PaymentRow[]>();
  for (const p of billPayments) byBill.set(p.billId, [...(byBill.get(p.billId) ?? []), p]);

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [paidToday] = await db
    .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${payments.amountPaise}),0)::int` })
    .from(payments)
    .where(and(eq(payments.status, "PAID"), gte(payments.verifiedAt, since)));

  return {
    pending,
    stats: { pendingCount: pending.length, paidLast24h: paidToday?.n ?? 0, paidLast24hPaise: paidToday?.total ?? 0 },
    bills: recentBills.map((b) => ({
      ...billView(b),
      closeReason: b.closeReason,
      closedBy: b.closedBy,
      payments: (byBill.get(b.id) ?? []).map((p) => ({
        id: p.id,
        method: p.method,
        methodLabel: METHOD_LABELS[p.method as PaymentMethod],
        utr: p.utr,
        amountPaise: p.amountPaise,
        status: p.status,
        submittedAt: p.submittedAt,
        verifiedAt: p.verifiedAt,
        verifiedBy: p.verifiedBy,
        rejectionReason: p.rejectionReason,
        sheetsSyncedAt: p.sheetsSyncedAt,
        sheetsSyncError: p.sheetsSyncError,
      })),
    })),
  };
}

/** Admin-only: create a test order so the flow can be exercised end to end. */
export async function createTestOrder(input: { tableNumber: unknown; sessionId?: unknown; items: unknown }, adminName: string) {
  const table = String(input.tableNumber ?? "").trim();
  if (!/^([1-9]\d{0,3}|Counter)$/.test(table)) throw new PaymentError(400, "INVALID_TABLE", "Table must be a number (1–9999) or Counter.");
  const sessionId = input.sessionId ? parseSession(input.sessionId, table).sessionId : `TBL-${table}-${Date.now()}`;
  if (!Array.isArray(input.items) || !input.items.length) throw new PaymentError(400, "NO_ITEMS", "Add at least one item.");
  const items = input.items.map((raw: any) => {
    const m = TEST_MENU.find((x) => x.id === raw?.id);
    if (!m || !isPositiveInt(raw.quantity) || raw.quantity > 50) throw new PaymentError(400, "INVALID_ITEM", "Invalid item or quantity.");
    return { id: m.id, name: m.name, unitPricePaise: m.priceRupees * 100, quantity: raw.quantity };
  });
  const [b] = await db.select().from(bills).where(eq(bills.sessionId, sessionId));
  if (b?.closedAt) throw new PaymentError(409, "BILL_CLOSED", "That session is closed. Start a new session.");
  const id = randomId("ORD", 10);
  await db.insert(billingOrders).values({
    id,
    sessionId,
    tableNumber: table,
    items,
    subtotalPaise: items.reduce((s, i) => s + i.unitPricePaise * i.quantity, 0),
  });
  await audit(db, { action: "TEST_ORDER_CREATED", actor: `admin:${adminName}`, details: { orderId: id, sessionId } });
  return { orderId: id, sessionId, tableNumber: table };
}

/**
 * For the merged app: call from POST /api/orders to stop new orders being
 * added to a session that has already been closed.
 */
export async function isSessionClosed(sessionId: string): Promise<boolean> {
  const [b] = await db.select({ closedAt: bills.closedAt }).from(bills).where(eq(bills.sessionId, sessionId));
  return Boolean(b?.closedAt);
}

export { audit };
