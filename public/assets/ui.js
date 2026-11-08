// Shared helpers. All dynamic text goes through textContent (no innerHTML).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const inr = (paise) =>
  "₹" + (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const rupeesPlain = (paise) => (paise / 100).toFixed(2);

export function ist(d) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) + " IST";
}

export const STATUS_LABEL = {
  UNPAID: "Unpaid",
  PAYMENT_PENDING: "Payment pending",
  PAID: "Paid",
  REJECTED: "Rejected",
};

export function pill(status, label) {
  return h("span", { class: `pill ${status}` }, label ?? STATUS_LABEL[status] ?? status);
}

let toastTimer;
export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2600);
}

export function copyButton(value, label = "Copy") {
  return h(
    "button",
    {
      type: "button",
      class: "copy",
      "aria-label": `Copy ${value}`,
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast("Copied");
        } catch {
          toast("Copy failed — please select and copy manually");
        }
      },
    },
    label,
  );
}

export async function api(path, { method = "GET", body, form } = {}) {
  const init = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (form) {
    init.body = form;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    const e = new Error("Network problem. Check your connection and try again.");
    e.code = "NETWORK";
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.code = data.code;
    e.status = res.status;
    throw e;
  }
  return data;
}

export const LOGO = () => {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 40 40");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const c = document.createElementNS(ns, "circle");
  Object.entries({ cx: 20, cy: 20, r: 18, stroke: "currentColor", "stroke-width": 1.5 }).forEach(([k, v]) => c.setAttribute(k, v));
  const p = document.createElementNS(ns, "path");
  Object.entries({ d: "M10 14h20M20 14v18M13 21h14", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round" }).forEach(([k, v]) => p.setAttribute(k, v));
  svg.append(c, p);
  return svg;
};

export function header(chipText) {
  return h(
    "header",
    { class: "site-header" },
    h(
      "div",
      { class: "inner" },
      h("a", { class: "brand", href: "/", "aria-label": "Tero Restro & Cafe home" }, LOGO(), h("span", {}, h("span", { class: "t1" }, "TERO"), h("span", { class: "t2" }, "RESTRO & CAFE"))),
      h("span", { class: "chip" }, chipText),
    ),
  );
}
