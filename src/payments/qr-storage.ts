/**
 * ADAPTER: storage for the uploaded UPI QR image (Netlify Blobs).
 * On Vercel, swap these two functions for Vercel Blob / S3 equivalents.
 */
import { getStore } from "@netlify/blobs";
import { PaymentError } from "./core.js";

const STORE = "tero-payment-assets";
const MAX_BYTES = 2 * 1024 * 1024;

function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function saveQrImage(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new PaymentError(400, "FILE_TOO_LARGE", "QR image must be under 2 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) throw new PaymentError(400, "INVALID_IMAGE", "Upload a PNG, JPEG or WebP image of your UPI QR code.");
  const key = `upi-qr-${Date.now()}`;
  const store = getStore({ name: STORE, consistency: "strong" });
  await store.set(key, bytes.buffer as ArrayBuffer, { metadata: { contentType: type } });
  return key;
}

export async function loadQrImage(key: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const store = getStore({ name: STORE, consistency: "strong" });
  const res = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!res) return null;
  return { data: res.data, contentType: String(res.metadata?.contentType ?? "image/png") };
}
