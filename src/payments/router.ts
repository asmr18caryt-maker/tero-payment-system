/**
 * Framework-agnostic router for every payment endpoint under /api/payments.
 * Signature is (Request) => Promise<Response>, so it works unchanged as a
 * Netlify Function and as a Next.js App Router route handler.
 */
import { PaymentError } from "./core.js";
import { getAdmin, login, logout, requireAdmin } from "./auth.js";
import {
  approvePayment,
  closeBillWithException,
  createTestOrder,
  getAdminOverview,
  getCustomerBill,
  getReceipt,
  rejectPayment,
  submitPayment,
} from "./service.js";
import { getSettings, setQrImageKey, updateSettings } from "./settings.js";
import { loadQrImage, saveQrImage } from "./qr-storage.js";
import { sheetsConfigured, syncExceptionCloseToSheets, syncPaymentToSheets } from "./sheets.js";
import { TEST_MENU } from "./menu-catalog.js";

const NO_STORE = { "Cache-Control": "no-store" };

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: NO_STORE });
}

async function readJson(req: Request): Promise<any> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new PaymentError(415, "JSON_REQUIRED", "Expected JSON body.");
  const text = await req.text();
  if (text.length > 20_000) throw new PaymentError(413, "TOO_LARGE", "Request too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new PaymentError(400, "BAD_JSON", "Invalid JSON.");
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-nf-client-connection-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function adminSettingsView(s: Awaited<ReturnType<typeof getSettings>>) {
  return {
    upiId: s.upiId,
    upiPayeeName: s.upiPayeeName,
    hasQrImage: Boolean(s.qrImageKey),
    qrImageUrl: s.qrImageKey ? `/api/payments/qr?v=${s.qrUpdatedAt ? new Date(s.qrUpdatedAt).getTime() : 0}` : null,
    qrUpdatedAt: s.qrUpdatedAt,
    accountHolderName: s.accountHolderName,
    bankName: s.bankName,
    accountNumber: s.accountNumber,
    ifscCode: s.ifscCode,
    branch: s.branch,
    taxRatePercent: s.taxRateBps / 100,
    taxLabel: s.taxLabel,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
    sheetsConfigured: sheetsConfigured(),
  };
}

export async function routePaymentRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/payments/, "").replace(/\/+$/, "") || "/";
  const m = req.method;

  try {
    // ---------- Customer endpoints ----------
    if (m === "GET" && path === "/bill") {
      return json(await getCustomerBill(url.searchParams.get("session"), url.searchParams.get("table")));
    }
    if (m === "POST" && path === "/submit") {
      const body = await readJson(req);
      const result = await submitPayment(body);
      await syncPaymentToSheets(result.paymentId);
      return json({ success: true, ...result }, 201);
    }
    if (m === "GET" && path === "/receipt") {
      return json(await getReceipt(url.searchParams.get("bill"), url.searchParams.get("session")));
    }
    if (m === "GET" && path === "/qr") {
      const s = await getSettings();
      const img = s.qrImageKey ? await loadQrImage(s.qrImageKey) : null;
      if (!img) return new Response("Not found", { status: 404 });
      return new Response(img.data, {
        headers: {
          "Content-Type": img.contentType,
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // ---------- Admin auth ----------
    if (m === "POST" && path === "/admin/login") return await login(req, await readJson(req), clientIp(req));
    if (m === "POST" && path === "/admin/logout") return logout(req);
    if (m === "GET" && path === "/admin/me") {
      const admin = getAdmin(req);
      return json({ signedIn: Boolean(admin), name: admin?.name ?? null, configured: Boolean(process.env.PAYMENT_ADMIN_PASSWORD) });
    }

    // ---------- Admin (authorized staff only) ----------
    if (path.startsWith("/admin/")) {
      const admin = requireAdmin(req);

      if (m === "GET" && path === "/admin/overview") return json(await getAdminOverview());

      let match = /^\/admin\/payments\/([A-Z0-9-]+)\/(approve|reject|resync)$/.exec(path);
      if (match && m === "POST") {
        const [, id, action] = match;
        const body = action === "resync" ? {} : await readJson(req);
        if (action === "approve") {
          const r = await approvePayment(id, admin.name, body.confirmReceived);
          await syncPaymentToSheets(id);
          return json({ success: true, receiptNumber: r.bill.receiptNumber, billId: r.bill.id });
        }
        if (action === "reject") {
          await rejectPayment(id, admin.name, body.reason);
          await syncPaymentToSheets(id);
          return json({ success: true });
        }
        return json(await syncPaymentToSheets(id));
      }

      match = /^\/admin\/bills\/([A-Z0-9-]+)\/close-exception$/.exec(path);
      if (match && m === "POST") {
        const body = await readJson(req);
        const r = await closeBillWithException(match[1], admin.name, body.reason);
        await syncExceptionCloseToSheets(match[1]);
        return json({ success: true, billId: r.bill.id });
      }

      if (path === "/admin/settings") {
        if (m === "GET") return json(adminSettingsView(await getSettings()));
        if (m === "PUT") return json(adminSettingsView(await updateSettings(await readJson(req), admin.name)));
      }

      if (m === "POST" && path === "/admin/qr") {
        const form = await req.formData().catch(() => null);
        const file = form?.get("qr");
        if (!(file instanceof File)) throw new PaymentError(400, "NO_FILE", "Choose a QR image to upload.");
        const key = await saveQrImage(file);
        await setQrImageKey(key, admin.name);
        return json(adminSettingsView(await getSettings()));
      }

      if (path === "/admin/test-orders") {
        if (m === "GET") return json({ menu: TEST_MENU });
        if (m === "POST") return json(await createTestOrder(await readJson(req), admin.name), 201);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    if (err instanceof PaymentError) return json({ success: false, error: err.message, code: err.code }, err.status);
    console.error("Payment API error", err);
    return json({ success: false, error: "Something went wrong. Please try again or ask our staff.", code: "SERVER_ERROR" }, 500);
  }
}
