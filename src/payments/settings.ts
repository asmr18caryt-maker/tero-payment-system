import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { paymentSettings } from "../../db/schema.js";
import { PaymentError } from "./core.js";

export type Settings = typeof paymentSettings.$inferSelect;

export async function getSettings(): Promise<Settings> {
  const [row] = await db.select().from(paymentSettings).where(eq(paymentSettings.id, 1));
  if (row) return row;
  await db.insert(paymentSettings).values({ id: 1 }).onConflictDoNothing();
  const [created] = await db.select().from(paymentSettings).where(eq(paymentSettings.id, 1));
  return created;
}

const LIMITS = {
  upiId: 80,
  upiPayeeName: 80,
  accountHolderName: 100,
  bankName: 100,
  accountNumber: 20,
  ifscCode: 11,
  branch: 120,
  taxLabel: 20,
} as const;

/** Validates and saves admin-provided settings. Unknown fields are ignored. */
export async function updateSettings(input: Record<string, unknown>, adminName: string): Promise<Settings> {
  await getSettings();
  const patch: Partial<Settings> = {};
  for (const [key, max] of Object.entries(LIMITS)) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw new PaymentError(400, "INVALID_SETTING", `${key} must be text.`);
    const v = (input[key] as string).trim();
    if (v.length > max) throw new PaymentError(400, "INVALID_SETTING", `${key} is too long (max ${max}).`);
    (patch as any)[key] = v;
  }
  if (patch.upiId && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(patch.upiId)) {
    throw new PaymentError(400, "INVALID_UPI_ID", "UPI ID should look like name@bank (e.g. tero@okhdfcbank).");
  }
  if (patch.accountNumber) {
    patch.accountNumber = patch.accountNumber.replace(/\s/g, "");
    if (!/^\d{9,18}$/.test(patch.accountNumber)) {
      throw new PaymentError(400, "INVALID_ACCOUNT", "Account number must be 9–18 digits.");
    }
  }
  if (patch.ifscCode) {
    patch.ifscCode = patch.ifscCode.toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(patch.ifscCode)) {
      throw new PaymentError(400, "INVALID_IFSC", "IFSC code must be 11 characters, e.g. HDFC0001234.");
    }
  }
  if (input.taxRatePercent !== undefined) {
    const pct = Number(input.taxRatePercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50 || Math.round(pct * 100) !== pct * 100) {
      throw new PaymentError(400, "INVALID_TAX", "Tax rate must be between 0 and 50 with at most 2 decimals.");
    }
    patch.taxRateBps = Math.round(pct * 100);
  }
  const [row] = await db
    .update(paymentSettings)
    .set({ ...patch, updatedAt: new Date(), updatedBy: adminName })
    .where(eq(paymentSettings.id, 1))
    .returning();
  return row;
}

export async function setQrImageKey(key: string, adminName: string): Promise<void> {
  await getSettings();
  await db
    .update(paymentSettings)
    .set({ qrImageKey: key, qrUpdatedAt: new Date(), updatedAt: new Date(), updatedBy: adminName })
    .where(eq(paymentSettings.id, 1));
}

/** Safe subset shown to customers who have an open, unpaid bill. */
export function publicPaymentDetails(s: Settings) {
  const bankConfigured = Boolean(s.accountHolderName && s.bankName && s.accountNumber && s.ifscCode);
  return {
    upi: {
      available: Boolean(s.qrImageKey || s.upiId),
      upiId: s.upiId,
      payeeName: s.upiPayeeName || s.accountHolderName,
      qrImageUrl: s.qrImageKey ? `/api/payments/qr?v=${s.qrUpdatedAt ? new Date(s.qrUpdatedAt).getTime() : 0}` : null,
    },
    bank: bankConfigured
      ? {
          available: true,
          accountHolderName: s.accountHolderName,
          bankName: s.bankName,
          accountNumber: s.accountNumber,
          ifscCode: s.ifscCode,
          branch: s.branch,
        }
      : { available: false },
  };
}
