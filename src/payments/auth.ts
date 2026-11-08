/**
 * ADAPTER: admin authorization for payment actions.
 *
 * Standalone module: a single staff password (PAYMENT_ADMIN_PASSWORD env var)
 * exchanged for a signed, HttpOnly, SameSite=Strict session cookie valid for
 * 12 hours. The staff member's name is recorded on every approval.
 *
 * When merged into the Tero app, replace `getAdmin()` with a check against the
 * existing kitchen sign-in (the `/api/auth` session) and keep the rest.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { paymentAuditLog } from "../../db/schema.js";
import { PaymentError } from "./core.js";

const COOKIE = "tero_pay_admin";
const TTL_SECONDS = 12 * 60 * 60;

function adminPassword(): string | null {
  const p = process.env.PAYMENT_ADMIN_PASSWORD;
  return p && p.length >= 8 ? p : null;
}

function signingKey(password: string): Buffer {
  const extra = process.env.PAYMENT_SESSION_SECRET ?? "";
  return createHmac("sha256", `tero-payment-admin-v1:${extra}`).update(password).digest();
}

function sign(payload: string, password: string) {
  return createHmac("sha256", signingKey(password)).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export interface Admin {
  name: string;
}

export function getAdmin(req: Request): Admin | null {
  const password = adminPassword();
  if (!password) return null;
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !safeEqual(sign(payload, password), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.n !== "string" || typeof data.exp !== "number" || data.exp < Date.now() / 1000) return null;
    return { name: data.n };
  } catch {
    return null;
  }
}

/**
 * Throws unless the request carries a valid admin session. Mutating requests
 * must also come from this origin (CSRF defence on top of SameSite=Strict).
 */
export function requireAdmin(req: Request): Admin {
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
  const admin = getAdmin(req);
  if (!admin) throw new PaymentError(401, "UNAUTHORIZED", "Please sign in as restaurant staff.");
  return admin;
}

export function assertSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  if (new URL(origin).host !== host) throw new PaymentError(403, "BAD_ORIGIN", "Request blocked.");
}

function isSecure(req: Request) {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

export async function login(req: Request, body: any, ip: string): Promise<Response> {
  assertSameOrigin(req);
  const password = adminPassword();
  if (!password) {
    throw new PaymentError(503, "NOT_CONFIGURED", "Staff sign-in is not configured. Set PAYMENT_ADMIN_PASSWORD (min 8 characters).");
  }
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentAuditLog)
    .where(and(eq(paymentAuditLog.action, "ADMIN_LOGIN_FAILED"), eq(paymentAuditLog.actor, `ip:${ip}`), gte(paymentAuditLog.createdAt, since)));
  if (n >= 10) throw new PaymentError(429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Try again in 15 minutes.");

  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 40) : "";
  const given = typeof body?.password === "string" ? body.password : "";
  if (!name) throw new PaymentError(400, "NAME_REQUIRED", "Enter your name so approvals are recorded against you.");

  const ok = safeEqual(createHmac("sha256", "cmp").update(given).digest("hex"), createHmac("sha256", "cmp").update(password).digest("hex"));
  if (!ok) {
    await db.insert(paymentAuditLog).values({ action: "ADMIN_LOGIN_FAILED", actor: `ip:${ip}`, details: { name } });
    await new Promise((r) => setTimeout(r, 600));
    throw new PaymentError(401, "INVALID_PASSWORD", "Incorrect staff password.");
  }
  await db.insert(paymentAuditLog).values({ action: "ADMIN_LOGIN", actor: `admin:${name}`, details: { ip } });
  const payload = Buffer.from(JSON.stringify({ n: name, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS })).toString("base64url");
  const cookie = `${COOKIE}=${payload}.${sign(payload, password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_SECONDS}${isSecure(req) ? "; Secure" : ""}`;
  return Response.json({ ok: true, name }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}

export function logout(req: Request): Response {
  const cookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req) ? "; Secure" : ""}`;
  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
}
