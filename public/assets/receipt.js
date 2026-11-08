import { h, inr, ist, api, header } from "./ui.js";

const app = document.getElementById("app");
const q = new URLSearchParams(location.search);

async function main() {
  let body;
  try {
    const r = await api(`/api/payments/receipt?bill=${encodeURIComponent(q.get("bill") || "")}&session=${encodeURIComponent(q.get("session") || "")}`);
    const b = r.bill;
    const p = r.payment;
    document.title = `Receipt ${r.receiptNumber} | Tero Restro & Cafe`;
    body = [
      h("article", { class: "receipt", "aria-label": "Payment receipt" },
        h("div", { class: "head" },
          h("div", { style: "font-weight:700;letter-spacing:.18em" }, "TERO"),
          h("div", { class: "muted", style: "font-size:10px;letter-spacing:.16em" }, "RESTRO & CAFE"),
          h("div", { class: "paid-stamp" }, "PAID"),
          h("p", { class: "sub", style: "margin-top:.75rem" }, "Digital receipt"),
        ),
        h("dl", { class: "facts" },
          h("dt", {}, "Receipt no."), h("dd", { class: "mono" }, r.receiptNumber),
          h("dt", {}, "Table"), h("dd", {}, b.tableNumber),
          h("dt", {}, "Bill ID"), h("dd", { class: "mono" }, b.id),
          h("dt", {}, "Session"), h("dd", { class: "mono", style: "word-break:break-all" }, b.sessionId),
          h("dt", {}, "Paid on"), h("dd", {}, ist(b.paidAt)),
        ),
        h("ul", { class: "lines", style: "margin-top:1rem;border-top:1px dashed var(--line-strong)" },
          b.lines.map((l) => h("li", {},
            h("div", {}, h("div", { class: "name" }, l.name), h("div", { class: "meta tabular" }, `${l.quantity} × ${inr(l.unitPricePaise)}`)),
            h("div", { class: "tabular" }, inr(l.lineTotalPaise)))),
        ),
        h("div", { class: "totals tabular" },
          h("div", { class: "row" }, h("span", {}, "Subtotal"), h("span", {}, inr(b.subtotalPaise))),
          b.taxRateBps > 0 ? h("div", { class: "row" }, h("span", {}, `${b.taxLabel} (${b.taxRateBps / 100}%)`), h("span", {}, inr(b.taxPaise))) : null,
          h("div", { class: "row grand" }, h("span", {}, "Total paid"), h("span", {}, inr(b.totalPaise))),
        ),
        p ? h("dl", { class: "facts", style: "border-top:1px dashed var(--line-strong);padding-top:1rem" },
          h("dt", {}, "Payment method"), h("dd", {}, p.methodLabel),
          h("dt", {}, "Reference"), h("dd", { class: "mono" }, p.utrMasked),
          h("dt", {}, "Verified"), h("dd", {}, ist(p.verifiedAt)),
        ) : null,
        h("p", { class: "sub", style: "text-align:center;margin-top:1.25rem" }, "Thank you for dining at Tero Restro & Cafe!"),
      ),
      h("div", { class: "row-actions no-print", style: "justify-content:center" },
        h("button", { class: "btn primary", type: "button", onclick: () => window.print() }, "Print / Save as PDF"),
        h("a", { class: "btn", href: `/pay/?session=${encodeURIComponent(b.sessionId)}` }, "Back to bill"),
      ),
    ];
  } catch (e) {
    body = [h("div", { class: "notice bad" }, h("strong", {}, "Receipt unavailable"), e.message)];
  }
  app.replaceChildren(header("Receipt"), h("main", { class: "wrap" }, body));
}
app.replaceChildren(header("Receipt"), h("main", { class: "wrap" }, h("div", { class: "card empty" }, "Loading receipt…")));
main();
