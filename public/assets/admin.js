import { h, inr, ist, pill, toast, copyButton, api, header } from "./ui.js";

const app = document.getElementById("app");
const S = { me: null, tab: "verify", overview: null, settings: null, menu: null, busy: new Set(), error: "", lastTest: null, billFilter: "open" };
let timer;

async function boot() {
  try { S.me = await api("/api/payments/admin/me"); } catch (e) { S.error = e.message; }
  if (S.me?.signedIn) await refresh();
  render();
}

async function refresh() {
  try {
    S.overview = await api("/api/payments/admin/overview");
    S.error = "";
  } catch (e) {
    if (e.status === 401) { S.me = { ...S.me, signedIn: false }; }
    S.error = e.message;
  }
  clearTimeout(timer);
  if (S.me?.signedIn) timer = setTimeout(async () => { if (!document.hidden && !busyForms()) { await refresh(); render(); } else refreshLater(); }, 10000);
}
function refreshLater() { clearTimeout(timer); timer = setTimeout(async () => { await refresh(); render(); }, 10000); }
// Don't re-render while staff are typing a rejection reason / settings.
const busyForms = () => document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);

async function act(key, fn) {
  if (S.busy.has(key)) return;
  S.busy.add(key);
  render();
  try { await fn(); } catch (e) { toast(e.message); } finally { S.busy.delete(key); render(); }
}

// ---------- Sign in ----------
function loginView() {
  const name = h("input", { type: "text", name: "name", required: true, autocomplete: "name", maxlength: 40 });
  const pw = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const msg = h("div");
  return h("main", { class: "wrap" },
    h("p", { class: "eyebrow" }, "Kitchen / Admin"),
    h("h1", {}, "Payment Verification"),
    h("p", { class: "sub" }, "Staff only. Every approval is recorded under your name."),
    S.me && !S.me.configured ? h("div", { class: "notice warn" }, h("strong", {}, "Sign-in not configured"), "Set the PAYMENT_ADMIN_PASSWORD environment variable (min 8 characters) to enable staff sign-in.") : null,
    h("form", {
      class: "card",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.replaceChildren();
        try {
          const r = await api("/api/payments/admin/login", { method: "POST", body: { name: name.value, password: pw.value } });
          S.me = { signedIn: true, name: r.name, configured: true };
          await refresh();
          render();
        } catch (err) { msg.replaceChildren(h("div", { class: "notice bad" }, err.message)); }
      },
    },
      h("label", { class: "field" }, h("span", {}, "Your name"), name),
      h("label", { class: "field" }, h("span", {}, "Staff password"), pw),
      h("button", { class: "btn primary block", style: "margin-top:1rem", type: "submit" }, "Sign in"),
      msg,
    ),
  );
}

