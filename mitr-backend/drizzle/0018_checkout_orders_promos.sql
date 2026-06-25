CREATE TABLE IF NOT EXISTS "checkout_products" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "price_paise" integer NOT NULL,
  "mrp_paise" integer,
  "currency" text DEFAULT 'INR' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_products_price_positive" CHECK ("price_paise" >= 100),
  CONSTRAINT "checkout_products_mrp_positive" CHECK ("mrp_paise" IS NULL OR "mrp_paise" >= "price_paise")
);

CREATE TABLE IF NOT EXISTS "checkout_promo_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "label" text NOT NULL,
  "kind" text DEFAULT 'promo' NOT NULL,
  "discount_type" text NOT NULL,
  "discount_value" integer NOT NULL,
  "max_discount_paise" integer,
  "min_order_paise" integer DEFAULT 0 NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "starts_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "max_redemptions" integer,
  "max_redemptions_per_customer" integer,
  "redeemed_count" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "affiliate_id" text,
  "referrer_id" text,
  "campaign" text,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_promo_codes_code_upper" CHECK ("code" = upper("code")),
  CONSTRAINT "checkout_promo_codes_kind_check" CHECK ("kind" IN ('promo', 'referral', 'affiliate')),
  CONSTRAINT "checkout_promo_codes_discount_type_check" CHECK ("discount_type" IN ('flat', 'percent')),
  CONSTRAINT "checkout_promo_codes_discount_value_check" CHECK (
    ("discount_type" = 'flat' AND "discount_value" > 0)
    OR ("discount_type" = 'percent' AND "discount_value" > 0 AND "discount_value" <= 100)
  ),
  CONSTRAINT "checkout_promo_codes_limit_check" CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0),
  CONSTRAINT "checkout_promo_codes_customer_limit_check" CHECK ("max_redemptions_per_customer" IS NULL OR "max_redemptions_per_customer" > 0)
);

CREATE TABLE IF NOT EXISTS "checkout_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" text,
  "request_fingerprint" text NOT NULL,
  "product_id" text NOT NULL,
  "product_name" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "base_amount_paise" integer NOT NULL,
  "discount_paise" integer DEFAULT 0 NOT NULL,
  "amount_paise" integer NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,
  "promo_code_id" uuid,
  "promo_code" text,
  "promo_kind" text,
  "affiliate_id" text,
  "referrer_id" text,
  "campaign" text,
  "razorpay_order_id" text,
  "razorpay_payment_id" text,
  "payment_signature_valid" boolean,
  "payment_verified_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "customer_name" text NOT NULL,
  "customer_email" text NOT NULL,
  "customer_phone" text NOT NULL,
  "receive_updates" boolean DEFAULT true NOT NULL,
  "shipping_address_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "shipping_address_text" text NOT NULL,
  "personalized_message" text,
  "customer_email_hash" text NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_orders_status_check" CHECK ("status" IN (
    'draft',
    'payment_order_failed',
    'payment_pending',
    'payment_signature_failed',
    'payment_authorized',
    'paid',
    'payment_failed',
    'payment_review_required',
    'cancelled',
    'expired'
  )),
  CONSTRAINT "checkout_orders_amount_check" CHECK (
    "base_amount_paise" >= 100
    AND "discount_paise" >= 0
    AND "amount_paise" >= 100
    AND "base_amount_paise" - "discount_paise" = "amount_paise"
  )
);

CREATE TABLE IF NOT EXISTS "checkout_promo_redemptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "promo_code_id" uuid NOT NULL,
  "order_id" uuid NOT NULL,
  "customer_email_hash" text NOT NULL,
  "status" text DEFAULT 'reserved' NOT NULL,
  "discount_paise" integer NOT NULL,
  "reserved_expires_at" timestamp with time zone NOT NULL,
  "redeemed_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_promo_redemptions_status_check" CHECK ("status" IN ('reserved', 'redeemed', 'released')),
  CONSTRAINT "checkout_promo_redemptions_discount_check" CHECK ("discount_paise" > 0)
);

CREATE TABLE IF NOT EXISTS "checkout_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "provider" text DEFAULT 'razorpay' NOT NULL,
  "provider_order_id" text NOT NULL,
  "provider_payment_id" text,
  "status" text NOT NULL,
  "amount_paise" integer,
  "currency" text,
  "signature_valid" boolean,
  "error_code" text,
  "error_description" text,
  "raw_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "verified_at" timestamp with time zone,
  "captured_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "checkout_payment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid,
  "payment_id" uuid,
  "provider" text DEFAULT 'razorpay' NOT NULL,
  "provider_event_id" text,
  "event_type" text NOT NULL,
  "signature_valid" boolean NOT NULL,
  "payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "checkout_products_active_idx" ON "checkout_products" ("is_active");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_promo_codes_code_uq" ON "checkout_promo_codes" ("code");
CREATE INDEX IF NOT EXISTS "checkout_promo_codes_active_code_idx" ON "checkout_promo_codes" ("is_active", "code");
CREATE INDEX IF NOT EXISTS "checkout_promo_codes_affiliate_idx" ON "checkout_promo_codes" ("affiliate_id");
CREATE INDEX IF NOT EXISTS "checkout_promo_codes_referrer_idx" ON "checkout_promo_codes" ("referrer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_orders_idempotency_key_uq" ON "checkout_orders" ("idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_orders_razorpay_order_uq" ON "checkout_orders" ("razorpay_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_orders_razorpay_payment_uq" ON "checkout_orders" ("razorpay_payment_id");
CREATE INDEX IF NOT EXISTS "checkout_orders_status_created_idx" ON "checkout_orders" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "checkout_orders_customer_created_idx" ON "checkout_orders" ("customer_email_hash", "created_at");
CREATE INDEX IF NOT EXISTS "checkout_orders_promo_created_idx" ON "checkout_orders" ("promo_code_id", "created_at");
CREATE INDEX IF NOT EXISTS "checkout_orders_affiliate_created_idx" ON "checkout_orders" ("affiliate_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_promo_redemptions_order_uq" ON "checkout_promo_redemptions" ("order_id");
CREATE INDEX IF NOT EXISTS "checkout_promo_redemptions_promo_status_idx" ON "checkout_promo_redemptions" ("promo_code_id", "status", "reserved_expires_at");
CREATE INDEX IF NOT EXISTS "checkout_promo_redemptions_customer_promo_idx" ON "checkout_promo_redemptions" ("customer_email_hash", "promo_code_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_payments_provider_payment_uq" ON "checkout_payments" ("provider_payment_id");
CREATE INDEX IF NOT EXISTS "checkout_payments_order_created_idx" ON "checkout_payments" ("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "checkout_payments_provider_order_idx" ON "checkout_payments" ("provider_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_payment_events_provider_event_uq" ON "checkout_payment_events" ("provider_event_id");
CREATE INDEX IF NOT EXISTS "checkout_payment_events_order_received_idx" ON "checkout_payment_events" ("order_id", "received_at");
CREATE INDEX IF NOT EXISTS "checkout_payment_events_type_idx" ON "checkout_payment_events" ("event_type", "received_at");

INSERT INTO "checkout_products" (
  "id",
  "name",
  "description",
  "price_paise",
  "mrp_paise",
  "currency",
  "metadata_json"
)
VALUES (
  'reca-suno',
  'Reca Suno',
  'Lifetime Reca Membership',
  499900,
  1500000,
  'INR',
  '{"source":"checkout_seed"}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;
