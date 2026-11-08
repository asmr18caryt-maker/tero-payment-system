import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBill,
  parseRupeesToPaise,
  normalizeUtr,
  validateUtr,
  parseSession,
  maskAccountNumber,
  formatINR,
  PaymentError,
} from "../src/payments/core.ts";

test("computeBill merges lines and adds tax with half-up rounding", () => {
  const bill = computeBill(
    [
      { id: "o2", createdAt: "2026-11-08T10:05:00Z", items: [{ id: "latte", name: "Latte", unitPricePaise: 22000, quantity: 1 }] },
      {
        id: "o1",
        createdAt: "2026-11-08T10:00:00Z",
        items: [
          { id: "latte", name: "Latte", unitPricePaise: 22000, quantity: 2 },
          { id: "momo", name: "Momo", unitPricePaise: 15050, quantity: 1 },
        ],
      },
    ],
    500,
  );
  assert.deepEqual(bill.orderIds, ["o1", "o2"]);
  assert.equal(bill.lines.length, 2);
  assert.equal(bill.lines[0].quantity, 3);
  assert.equal(bill.subtotalPaise, 81050);
  assert.equal(bill.taxPaise, 4053); // 4052.5 -> 4053
  assert.equal(bill.totalPaise, 85103);
});

test("computeBill with no tax configured", () => {
  const bill = computeBill([{ id: "o", createdAt: new Date(), items: [{ id: "a", name: "A", unitPricePaise: 9000, quantity: 2 }] }], 0);
  assert.equal(bill.taxPaise, 0);
  assert.equal(bill.totalPaise, 18000);
});

test("computeBill rejects bad quantities", () => {
  assert.throws(() => computeBill([{ id: "o", createdAt: new Date(), items: [{ id: "a", name: "A", unitPricePaise: 100, quantity: -1 }] }], 0));
});

test("parseRupeesToPaise accepts only clean amounts", () => {
  assert.equal(parseRupeesToPaise("1250"), 125000);
  assert.equal(parseRupeesToPaise("1,250.5"), 125050);
  assert.equal(parseRupeesToPaise("₹ 99.99"), 9999);
  assert.equal(parseRupeesToPaise(851.03), 85103);
  assert.equal(parseRupeesToPaise("12.345"), null);
  assert.equal(parseRupeesToPaise("-5"), null);
  assert.equal(parseRupeesToPaise("0"), null);
  assert.equal(parseRupeesToPaise("1e5"), null);
  assert.equal(parseRupeesToPaise({}), null);
});

test("UTR normalisation and validation", () => {
  assert.equal(normalizeUtr(" 4123 5678-9012 "), "412356789012");
  assert.equal(validateUtr("UPI_QR", "412356789012"), null);
  assert.ok(validateUtr("UPI_QR", "41235678901"));
  assert.ok(validateUtr("UPI_QR", "ABC356789012"));
  assert.equal(validateUtr("BANK_TRANSFER", normalizeUtr("n123456789012345")), null);
  assert.ok(validateUtr("BANK_TRANSFER", "12345"));
  assert.ok(validateUtr("BANK_TRANSFER", ""));
});

test("parseSession validates format and table ownership", () => {
  assert.deepEqual(parseSession("TBL-5-1762600000000", "5"), { sessionId: "TBL-5-1762600000000", tableNumber: "5" });
  assert.deepEqual(parseSession("TBL-Counter-1762600000000").tableNumber, "Counter");
  assert.throws(() => parseSession("TBL-5-1762600000000", "6"), PaymentError);
  assert.throws(() => parseSession("TBL-0-1762600000000"), PaymentError);
  assert.throws(() => parseSession("x'; drop table--"), PaymentError);
});

test("formatting helpers", () => {
  assert.equal(maskAccountNumber("123456789012"), "XXXXXXXX9012");
  assert.equal(formatINR(125050), "₹1,250.50");
  assert.equal(formatINR(12345600), "₹1,23,456.00");
});