// ---------- Verification ----------
function pendingCard(p) {
  const confirm = h("input", { type: "checkbox" });
  const reason = h("input", { type: "text", maxlength: 300, placeholder: "e.g. Not received in account / amount differs" });
  const approving = S.busy.has(`a:${p.paymentId}`);
  const rejecting = S.busy.has(`r:${p.paymentId}`);
  return h("article", { class: "card pending-card", "aria-label": `Pending payment table ${p.tableNumber}` },
    h("div", { class: "top" },
      h("div", {}, h("p", { class: "eyebrow" }, "Table"), h("div", { class: "table-no" }, p.tableNumber)),
      h("div", {}, h("p", { class: "eyebrow", style: "text-align:right" }, "Bill amount"), h("div", { class: "amt tabular" }, inr(p.billAmountPaise))),
    ),
    h("dl", { class: "facts" },
      h("dt", {}, "Method"), h("dd", {}, p.methodLabel),
      h("dt", {}, "UTR / Ref"), h("dd", {}, h("span", { class: "mono" }, p.utr), " ", copyButton(p.utr)),
      h("dt", {}, "Customer paid"), h("dd", { class: "tabular" }, inr(p.amountPaise), " ", p.amountMatches ? h("span", { class: "pill PAID" }, "matches") : h("span", { class: "pill REJECTED" }, "mismatch")),
      h("dt", {}, "Submitted"), h("dd", {}, ist(p.submittedAt)),
      h("dt", {}, "Session"), h("dd", { class: "mono", style: "font-size:12px;word-break:break-all" }, p.sessionId),
    ),
    p.priorRejectionsForUtr > 0 ? h("div", { class: "notice warn" }, `This UTR was rejected ${p.priorRejectionsForUtr} time(s) before. Check carefully.`) : null,
    p.newOrdersAfterSubmission > 0 ? h("div", { class: "notice warn" }, `${p.newOrdersAfterSubmission} order(s) added after submission are NOT in this amount — collect separately.`) : null,
    h("details", {}, h("summary", {}, `Items (${p.lines.length})`),
      h("ul", { class: "lines" }, p.lines.map((l) => h("li", {}, h("span", {}, `${l.quantity} × ${l.name}`), h("span", { class: "tabular" }, inr(l.lineTotalPaise)))))),
    h("label", { class: "check" }, confirm, h("span", {}, `I found ${inr(p.amountPaise)} with UTR ${p.utr} in our bank / UPI statement.`)),
    h("div", { class: "row-actions" },
      h("button", {
        type: "button", class: "btn ok", disabled: approving || rejecting,
        onclick: () => {
          if (!confirm.checked) return toast("Tick the box after checking your bank/UPI statement");
          act(`a:${p.paymentId}`, async () => {
            const r = await api(`/api/payments/admin/payments/${encodeURIComponent(p.paymentId)}/approve`, { method: "POST", body: { confirmReceived: true } });
            toast(`Approved · receipt ${r.receiptNumber} · table session closed`);
            await refresh();
          });
        },
      }, approving ? "Approving…" : "Approve & close bill"),
    ),
    h("label", { class: "field" }, h("span", {}, "Reject reason (shown to customer)"), reason),
    h("div", { class: "row-actions", style: "margin-top:.5rem" },
      h("button", {
        type: "button", class: "btn bad small", disabled: approving || rejecting,
        onclick: () => act(`r:${p.paymentId}`, async () => {
          await api(`/api/payments/admin/payments/${encodeURIComponent(p.paymentId)}/reject`, { method: "POST", body: { reason: reason.value } });
          toast("Payment rejected — customer can resubmit");
          await refresh();
        }),
      }, rejecting ? "Rejecting…" : "Reject"),
    ),
  );
}

function verifyView() {
  const o = S.overview;
  if (!o) return h("div", { class: "card empty" }, "Loading…");
  return h("div", {},
    h("div", { class: "stat-row" },
      h("div", { class: "stat" }, h("div", { class: "v tabular" }, o.stats.pendingCount), h("div", { class: "l" }, "Awaiting verification")),
      h("div", { class: "stat" }, h("div", { class: "v tabular" }, o.stats.paidLast24h), h("div", { class: "l" }, "Verified (24h)")),
      h("div", { class: "stat" }, h("div", { class: "v tabular" }, inr(o.stats.paidLast24hPaise)), h("div", { class: "l" }, "Collected (24h)")),
    ),
    h("div", { class: "notice info" }, "Only approve after you see the exact amount and UTR in the restaurant's bank or UPI business app. A customer's UTR alone is not proof of payment."),
    o.pending.length ? h("div", { class: "grid", style: "margin-top:.25rem" }, o.pending.map(pendingCard)) : h("div", { class: "card empty" }, "No payments waiting for verification."),
  );
}

