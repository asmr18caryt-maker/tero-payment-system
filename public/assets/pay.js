import { h, inr, rupeesPlain, ist, pill, toast, copyButton, api, header } from "./ui.js";

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
// Same localStorage key the Tero menu app uses for the active table session.
const SESSION_KEY = "activeSessionId";
const ORDERS_KEY = "placedOrders";
let sessionId = params.get("session") || safeGet(SESSION_KEY) || "";
const tableFromSession = /^TBL-([^-]+)-\d+$/.exec(sessionId)?.[1];
const tableNumber = params.get("table") || tableFromSession || "";

let state = { data: null, showCheckout: params.get("checkout") === "1", method: "UPI_QR", error: "", notice: null, submitting: false };
let pollTimer;

function safeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

async function load({ quiet = false } = {}) {
  if (!sessionId) {
    state.error = "We couldn't find your table session. Please scan the QR code on your table, or open this page from View Running Bill.";
    return render();
  }
  try {
    const data = await api(`/api/payments/bill?session=${encodeURIComponent(sessionId)}&table=${encodeURIComponent(tableNumber)}`);
    const prev = state.data?.bill;
    state.data = data;
    state.error = "";
    if (prev && data.bill && prev.paymentStatus === "PAYMENT_PENDING" && data.bill.paymentStatus !== "PAYMENT_PENDING") {
      toast(data.bill.paymentStatus === "PAID" ? "Payment verified — thank you!" : "Payment update from our staff");
    }
  } catch (e) {
    if (!quiet) state.error = e.message;
  }
  render();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const b = state.data?.bill;
  if (b && !b.closed && b.paymentStatus === "PAYMENT_PENDING") {
    pollTimer = setTimeout(() => load({ quiet: true }), 8000);
  } else if (b && !b.closed && !state.showCheckout) {
    pollTimer = setTimeout(() => load({ quiet: true }), 20000);
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) load({ quiet: true }); });

function billCard(bill) {
  return h(
    "section",
    { class: "card", "aria-labelledby": "bill-h" },
    h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:1rem" },
      h("h2", { id: "bill-h", style: "margin:0" }, "Your orders"),
      bill.closed && bill.closeType === "ADMIN_EXCEPTION" ? pill("CLOSED", "Closed by staff") : pill(bill.paymentStatus),
    ),
    h("p", { class: "sub" }, `${bill.orderCount} order${bill.orderCount === 1 ? "" : "s"} · Bill ${bill.id}`),
    h("ul", { class: "lines", style: "margin-top:.5rem" },
      bill.lines.map((l) =>
        h("li", {},
          h("div", {}, h("div", { class: "name" }, l.name), h("div", { class: "meta tabular" }, `${l.quantity} × ${inr(l.unitPricePaise)}`)),
          h("div", { class: "tabular", style: "font-weight:600" }, inr(l.lineTotalPaise)),
        ),
      ),
    ),
    h("div", { class: "totals tabular" },
      h("div", { class: "row" }, h("span", {}, "Subtotal"), h("span", {}, inr(bill.subtotalPaise))),
      bill.taxRateBps > 0 ? h("div", { class: "row" }, h("span", {}, `${bill.taxLabel} (${bill.taxRateBps / 100}%)`), h("span", {}, inr(bill.taxPaise))) : null,
      h("div", { class: "row grand" }, h("span", {}, "Grand total"), h("span", {}, inr(bill.totalPaise))),
    ),
  );
}

function amountBox(bill) {
  return h("div", { class: "amount-box" },
    h("div", {}, h("div", { class: "label" }, "Pay exactly"), h("div", { class: "value tabular" }, inr(bill.totalPaise))),
    copyButton(rupeesPlain(bill.totalPaise), "Copy amount"),
  );
}

function upiPanel(bill, upi) {
  if (!upi.available) return h("div", { class: "notice info" }, "UPI payment isn't set up yet. Please choose Bank Transfer or pay at the counter.");
  const note = `Tero ${bill.id}`;
  const deepLink = upi.upiId
    ? `upi://pay?${new URLSearchParams({ pa: upi.upiId, pn: upi.payeeName || "Tero Restro & Cafe", am: rupeesPlain(bill.totalPaise), cu: "INR", tn: note })}`
    : null;
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
  return h("div", {},
    upi.qrImageUrl
      ? h("div", { class: "qr-frame" }, h("img", { src: upi.qrImageUrl, alt: "Tero Restro & Cafe UPI QR code", width: 276, height: 276 }))
      : null,
    h("p", { class: "sub", style: "text-align:center;margin-top:.6rem" }, "Scan with Google Pay, PhonePe, Paytm or any UPI app"),
    amountBox(bill),
    upi.upiId
      ? h("dl", { class: "kv" },
          h("dt", {}, "UPI ID"), h("dd", { class: "mono" }, upi.upiId), copyButton(upi.upiId),
          upi.payeeName ? [h("dt", {}, "Pay to"), h("dd", {}, upi.payeeName), h("span")] : null,
        )
      : null,
    deepLink && isMobile ? h("a", { class: "btn block", href: deepLink, style: "margin-top:1rem" }, "Open UPI app") : null,
  );
}

