/**
 * Pure, dependency-free billing helpers. Everything money-related is integer
 * paise so totals are exact and the server never trusts client arithmetic.
 */

export const PAYMENT_STATUSES = ["UNPAID", "PAYMENT_PENDING", "PAID", "REJECTED"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["UPI_QR", "BANK_TRANSFER"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  UPI_QR: "UPI QR Code",
  BANK_TRANSFER: "Bank Transfer",
};

export interface OrderItem {
  id: string;
  name: string;
  unitPricePaise: number;
  quantity: number;
}

export interface SessionOrder {
  id: string;
  createdAt: string | Date;
  items: OrderItem[];
}

export interface BillLine extends OrderItem {
  lineTotalPaise: number;
}

export interface ComputedBill {
  orderIds: string[];
  lines: BillLine[];
  subtotalPaise: number;
  taxRateBps: number;
  taxPaise: number;
  totalPaise: number;
}

/** Same format the existing Tero app uses for table sessions. */
export const SESSION_ID_RE = /^TBL-([1-9]\d{0,3}|Counter)-\d{10,16}$/;

export class PaymentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

/** Validates a session id and that it belongs to the given table. */
export function parseSession(sessionId: unknown, tableNumber?: unknown): { sessionId: string; tableNumber: string } {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new PaymentError(400, "INVALID_SESSION", "This table session is not valid. Please scan the table QR again.");
  }
  const table = SESSION_ID_RE.exec(sessionId)![1];
  if (tableNumber !== undefined && tableNumber !== null && tableNumber !== "" && String(tableNumber) !== table) {
    throw new PaymentError(400, "TABLE_MISMATCH", "This session belongs to a different table.");
  }
  return { sessionId, tableNumber: table };
}

/**
 * Aggregates all orders of a session into bill lines. Same item at the same
 * price across several orders is merged into one line.
 */
export function computeBill(orders: SessionOrder[], taxRateBps: number): ComputedBill {
  if (!Number.isSafeInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 5000) {
    throw new Error("Invalid tax rate");
  }
  const sorted = [...orders].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const lines = new Map<string, BillLine>();
  for (const order of sorted) {
    for (const item of order.items) {
      if (!isPositiveInt(item.quantity) || !Number.isSafeInteger(item.unitPricePaise) || item.unitPricePaise < 0) {
        throw new Error(`Invalid order item in order ${order.id}`);
      }
      const key = `${item.id}@${item.unitPricePaise}`;
      const existing = lines.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.lineTotalPaise += item.unitPricePaise * item.quantity;
      } else {
        lines.set(key, { ...item, lineTotalPaise: item.unitPricePaise * item.quantity });
      }
    }
  }
  const lineList = [...lines.values()];
  const subtotalPaise = lineList.reduce((s, l) => s + l.lineTotalPaise, 0);
  // Round half up to the nearest paisa.
  const taxPaise = Math.floor((subtotalPaise * taxRateBps + 5000) / 10000);
  return {
    orderIds: sorted.map((o) => o.id),
    lines: lineList,
    subtotalPaise,
    taxRateBps,
    taxPaise,
    totalPaise: subtotalPaise + taxPaise,
  };
}

/**
 * Parses a customer-entered rupee amount ("1250", "1,250.50", 1250) into
 * paise. Returns null for anything that is not a clean amount with at most two
 * decimals.
 */
export function parseRupeesToPaise(input: unknown): number | null {
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    s = input.toString();
  } else if (typeof input === "string") {
    s = input.trim().replace(/^₹\s*/, "").replace(/,/g, "");
  } else {
    return null;
  }
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return paise > 0 ? paise : null;
}

/** Upper-cases and strips separators so "4123 5678-9012" == "412356789012". */
export function normalizeUtr(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.toUpperCase().replace(/[\s\-_.\/]/g, "");
}

/**
 * UPI references (UTR / RRN) are 12 digits. Bank transfer references vary by
 * rail (IMPS 12 digits, NEFT ~16 alphanumeric, RTGS 22) so we accept 6–30
 * alphanumerics.
 */
export function validateUtr(method: PaymentMethod, utr: string): string | null {
  if (!utr) return "Enter the UTR / transaction reference number.";
  if (method === "UPI_QR" && !/^\d{12}$/.test(utr)) {
    return "A UPI UTR / reference number is exactly 12 digits. You can find it in your payment app's transaction details.";
  }
  if (method === "BANK_TRANSFER" && !/^[A-Z0-9]{6,30}$/.test(utr)) {
    return "Enter the transaction reference exactly as shown by your bank (6–30 letters/numbers).";
  }
  return null;
}

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return typeof v === "string" && (PAYMENT_METHODS as readonly string[]).includes(v);
}

export function formatINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Shows only the last 4 digits, e.g. "XXXXXX1234". */
export function maskAccountNumber(acc: string): string {
  const clean = acc.replace(/\s/g, "");
  if (clean.length <= 4) return clean;
  return "X".repeat(clean.length - 4) + clean.slice(-4);
}

const ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function randomId(prefix: string, length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}-${out}`;
}

/** IST calendar date as YYYYMMDD, used in receipt numbers. */
export function istDateStamp(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts.replace(/-/g, "");
}

export function formatIST(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(d));
}

/** Postgres unique-violation detection across drivers. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let e: any = err;
  for (let i = 0; i < 4 && e; i++) {
    if (e.code === "23505" && (!constraint || String(e.constraint ?? e.message ?? "").includes(constraint))) return true;
    e = e.cause;
  }
  return false;
}