// ---------- Bills ----------
function billsView() {
  const o = S.overview;
  if (!o) return h("div", { class: "card empty" }, "Loading…");
  const filters = { open: "Open tables", closed: "Closed", all: "All" };
  const list = o.bills.filter((b) => (S.billFilter === "all" ? true : S.billFilter === "open" ? !b.closed : b.closed));
  return h("div", {},
    h("div", { class: "admin-nav" }, Object.entries(filters).map(([k, v]) =>
      h("button", { type: "button", class: "btn small", "aria-selected": String(S.billFilter === k), onclick: () => { S.billFilter = k; render(); } }, v))),
    h("p", { class: "sub", style: "margin-top:.5rem" }, "Payment status is tracked separately from food preparation status."),
    list.length
      ? h("div", { class: "table-scroll" }, h("table", { class: "data" },
          h("thead", {}, h("tr", {}, ["Table", "Bill", "Total", "Payment", "Latest reference", "Updated", "Action"].map((t) => h("th", {}, t)))),
          h("tbody", {}, list.map(billRow))))
      : h("div", { class: "card empty" }, "Nothing here."),
  );
}

function billRow(b) {
  const p = b.payments[0];
  const receiptHref = `/receipt/?bill=${encodeURIComponent(b.id)}&session=${encodeURIComponent(b.sessionId)}`;
  let action = null;
  if (b.closed) {
    action = b.paymentStatus === "PAID" ? h("a", { href: receiptHref, target: "_blank", rel: "noopener" }, b.receiptNumber) : h("span", { class: "muted", title: b.closeReason || "" }, `Exception: ${b.closeReason || ""}`);
  } else if (b.paymentStatus !== "PAYMENT_PENDING") {
    action = h("button", {
      type: "button", class: "btn small", disabled: S.busy.has(`c:${b.id}`),
      onclick: () => {
        const reason = prompt(`Close table ${b.tableNumber} (${inr(b.totalPaise)}) WITHOUT a verified online payment?\n\nEnter the reason (e.g. "Paid ₹${(b.totalPaise / 100).toFixed(0)} cash at counter"):`);
        if (reason === null) return;
        act(`c:${b.id}`, async () => {
          await api(`/api/payments/admin/bills/${encodeURIComponent(b.id)}/close-exception`, { method: "POST", body: { reason } });
          toast("Bill closed with exception");
          await refresh();
        });
      },
    }, "Close with exception");
  } else action = h("span", { class: "muted" }, "Verify first");

  return h("tr", {},
    h("td", { style: "font-weight:700" }, b.tableNumber),
    h("td", {}, h("div", { class: "mono", style: "font-size:12px" }, b.id), h("div", { class: "muted", style: "font-size:11px;word-break:break-all" }, b.sessionId)),
    h("td", { class: "tabular" }, inr(b.totalPaise)),
    h("td", {}, b.closed && b.closeType === "ADMIN_EXCEPTION" ? pill("CLOSED", "Closed (exception)") : pill(b.paymentStatus)),
    h("td", {}, p ? [h("div", { class: "mono" }, p.utr), h("div", { class: "muted", style: "font-size:11px" }, `${p.methodLabel} · ${p.status}${p.verifiedBy ? ` · ${p.verifiedBy}` : ""}`),
      p.sheetsSyncError ? h("button", { type: "button", class: "copy", onclick: () => act(`s:${p.id}`, async () => { const r = await api(`/api/payments/admin/payments/${p.id}/resync`, { method: "POST" }); toast(r.synced ? "Synced to Google Sheets" : `Sync failed: ${r.error}`); await refresh(); }) }, "Retry Sheets sync") : null] : h("span", { class: "muted" }, "—")),
    h("td", { style: "font-size:12px" }, ist(b.updatedAt)),
    h("td", {}, action),
  );
}

