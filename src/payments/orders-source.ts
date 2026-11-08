/**
 * ADAPTER: where the billing module reads a session's orders from.
 *
 * Standalone module: reads `billing_orders` (filled by the admin test-order
 * tool). When merged into the Tero app, change ONLY this function to read the
 * existing orders table that `POST /api/orders` writes to, mapping each row to
 * `SessionOrder` with prices taken from the server-side menu (never from the
 * browser). Nothing else in the module needs to change.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { billingOrders } from "../../db/schema.js";
import type { OrderItem, SessionOrder } from "./core.js";

export async function loadSessionOrders(sessionId: string): Promise<SessionOrder[]> {
  const rows = await db
    .select()
    .from(billingOrders)
    .where(eq(billingOrders.sessionId, sessionId))
    .orderBy(asc(billingOrders.createdAt));
  return rows.map((r) => ({ id: r.id, createdAt: r.createdAt, items: r.items as OrderItem[] }));
}