function bankPanel(bill, bank) {
  if (!bank.available) return h("div", { class: "notice info" }, "Bank transfer isn't set up yet. Please choose UPI or pay at the counter.");
  const rows = [
    ["Account holder", bank.accountHolderName],
    ["Bank", bank.bankName],
    ["Account number", bank.accountNumber, true],
    ["IFSC", bank.ifscCode, true],
    ["Branch", bank.branch],
  ].filter(([, v]) => v);
  return h("div", {},
    amountBox(bill),
    h("dl", { class: "kv" }, rows.map(([k, v, mono]) => [h("dt", {}, k), h("dd", { class: mono ? "mono" : "" }, v), copyButton(v)])),
    h("p", { class: "sub", style: "margin-top:.9rem" }, "Use IMPS, NEFT or RTGS. Add your table number in the remarks if your bank allows."),
  );
}

function submitForm(bill) {
  const isUpi = state.method === "UPI_QR";
  const utr = h("input", {
    type: "text", name: "utr", required: true, autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
    inputmode: isUpi ? "numeric" : "text", maxlength: 40, placeholder: isUpi ? "12-digit UPI reference" : "Bank transaction reference",
  });
  const amount = h("input", { type: "text", name: "amount", required: true, inputmode: "decimal", autocomplete: "off", placeholder: "Amount you paid in ₹" });
  const btn = h("button", { type: "submit", class: "btn primary block", style: "margin-top:1.1rem", disabled: state.submitting },
    state.submitting ? "Submitting…" : "Submit payment details");
  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (state.submitting) return;
      state.submitting = true;
      state.notice = null;
      render();
      try {
        await api("/api/payments/submit", {
          method: "POST",
          body: {
            sessionId, tableNumber, billId: bill.id, expectedTotalPaise: bill.totalPaise,
            method: state.method, utr: utr.value, amount: amount.value,
          },
        });
        state.showCheckout = false;
        toast("Submitted — waiting for staff verification");
      } catch (e) {
        state.notice = { kind: "bad", title: e.code === "BILL_CHANGED" ? "Your bill was updated" : "Couldn't submit", text: e.message };
        state.keep = { utr: utr.value, amount: e.code === "BILL_CHANGED" ? "" : amount.value };
      } finally {
        state.submitting = false;
        await load();
      }
    },
  },
    h("h2", { style: "margin-top:1.5rem" }, "After paying, tell us your reference"),
    h("label", { class: "field" }, h("span", {}, isUpi ? "UTR / UPI reference number" : "Transaction reference (UTR)"), utr,
      h("small", {}, isUpi ? "In your UPI app, open the payment → it's called UTR, UPI Ref No. or Transaction ID (12 digits)." : "Shown in your bank app after the transfer completes.")),
    h("label", { class: "field" }, h("span", {}, "Amount paid (₹)"), amount),
    btn,
    h("p", { class: "sub", style: "margin-top:.75rem;text-align:center" }, "Our staff will check the payment in our account before your bill is marked paid."),
  );
  if (state.keep) { utr.value = state.keep.utr || ""; amount.value = state.keep.amount || ""; state.keep = null; }
  return form;
}

function checkout(bill, options) {
  const tab = (method, label) =>
    h("button", {
      type: "button", class: "tab", role: "tab", "aria-selected": String(state.method === method),
      onclick: () => { state.method = method; state.notice = null; render(); },
    }, label);
  return h("section", { class: "card", id: "checkout", "aria-labelledby": "co-h" },
    h("h2", { id: "co-h" }, "Choose how to pay"),
    h("div", { class: "tabs", role: "tablist" }, tab("UPI_QR", "UPI QR Code"), tab("BANK_TRANSFER", "Bank Transfer")),
    state.method === "UPI_QR" ? upiPanel(bill, options.upi) : bankPanel(bill, options.bank),
    (state.method === "UPI_QR" ? options.upi.available : options.bank.available) ? submitForm(bill) : null,
    h("p", { class: "sub", style: "margin-top:1rem;text-align:center" }, "Prefer cash or card? Please pay at the counter and our staff will close your bill."),
  );
}