// ---------- Settings ----------
function settingsView() {
  if (!S.settings) {
    api("/api/payments/admin/settings").then((s) => { S.settings = s; render(); }).catch((e) => toast(e.message));
    return h("div", { class: "card empty" }, "Loading…");
  }
  const s = S.settings;
  const f = (key, label, attrs = {}, hint) => h("label", { class: "field" }, h("span", {}, label), h("input", { type: "text", name: key, value: s[key] ?? "", ...attrs }), hint ? h("small", {}, hint) : null);
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", name: "qr" });
  return h("div", {},
    h("section", { class: "card" },
      h("h2", {}, "UPI QR code"),
      s.qrImageUrl ? h("div", { class: "qr-frame", style: "margin:0;width:200px" }, h("img", { src: s.qrImageUrl, alt: "Current UPI QR" })) : h("p", { class: "sub" }, "No QR uploaded yet."),
      s.qrUpdatedAt ? h("p", { class: "sub", style: "margin-top:.5rem" }, `Updated ${ist(s.qrUpdatedAt)}${s.updatedBy ? ` by ${s.updatedBy}` : ""}`) : null,
      h("label", { class: "field" }, h("span", {}, "Upload official restaurant UPI QR (PNG/JPEG/WebP, max 2 MB)"), file,
        h("small", {}, "Use the QR from your UPI business app / bank merchant kit. Scan it yourself after uploading to check it shows the restaurant's name.")),
      h("button", {
        type: "button", class: "btn primary", style: "margin-top:.75rem", disabled: S.busy.has("qr"),
        onclick: () => {
          if (!file.files[0]) return toast("Choose an image first");
          const fd = new FormData();
          fd.append("qr", file.files[0]);
          act("qr", async () => { S.settings = await api("/api/payments/admin/qr", { method: "POST", form: fd }); toast("QR code updated"); });
        },
      }, S.busy.has("qr") ? "Uploading…" : "Upload QR"),
    ),
    h("form", {
      class: "card",
      onsubmit: (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        act("settings", async () => { S.settings = await api("/api/payments/admin/settings", { method: "PUT", body: data }); toast("Payment settings saved"); });
      },
    },
      h("h2", {}, "UPI details"),
      h("div", { class: "form-grid" },
        f("upiId", "Restaurant UPI ID", { placeholder: "tero@okhdfcbank", autocomplete: "off" }),
        f("upiPayeeName", "Payee name shown in UPI app", { placeholder: "Tero Restro & Cafe" }),
      ),
      h("h2", { style: "margin-top:1.5rem" }, "Bank transfer details"),
      h("div", { class: "form-grid" },
        f("accountHolderName", "Account holder name"),
        f("bankName", "Bank name"),
        f("accountNumber", "Account number", { inputmode: "numeric", autocomplete: "off" }),
        f("ifscCode", "IFSC code", { autocapitalize: "characters", maxlength: 11 }),
        f("branch", "Branch"),
      ),
      h("p", { class: "sub" }, "Only what a customer needs to pay you is shown, and only while their bill is unpaid. Never enter net-banking passwords, PINs or CVVs here."),
      h("h2", { style: "margin-top:1.5rem" }, "Tax on bill"),
      h("div", { class: "form-grid" },
        f("taxRatePercent", "Tax rate %", { inputmode: "decimal" }, "0 = no tax line. Applies to new/unpaid bills only."),
        f("taxLabel", "Tax label", { maxlength: 20 }),
      ),
      h("button", { type: "submit", class: "btn primary", style: "margin-top:1rem", disabled: S.busy.has("settings") }, S.busy.has("settings") ? "Saving…" : "Save settings"),
    ),
    h("section", { class: "card flat" },
      h("h2", {}, "Google Sheets"),
      h("p", { class: "sub" }, s.sheetsConfigured ? "Connected. Each payment is written to the Payments tab and updated in place when its status changes." : "Not configured. Set the Google service-account environment variables to sync payments."),
    ),
  );
}

