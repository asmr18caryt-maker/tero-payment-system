CREATE TABLE "billing_orders" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"table_number" text NOT NULL,
	"items" jsonb NOT NULL,
	"subtotal_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_bills" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"table_number" text NOT NULL,
	"order_ids" jsonb NOT NULL,
	"line_items" jsonb NOT NULL,
	"subtotal_paise" integer NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"tax_label" text DEFAULT 'GST' NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"total_paise" integer NOT NULL,
	"payment_status" text DEFAULT 'UNPAID' NOT NULL,
	"receipt_number" text,
	"paid_at" timestamp with time zone,
	"close_type" text,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_audit_log" (
	"id" serial PRIMARY KEY,
	"bill_id" text,
	"payment_id" text,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_settings" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"upi_id" text DEFAULT '' NOT NULL,
	"upi_payee_name" text DEFAULT '' NOT NULL,
	"qr_image_key" text,
	"qr_updated_at" timestamp with time zone,
	"account_holder_name" text DEFAULT '' NOT NULL,
	"bank_name" text DEFAULT '' NOT NULL,
	"account_number" text DEFAULT '' NOT NULL,
	"ifsc_code" text DEFAULT '' NOT NULL,
	"branch" text DEFAULT '' NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"tax_label" text DEFAULT 'GST' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "payment_submissions" (
	"id" text PRIMARY KEY,
	"bill_id" text NOT NULL,
	"session_id" text NOT NULL,
	"table_number" text NOT NULL,
	"method" text NOT NULL,
	"utr" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"bill_amount_paise" integer NOT NULL,
	"status" text DEFAULT 'PAYMENT_PENDING' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"rejection_reason" text,
	"sheets_synced_at" timestamp with time zone,
	"sheets_sync_error" text
);
--> statement-breakpoint
CREATE INDEX "billing_orders_session_idx" ON "billing_orders" ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_bills_session_uq" ON "payment_bills" ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_bills_receipt_uq" ON "payment_bills" ("receipt_number");--> statement-breakpoint
CREATE INDEX "payment_bills_status_idx" ON "payment_bills" ("payment_status");--> statement-breakpoint
CREATE INDEX "payment_audit_bill_idx" ON "payment_audit_log" ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_submissions_active_utr_uq" ON "payment_submissions" ("utr") WHERE status in ('PAYMENT_PENDING', 'PAID');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_submissions_one_pending_per_bill_uq" ON "payment_submissions" ("bill_id") WHERE status = 'PAYMENT_PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_submissions_one_paid_per_bill_uq" ON "payment_submissions" ("bill_id") WHERE status = 'PAID';--> statement-breakpoint
CREATE INDEX "payment_submissions_status_idx" ON "payment_submissions" ("status");--> statement-breakpoint
ALTER TABLE "payment_submissions" ADD CONSTRAINT "payment_submissions_bill_id_payment_bills_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "payment_bills"("id");