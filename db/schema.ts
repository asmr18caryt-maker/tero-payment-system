/**
 * Tero payment module — database schema.
 *
 * Every table is prefixed `payment_` / `billing_` so it can live next to the
 * existing Tero tables (orders, auth, etc.) in the same Neon/Postgres database
 * without colliding with anything. Nothing here alters existing tables.
 *
 * All money is stored as integer paise (₹1 = 100 paise) to avoid float errors.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/** Single-row table (id = 1) holding admin-configured payment details. */
export const paymentSettings = pgTable("payment_settings", {
  id: integer().primaryKey().default(1),
  upiId: text("upi_id").notNull().default(""),
  upiPayeeName: text("upi_payee_name").notNull().default(""),
  qrImageKey: text("qr_image_key"),
  qrUpdatedAt: timestamp("qr_updated_at", { withTimezone: true }),
  accountHolderName: text("account_holder_name").notNull().default(""),
  bankName: text("bank_name").notNull().default(""),
  accountNumber: text("account_number").notNull().default(""),
  ifscCode: text("ifsc_code").notNull().default(""),
  branch: text("branch").notNull().default(""),
  /** Tax in basis points (500 = 5.00%). 0 = no tax line on the bill. */
  taxRateBps: integer("tax_rate_bps").notNull().default(0),
  taxLabel: text("tax_label").notNull().default("GST"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text("updated_by"),
});

/**
 * Orders as seen by the billing module. In the standalone module this table is
 * filled by the admin "test order" tool; when merged into the Tero app the
 * `loadSessionOrders` adapter (src/payments/orders-source.ts) reads the
 * existing orders table instead and this table can stay empty.
 */
export const billingOrders = pgTable(
  "billing_orders",
  {
    id: text().primaryKey(),
    sessionId: text("session_id").notNull(),
    tableNumber: text("table_number").notNull(),
    /** [{ id, name, unitPricePaise, quantity }] — prices are server-side. */
    items: jsonb().notNull(),
    subtotalPaise: integer("subtotal_paise").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("billing_orders_session_idx").on(t.sessionId)],
);

/**
 * One bill per table session. Amounts are a server-side snapshot of the
 * session's orders, refreshed whenever new orders arrive while no payment is
 * pending/verified.
 */
export const bills = pgTable(
  "payment_bills",
  {
    id: text().primaryKey(),
    sessionId: text("session_id").notNull(),
    tableNumber: text("table_number").notNull(),
    orderIds: jsonb("order_ids").notNull(),
    lineItems: jsonb("line_items").notNull(),
    subtotalPaise: integer("subtotal_paise").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull().default(0),
    taxLabel: text("tax_label").notNull().default("GST"),
    taxPaise: integer("tax_paise").notNull().default(0),
    totalPaise: integer("total_paise").notNull(),
    /** UNPAID | PAYMENT_PENDING | PAID | REJECTED */
    paymentStatus: text("payment_status").notNull().default("UNPAID"),
    receiptNumber: text("receipt_number"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** null while open. VERIFIED_PAYMENT | ADMIN_EXCEPTION once closed. */
    closeType: text("close_type"),
    closeReason: text("close_reason"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("payment_bills_session_uq").on(t.sessionId),
    uniqueIndex("payment_bills_receipt_uq").on(t.receiptNumber),
    index("payment_bills_status_idx").on(t.paymentStatus),
  ],
);

/** Every customer payment submission. Rows are never deleted. */
export const payments = pgTable(
  "payment_submissions",
  {
    id: text().primaryKey(),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id),
    sessionId: text("session_id").notNull(),
    tableNumber: text("table_number").notNull(),
    /** UPI_QR | BANK_TRANSFER */
    method: text().notNull(),
    /** Normalised (upper-case, no spaces) UTR / transaction reference. */
    utr: text().notNull(),
    amountPaise: integer("amount_paise").notNull(),
    billAmountPaise: integer("bill_amount_paise").notNull(),
    /** PAYMENT_PENDING | PAID | REJECTED */
    status: text().notNull().default("PAYMENT_PENDING"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by"),
    rejectionReason: text("rejection_reason"),
    sheetsSyncedAt: timestamp("sheets_synced_at", { withTimezone: true }),
    sheetsSyncError: text("sheets_sync_error"),
  },
  (t) => [
    // A UTR can only be in play once: no two pending/paid rows share it.
    uniqueIndex("payment_submissions_active_utr_uq")
      .on(t.utr)
      .where(sql`status in ('PAYMENT_PENDING', 'PAID')`),
    // A bill can only have one submission awaiting verification at a time.
    uniqueIndex("payment_submissions_one_pending_per_bill_uq")
      .on(t.billId)
      .where(sql`status = 'PAYMENT_PENDING'`),
    // A bill can only ever be confirmed paid once.
    uniqueIndex("payment_submissions_one_paid_per_bill_uq")
      .on(t.billId)
      .where(sql`status = 'PAID'`),
    index("payment_submissions_status_idx").on(t.status),
  ],
);

/** Append-only audit trail for every billing/payment action. */
export const paymentAuditLog = pgTable(
  "payment_audit_log",
  {
    id: serial().primaryKey(),
    billId: text("bill_id"),
    paymentId: text("payment_id"),
    action: text().notNull(),
    actor: text().notNull(),
    details: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("payment_audit_bill_idx").on(t.billId)],
);