// ---------- Test orders ----------
function testView() {
  if (!S.menu) {
    api("/api/payments/admin/test-orders").then((r) => { S.menu = r.menu; render(); }).catch((e) => toast(e.message));
    return h("div", { class: "card empty" }, "Loading…");
  }
  const table = h("input", { type: "text", name: "table", value: "5", required: true });
  const session = h("input", { type: "text", name: "session", placeholder: "Leave empty for a new session", value: S.lastTest?.sessionId ?? "" });
  const qtys = S.menu.map((m) => ({ m, input: h("input", { type: "number", min: 0, max: 50, value: 0, style: "width:80px" }) }));
  return h("div", {},
    h("div", { class: "notice warn" }, h("strong", {}, "Testing tool"), "Creates orders in the payment module's own table so you can try the full flow. When merged with the live ordering system, real orders are used and this tab can be removed."),
    h("form", {
      class: "card",
      onsubmit: (e) => {
        e.preventDefault();
        const items = qtys.filter((q) => Number(q.input.value) > 0).map((q) => ({ id: q.m.id, quantity: Number(q.input.value) }));
        act("test", async () => {
          S.lastTest = await api("/api/payments/admin/test-orders", { method: "POST", body: { tableNumber: table.value, sessionId: session.value || undefined, items } });
          toast("Test order created");
        });
      },
    },
      h("div", { class: "form-grid" }, h("label", { class: "field" }, h("span", {}, "Table number"), table), h("label", { class: "field" }, h("span", {}, "Add to existing session"), session)),
      h("ul", { class: "lines", style: "margin-top:1rem" }, qtys.map(({ m, input }) => h("li", {}, h("span", {}, m.name, h("span", { class: "muted" }, ` · ₹${m.priceRupees}`)), input))),
      h("button", { type: "submit", class: "btn primary", style: "margin-top:1rem", disabled: S.busy.has("test") }, "Create test order"),
    ),
    S.lastTest ? h("div", { class: "notice ok" }, h("strong", {}, `Order ${S.lastTest.orderId} added to ${S.lastTest.sessionId}`),
      h("a", { href: `/pay/?table=${encodeURIComponent(S.lastTest.tableNumber)}&session=${encodeURIComponent(S.lastTest.sessionId)}`, target: "_blank", rel: "noopener" }, "Open the customer bill page →")) : null,
  );
}

function render() {
  if (!S.me) return app.replaceChildren(header("Kitchen"), h("main", { class: "wrap" }, h("div", { class: "card empty" }, S.error || "Loading…")));
  if (!S.me.signedIn) return app.replaceChildren(header("Kitchen"), loginView());
  const pendingCount = S.overview?.stats.pendingCount ?? 0;
  const tabs = [["verify", "Payment Verification"], ["bills", "Tables & Bills"], ["settings", "Payment Settings"], ["test", "Test Orders"]];
  const views = { verify: verifyView, bills: billsView, settings: settingsView, test: testView };
  app.replaceChildren(
    header("Kitchen · Payments"),
    h("main", { class: "wrap wide" },
      h("div", { style: "display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap" },
        h("div", {}, h("p", { class: "eyebrow" }, "Kitchen / Admin"), h("h1", {}, "Payments")),
        h("div", { style: "display:flex;gap:.5rem;align-items:center" },
          h("span", { class: "sub" }, `Signed in as ${S.me.name}`),
          h("button", { type: "button", class: "btn small", onclick: async () => { await api("/api/payments/admin/logout", { method: "POST" }).catch(() => {}); S.me = { ...S.me, signedIn: false }; S.overview = null; render(); } }, "Sign out"),
        ),
      ),
      h("nav", { class: "admin-nav", role: "tablist", "aria-label": "Payment sections" },
        tabs.map(([k, label]) => h("button", { type: "button", role: "tab", class: "btn small", "aria-selected": String(S.tab === k), onclick: () => { S.tab = k; if (k === "verify" || k === "bills") refresh().then(render); render(); } },
          label, k === "verify" && pendingCount ? h("span", { class: "count" }, pendingCount) : null))),
      S.error ? h("div", { class: "notice bad" }, S.error) : null,
      views[S.tab](),
    ),
  );
}

boot();