function pendingView(bill, p, newOrders) {
  return h("section", { class: "card status-hero pending" },
    h("div", { class: "icon" }, h("div", { class: "spinner", "aria-hidden": "true" })),
    h("h2", {}, "Payment submitted — awaiting verification"),
    h("p", { class: "sub" }, "Our staff are confirming the payment in our account. This page updates automatically."),
    p ? h("dl", { class: "facts", style: "text-align:left;max-width:320px;margin:1rem auto 0" },
      h("dt", {}, "Method"), h("dd", {}, p.methodLabel),
      h("dt", {}, "Reference"), h("dd", { class: "mono" }, p.utrMasked),
      h("dt", {}, "Amount"), h("dd", { class: "tabular" }, inr(p.amountPaise)),
      h("dt", {}, "Submitted"), h("dd", {}, ist(p.submittedAt)),
    ) : null,
    newOrders > 0 ? h("div", { class: "notice warn", style: "text-align:left" }, `${newOrders} new order${newOrders > 1 ? "s were" : " was"} added after you submitted. Our staff will settle ${newOrders > 1 ? "them" : "it"} with you separately.`) : null,
  );
}

function paidView(bill, newOrders) {
  const receiptHref = `/receipt/?bill=${encodeURIComponent(bill.id)}&session=${encodeURIComponent(bill.sessionId)}`;
  return h("section", { class: "card status-hero paid" },
    h("div", { class: "icon", "aria-hidden": "true" }, "✓"),
    h("h2", {}, "Payment verified. Thank you!"),
    h("p", { class: "sub" }, `Receipt ${bill.receiptNumber} · ${ist(bill.paidAt)}`),
    h("div", { class: "row-actions", style: "justify-content:center" },
      h("a", { class: "btn primary", href: receiptHref }, "View digital receipt"),
      endSessionButton(),
    ),
    newOrders > 0 ? h("div", { class: "notice warn", style: "text-align:left" }, `${newOrders} order${newOrders > 1 ? "s" : ""} placed after payment ${newOrders > 1 ? "are" : "is"} not included. Please settle at the counter.`) : null,
  );
}

function endSessionButton() {
  return h("button", {
    type: "button", class: "btn",
    onclick: () => {
      try {
        if (localStorage.getItem(SESSION_KEY) === sessionId) {
          localStorage.removeItem(SESSION_KEY);
          localStorage.removeItem(ORDERS_KEY);
        }
      } catch {}
      toast("Table session closed on this device");
      setTimeout(() => (location.href = tableNumber && tableNumber !== "Counter" ? `/?table=${encodeURIComponent(tableNumber)}` : "/"), 700);
    },
  }, "Finish & start new order");
}

function render() {
  const d = state.data;
  const bill = d?.bill;
  const children = [];
  children.push(
    h("p", { class: "eyebrow" }, tableNumber ? (tableNumber === "Counter" ? "Counter order" : `Table ${tableNumber}`) : "Your table"),
    h("h1", {}, "Running Bill"),
    h("p", { class: "sub" }, "All prices in Indian Rupees (₹ INR)"),
  );

  if (state.error) children.push(h("div", { class: "notice bad" }, h("strong", {}, "Something's not right"), state.error));
  else if (!d) children.push(h("div", { class: "card empty" }, h("div", { class: "spinner", style: "margin:0 auto", "aria-label": "Loading" })));
  else if (!bill) children.push(h("div", { class: "card empty" }, "No orders on this table yet. Your bill will appear here once you order."));
  else {
    children.push(billCard(bill));
    if (state.notice) children.push(h("div", { class: `notice ${state.notice.kind}` }, h("strong", {}, state.notice.title), state.notice.text));
    const p = d.latestPayment;

    if (bill.closed && bill.paymentStatus === "PAID") children.push(paidView(bill, d.newOrderCount));
    else if (bill.closed) children.push(h("div", { class: "notice info" }, h("strong", {}, "Bill closed by staff"), "This table's bill has been settled at the counter. Thank you for visiting Tero!"), h("div", { class: "row-actions" }, endSessionButton()));
    else if (bill.paymentStatus === "PAYMENT_PENDING") children.push(pendingView(bill, p, d.newOrderCount));
    else {
      if (bill.paymentStatus === "REJECTED" && p) {
        children.push(h("div", { class: "notice bad" }, h("strong", {}, "We couldn't verify your last payment"),
          `${p.methodLabel} · ref ${p.utrMasked} · ${inr(p.amountPaise)}`, p.rejectionReason ? h("div", { style: "margin-top:.3rem" }, `Reason: ${p.rejectionReason}`) : null,
          h("div", { style: "margin-top:.3rem" }, "Please check the details and submit again, or speak to our staff.")));
      }
      if (!state.showCheckout) {
        children.push(h("button", {
          type: "button", class: "btn primary pay-cta",
          onclick: () => { state.showCheckout = true; render(); document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth", block: "start" }); },
        }, h("span", {}, "PAY BILL"), h("span", { class: "tabular" }, inr(bill.totalPaise))));
      } else if (d.paymentOptions) {
        children.push(checkout(bill, d.paymentOptions));
      }
    }
  }
  app.replaceChildren(header("Bill & Pay"), h("main", { class: "wrap" }, children));
}

render();
load();
