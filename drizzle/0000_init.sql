CREATE TYPE "public"."alert_severity" AS ENUM('INFO', 'WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."artwork_sale_status" AS ENUM('AVAILABLE', 'ON_HOLD', 'SOLD', 'NOT_FOR_SALE');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('CREATED', 'PENDING', 'AWAITING_CAPTURE', 'CAPTURING', 'PAYMENT_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'NEEDS_REFUND', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."cancellation_channel" AS ENUM('WEB', 'PHONE', 'EMAIL', 'REGISTERED_MAIL', 'IN_PERSON');--> statement-breakpoint
CREATE TYPE "public"."cancellation_reason" AS ENUM('CHANGE_OF_MIND', 'DEFECT', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."cancellation_regime" AS ENUM('IL', 'EU');--> statement-breakpoint
CREATE TYPE "public"."cancellation_status" AS ENUM('RECEIVED', 'ACCEPTED', 'REJECTED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."carrier" AS ENUM('MOCK', 'MANUAL', 'DHL');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('ILS', 'USD');--> statement-breakpoint
CREATE TYPE "public"."eligible_group" AS ENUM('NONE', 'SENIOR_65', 'DISABILITY', 'NEW_IMMIGRANT');--> statement-breakpoint
CREATE TYPE "public"."event_source" AS ENUM('MANUAL', 'POLL', 'WEBHOOK', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."export_decl_status" AS ENUM('NOT_REQUIRED', 'REQUIRED', 'PENDING_CARRIER', 'RECORDED');--> statement-breakpoint
CREATE TYPE "public"."generated_doc_kind" AS ENUM('DISCLOSURE', 'COA');--> statement-breakpoint
CREATE TYPE "public"."glazing" AS ENUM('NONE', 'GLASS', 'ACRYLIC');--> statement-breakpoint
CREATE TYPE "public"."hold_reason" AS ENUM('EXHIBITION', 'CONSIGNMENT', 'PRIVATE_VIEWING', 'RESERVED_OFFLINE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."image_role" AS ENUM('MAIN', 'DETAIL', 'EDGE', 'BACK', 'FRAMED', 'IN_ROOM', 'PROCESS');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('SEND_EMAIL', 'ISSUE_TAX_DOCUMENT', 'ISSUE_CREDIT_NOTE', 'REFUND_PAYMENT', 'REFUND_SETTLED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('PENDING', 'RUNNING', 'DONE', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('he', 'en');--> statement-breakpoint
CREATE TYPE "public"."medium" AS ENUM('OIL', 'ACRYLIC', 'WATERCOLOR', 'GOUACHE', 'INK', 'CHARCOAL', 'PASTEL', 'TEMPERA', 'MIXED_MEDIA', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('WEB', 'OFFER', 'QUOTE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('AWAITING_PAYMENT', 'PAYMENT_REVIEW', 'PAID', 'EXPIRED', 'CANCELLED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."orientation" AS ENUM('PORTRAIT', 'LANDSCAPE', 'SQUARE', 'PANORAMIC');--> statement-breakpoint
CREATE TYPE "public"."packaging_type" AS ENUM('ROLLED_TUBE', 'FLAT_BOX', 'STRETCHED_BOX', 'FRAMED_BOX', 'CRATE');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('MOCK', 'CARDCOM', 'PAYPAL', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."provider_mode" AS ENUM('MOCK', 'TEST', 'LIVE', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."refund_reason" AS ENUM('CANCELLATION', 'LOST_RESERVATION', 'DUPLICATE_PAYMENT', 'ORDER_CANCELLED', 'STALE_QUOTE', 'AMOUNT_MISMATCH', 'ADMIN', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('REQUESTED', 'IN_FLIGHT', 'PROVIDER_PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'MANUAL_REQUIRED', 'MANUAL_DONE');--> statement-breakpoint
CREATE TYPE "public"."request_kind" AS ENUM('QUESTION', 'OFFER', 'QUOTE');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('NEW', 'REPLIED', 'ACCEPTED', 'COUNTERED', 'QUOTED', 'DECLINED', 'AUTO_DECLINED', 'CONVERTED', 'EXPIRED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('NOT_APPLICABLE', 'AWAITING_RETURN', 'RECEIVED', 'INSPECTED_OK', 'INSPECTED_DAMAGED');--> statement-breakpoint
CREATE TYPE "public"."sale_channel" AS ENUM('ONLINE', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('AWAITING_FULFILLMENT', 'PACKED', 'LABEL_REQUESTED', 'LABEL_UNKNOWN', 'LABEL_CREATED', 'PICKUP_SCHEDULED', 'IN_TRANSIT', 'CUSTOMS', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED', 'CANCELLED', 'READY_FOR_PICKUP', 'COLLECTED');--> statement-breakpoint
CREATE TYPE "public"."shipping_method" AS ENUM('CARRIER_TABLE', 'LOCAL_PICKUP', 'ARTIST_DELIVERY', 'QUOTED');--> statement-breakpoint
CREATE TYPE "public"."size_bucket" AS ENUM('S', 'M', 'L', 'XL');--> statement-breakpoint
CREATE TYPE "public"."size_class" AS ENUM('S', 'M', 'L', 'QUOTE');--> statement-breakpoint
CREATE TYPE "public"."surface" AS ENUM('CANVAS', 'LINEN', 'WOOD_PANEL', 'BOARD', 'CARDBOARD', 'PAPER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."taxdoc_kind" AS ENUM('RECEIPT', 'INVOICE_RECEIPT', 'CREDIT_NOTE');--> statement-breakpoint
CREATE TYPE "public"."taxdoc_provider" AS ENUM('MOCK', 'MORNING', 'CARDCOM_GATEWAY', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."taxdoc_status" AS ENUM('ISSUING', 'UNKNOWN', 'ISSUED', 'FAILED', 'NEEDS_MANUAL');--> statement-breakpoint
CREATE TYPE "public"."vat_mode" AS ENUM('OSEK_PATUR', 'OSEK_MURSHE');--> statement-breakpoint
CREATE SEQUENCE "public"."artwork_inventory_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artwork_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artwork_id" uuid NOT NULL,
	"role" "image_role" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"alt_he" text DEFAULT '' NOT NULL,
	"alt_en" text DEFAULT '' NOT NULL,
	"public_key" text NOT NULL,
	"original_key" text,
	"og_key" text,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"blur_data_url" text,
	"dominant_color" text,
	"credit_line" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artwork_images_dominant_color_hex" CHECK ("artwork_images"."dominant_color" IS NULL OR "artwork_images"."dominant_color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "artwork_images_size_positive" CHECK ("artwork_images"."width" > 0 AND "artwork_images"."height" > 0 AND "artwork_images"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "artworks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"inventory_number" text DEFAULT ('A-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('artwork_inventory_seq')::text, 3, '0')) NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"series_id" uuid,
	"title_he" text NOT NULL,
	"title_en" text NOT NULL,
	"description_he" text DEFAULT '' NOT NULL,
	"description_en" text DEFAULT '' NOT NULL,
	"year_created" smallint,
	"medium" "medium" NOT NULL,
	"surface" "surface" NOT NULL,
	"medium_detail_he" text,
	"medium_detail_en" text,
	"height_mm" integer NOT NULL,
	"width_mm" integer NOT NULL,
	"depth_mm" integer,
	"framed" boolean DEFAULT false NOT NULL,
	"frame_height_mm" integer,
	"frame_width_mm" integer,
	"frame_depth_mm" integer,
	"glazing" "glazing" DEFAULT 'NONE' NOT NULL,
	"ready_to_hang" boolean DEFAULT false NOT NULL,
	"signed" boolean DEFAULT false NOT NULL,
	"painted_edges" boolean DEFAULT false NOT NULL,
	"coa_included" boolean DEFAULT false NOT NULL,
	"orientation" "orientation" NOT NULL,
	"size_bucket" "size_bucket" NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"sale_status" "artwork_sale_status" DEFAULT 'AVAILABLE' NOT NULL,
	"hold_reason" "hold_reason",
	"hold_note" text,
	"reserved_by_order_id" uuid,
	"reserved_until" timestamp with time zone,
	"sold_at" timestamp with time zone,
	"price_ils_minor" integer,
	"price_usd_minor" integer,
	"price_on_request" boolean DEFAULT false NOT NULL,
	"price_changed_at" timestamp with time zone,
	"offers_enabled" boolean DEFAULT false NOT NULL,
	"offer_auto_decline_below_ils_minor" integer,
	"packaging_type" "packaging_type" DEFAULT 'STRETCHED_BOX' NOT NULL,
	"can_be_rolled" boolean DEFAULT false NOT NULL,
	"packed_length_mm" integer,
	"packed_width_mm" integer,
	"packed_height_mm" integer,
	"packed_weight_g" integer,
	"size_class_override" "size_class",
	"ships_internationally" boolean DEFAULT true NOT NULL,
	"local_pickup_only" boolean DEFAULT false NOT NULL,
	"quote_only" boolean DEFAULT false NOT NULL,
	"dispatch_days" smallint DEFAULT 5 NOT NULL,
	"hs_code" text DEFAULT '9701.91' NOT NULL,
	"customs_description_en" text,
	"country_of_origin" char(2) DEFAULT 'IL' NOT NULL,
	"declared_value_override_minor" integer,
	"max_insurable_value_minor" integer,
	"credit_line" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artworks_slug_unique" UNIQUE("slug"),
	CONSTRAINT "artworks_inventory_number_unique" UNIQUE("inventory_number"),
	CONSTRAINT "artworks_slug_format" CHECK ("artworks"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "artworks_year_created_range" CHECK ("artworks"."year_created" IS NULL OR "artworks"."year_created" BETWEEN 1800 AND 2100),
	CONSTRAINT "artworks_dimensions_positive" CHECK ("artworks"."height_mm" > 0 AND "artworks"."width_mm" > 0 AND ("artworks"."depth_mm" IS NULL OR "artworks"."depth_mm" >= 0)),
	CONSTRAINT "artworks_packed_positive" CHECK (("artworks"."packed_length_mm" IS NULL OR "artworks"."packed_length_mm" > 0) AND ("artworks"."packed_width_mm" IS NULL OR "artworks"."packed_width_mm" > 0) AND ("artworks"."packed_height_mm" IS NULL OR "artworks"."packed_height_mm" > 0) AND ("artworks"."packed_weight_g" IS NULL OR "artworks"."packed_weight_g" > 0)),
	CONSTRAINT "artworks_reservation_pair" CHECK (("artworks"."reserved_by_order_id" IS NULL) = ("artworks"."reserved_until" IS NULL)),
	CONSTRAINT "artworks_reserved_only_available" CHECK ("artworks"."reserved_by_order_id" IS NULL OR "artworks"."sale_status" = 'AVAILABLE'),
	CONSTRAINT "artworks_sold_has_sold_at" CHECK ("artworks"."sale_status" <> 'SOLD' OR "artworks"."sold_at" IS NOT NULL),
	CONSTRAINT "artworks_prices_positive" CHECK (("artworks"."price_ils_minor" IS NULL OR "artworks"."price_ils_minor" > 0) AND ("artworks"."price_usd_minor" IS NULL OR "artworks"."price_usd_minor" > 0) AND ("artworks"."offer_auto_decline_below_ils_minor" IS NULL OR "artworks"."offer_auto_decline_below_ils_minor" > 0)),
	CONSTRAINT "artworks_customs_values_positive" CHECK (("artworks"."declared_value_override_minor" IS NULL OR "artworks"."declared_value_override_minor" > 0) AND ("artworks"."max_insurable_value_minor" IS NULL OR "artworks"."max_insurable_value_minor" >= 0)),
	CONSTRAINT "artworks_dispatch_days" CHECK ("artworks"."dispatch_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_he" text NOT NULL,
	"name_en" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_slug_unique" UNIQUE("slug"),
	CONSTRAINT "series_slug_format" CHECK ("series"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid,
	"sale_id" uuid,
	"kind" "generated_doc_kind" NOT NULL,
	"locale" "locale" NOT NULL,
	"version" text NOT NULL,
	"file_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generated_documents_order_kind_locale_version_uq" UNIQUE("order_id","kind","locale","version"),
	CONSTRAINT "generated_documents_has_owner" CHECK ("generated_documents"."order_id" IS NOT NULL OR "generated_documents"."sale_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "mock_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"flow" text DEFAULT 'DIRECT' NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"transaction_id" text,
	"refunded_minor" integer DEFAULT 0 NOT NULL,
	"capture_request_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"refund_request_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"return_url" text NOT NULL,
	"cancel_url" text NOT NULL,
	"notify_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_payments_ref_unique" UNIQUE("ref"),
	CONSTRAINT "mock_payments_flow_values" CHECK ("mock_payments"."flow" IN ('DIRECT', 'CAPTURE')),
	CONSTRAINT "mock_payments_state_values" CHECK ("mock_payments"."state" IN ('OPEN', 'APPROVED', 'PAID', 'REVIEW', 'DECLINED', 'CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
	CONSTRAINT "mock_payments_amounts" CHECK ("mock_payments"."amount_minor" > 0 AND "mock_payments"."refunded_minor" >= 0 AND "mock_payments"."refunded_minor" <= "mock_payments"."amount_minor")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"artwork_id" uuid NOT NULL,
	"title_he" text NOT NULL,
	"title_en" text NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"declared_value_minor" integer,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_order_artwork_uq" UNIQUE("order_id","artwork_id"),
	CONSTRAINT "order_items_amounts" CHECK ("order_items"."price_minor" >= 0 AND ("order_items"."declared_value_minor" IS NULL OR "order_items"."declared_value_minor" >= 0))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"client_request_id" uuid,
	"source" "order_source" DEFAULT 'WEB' NOT NULL,
	"status" "order_status" DEFAULT 'AWAITING_PAYMENT' NOT NULL,
	"status_reason" text,
	"locale" "locale" NOT NULL,
	"currency" "currency" NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"items_total_minor" integer NOT NULL,
	"shipping_minor" integer DEFAULT 0 NOT NULL,
	"insurance_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"vat_mode" "vat_mode" NOT NULL,
	"vat_rate_bp" integer DEFAULT 0 NOT NULL,
	"vat_minor" integer DEFAULT 0 NOT NULL,
	"fx_ils_per_unit" numeric(12, 6),
	"quote_version" integer DEFAULT 1 NOT NULL,
	"buyer_name" text,
	"buyer_email" text,
	"buyer_phone" text,
	"buyer_company_name" text,
	"buyer_vat_id" text,
	"ship_country" char(2) NOT NULL,
	"ship_name" text,
	"ship_line1" text,
	"ship_line2" text,
	"ship_city" text,
	"ship_region" text,
	"ship_postal_code" text,
	"ship_phone" text,
	"shipping_method" "shipping_method" NOT NULL,
	"shipping_quote" jsonb,
	"shipping_locked" boolean DEFAULT false NOT NULL,
	"terms_version" text,
	"returns_version" text,
	"privacy_version" text,
	"terms_accepted_at" timestamp with time zone,
	"age_confirmed_at" timestamp with time zone,
	"duties_notice_version" text,
	"duties_ack_at" timestamp with time zone,
	"receipt_email_consent" boolean DEFAULT false NOT NULL,
	"conversation_took_place" boolean DEFAULT false NOT NULL,
	"conversation_source" text,
	"disclosure_version" text,
	"disclosure_sent_at" timestamp with time zone,
	"disclosure_handed_over_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancellation_window_ends_at" timestamp with time zone,
	"fulfillment_blocked_reason" text,
	"expires_at" timestamp with time zone,
	"hold_count" smallint DEFAULT 0 NOT NULL,
	"first_held_at" timestamp with time zone,
	"paid_attempt_id" uuid,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"access_version" integer DEFAULT 1 NOT NULL,
	"client_ip_hash" text,
	"admin_notes" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_client_request_id_unique" UNIQUE("client_request_id"),
	CONSTRAINT "orders_amounts_nonnegative" CHECK ("orders"."items_total_minor" >= 0 AND "orders"."shipping_minor" >= 0 AND "orders"."insurance_minor" >= 0 AND "orders"."total_minor" >= 0 AND "orders"."vat_minor" >= 0 AND "orders"."vat_rate_bp" >= 0),
	CONSTRAINT "orders_total_sum" CHECK ("orders"."total_minor" = "orders"."items_total_minor" + "orders"."shipping_minor" + "orders"."insurance_minor"),
	CONSTRAINT "orders_il_pays_ils" CHECK ("orders"."ship_country" <> 'IL' OR "orders"."currency" = 'ILS'),
	CONSTRAINT "orders_vat_le_total" CHECK ("orders"."vat_minor" <= "orders"."total_minor"),
	CONSTRAINT "orders_paid_has_attempt" CHECK ("orders"."status" NOT IN ('PAID', 'COMPLETED') OR "orders"."paid_attempt_id" IS NOT NULL),
	CONSTRAINT "orders_status_reason_values" CHECK ("orders"."status_reason" IS NULL OR "orders"."status_reason" IN ('LOST_RESERVATION', 'BUYER_CANCELLATION', 'ADMIN', 'RELEASED', 'HOLD_TAKEN_OVER', 'LINK_EXPIRED', 'HOLD_EXPIRED', 'STALE_QUOTE')),
	CONSTRAINT "orders_fulfillment_blocked_reason_values" CHECK ("orders"."fulfillment_blocked_reason" IS NULL OR "orders"."fulfillment_blocked_reason" IN ('PAYMENT_REVIEW', 'DISPUTE', 'PAYMENT_REVERSED', 'EXTERNAL_REFUND', 'PENDING_CANCELLATION')),
	CONSTRAINT "orders_conversation_source_format" CHECK ("orders"."conversation_source" IS NULL OR "orders"."conversation_source" ~ '^(REQUEST:.+|LINK|ADMIN)$'),
	CONSTRAINT "orders_counters_nonnegative" CHECK ("orders"."hold_count" >= 0 AND "orders"."quote_version" >= 1 AND "orders"."access_version" >= 1),
	CONSTRAINT "orders_ship_country_upper" CHECK ("orders"."ship_country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" smallint NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_mode" "provider_mode" NOT NULL,
	"merchant_ref" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"status" "attempt_status" DEFAULT 'CREATED' NOT NULL,
	"quote_version" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"provider_ref" text,
	"transaction_id" text,
	"capture_id" text,
	"redirect_url" text,
	"create_request_id" uuid,
	"capture_request_id" uuid,
	"capture_tries" smallint DEFAULT 0 NOT NULL,
	"capturing_since" timestamp with time zone,
	"method" text,
	"installments" smallint,
	"card_last4" text,
	"card_brand" text,
	"is_foreign_card" boolean,
	"approval_code" text,
	"failure_reason" text,
	"verified_raw" jsonb,
	"next_check_at" timestamp with time zone,
	"check_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"tail_until" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_order_seq_uq" UNIQUE("order_id","seq"),
	CONSTRAINT "payment_attempts_seq_range" CHECK ("payment_attempts"."seq" BETWEEN 1 AND 5),
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount_minor" > 0),
	CONSTRAINT "payment_attempts_counters_nonnegative" CHECK ("payment_attempts"."capture_tries" >= 0 AND "payment_attempts"."check_count" >= 0 AND "payment_attempts"."quote_version" >= 1),
	CONSTRAINT "payment_attempts_mock_mode" CHECK ("payment_attempts"."provider" <> 'MOCK' OR "payment_attempts"."provider_mode" = 'MOCK'),
	CONSTRAINT "payment_attempts_offline_mode" CHECK ("payment_attempts"."provider" <> 'OFFLINE' OR "payment_attempts"."provider_mode" = 'MANUAL'),
	CONSTRAINT "payment_attempts_demo_not_live" CHECK (NOT "payment_attempts"."is_demo" OR "payment_attempts"."provider_mode" <> 'LIVE')
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text,
	"attempt_id" uuid,
	"authenticated" boolean DEFAULT false NOT NULL,
	"payload_redacted" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_count" integer DEFAULT 1 NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_provider_key_uq" UNIQUE("provider","event_key"),
	CONSTRAINT "payment_events_received_count" CHECK ("payment_events"."received_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"cancellation_id" uuid,
	"amount_minor" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"fee_withheld_minor" integer DEFAULT 0 NOT NULL,
	"reason" "refund_reason" NOT NULL,
	"status" "refund_status" DEFAULT 'REQUESTED' NOT NULL,
	"idem_key" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider_calls" smallint DEFAULT 0 NOT NULL,
	"in_flight_until" timestamp with time zone,
	"provider_refund_id" text,
	"manual_reference" text,
	"failure_confirmed_at" timestamp with time zone,
	"failure_confirmed_by" text,
	"requested_by" text NOT NULL,
	"legal_due_at" timestamp with time zone,
	"error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_idem_key_unique" UNIQUE("idem_key"),
	CONSTRAINT "refunds_provider_refund_id_unique" UNIQUE("provider_refund_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0),
	CONSTRAINT "refunds_counters_nonnegative" CHECK ("refunds"."fee_withheld_minor" >= 0 AND "refunds"."provider_calls" >= 0),
	CONSTRAINT "refunds_manual_done_reference" CHECK ("refunds"."status" <> 'MANUAL_DONE' OR "refunds"."manual_reference" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artwork_id" uuid NOT NULL,
	"order_id" uuid,
	"order_item_id" uuid,
	"channel" "sale_channel" NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" "currency" NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_online_has_order" CHECK ("sales"."channel" <> 'ONLINE' OR "sales"."order_id" IS NOT NULL),
	CONSTRAINT "sales_price_nonnegative" CHECK ("sales"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_id" uuid,
	"refund_id" uuid,
	"kind" "taxdoc_kind" NOT NULL,
	"provider" "taxdoc_provider" NOT NULL,
	"status" "taxdoc_status" DEFAULT 'ISSUING' NOT NULL,
	"marker" text NOT NULL,
	"provider_doc_id" text,
	"doc_number" text,
	"doc_type_code" integer,
	"allocation_number" text,
	"doc_url" text,
	"file_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"error" text,
	"issued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_documents_marker_unique" UNIQUE("marker"),
	CONSTRAINT "tax_documents_credit_note_has_refund" CHECK ("tax_documents"."kind" <> 'CREDIT_NOTE' OR "tax_documents"."refund_id" IS NOT NULL),
	CONSTRAINT "tax_documents_receipt_has_attempt" CHECK ("tax_documents"."kind" = 'CREDIT_NOTE' OR "tax_documents"."attempt_id" IS NOT NULL),
	CONSTRAINT "tax_documents_attempts_nonnegative" CHECK ("tax_documents"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "buyer_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "request_kind" NOT NULL,
	"topic" text,
	"artwork_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"country" char(2),
	"locale" "locale" NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"offer_amount_minor" integer,
	"offer_currency" "currency",
	"status" "request_status" DEFAULT 'NEW' NOT NULL,
	"order_id" uuid,
	"admin_reply" text,
	"replied_at" timestamp with time zone,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_requests_topic_values" CHECK ("buyer_requests"."topic" IS NULL OR "buyer_requests"."topic" IN ('GENERAL', 'COMMISSION', 'AVAILABILITY', 'SIMILAR_WORKS')),
	CONSTRAINT "buyer_requests_offer_amount" CHECK ("buyer_requests"."kind" <> 'OFFER' OR ("buyer_requests"."offer_amount_minor" > 0 AND "buyer_requests"."offer_currency" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid,
	"regime" "cancellation_regime" DEFAULT 'IL' NOT NULL,
	"status" "cancellation_status" DEFAULT 'RECEIVED' NOT NULL,
	"return_status" "return_status" DEFAULT 'NOT_APPLICABLE' NOT NULL,
	"channel" "cancellation_channel" DEFAULT 'WEB' NOT NULL,
	"reason" "cancellation_reason",
	"full_name" text NOT NULL,
	"id_number_enc" text,
	"id_number_last3" text,
	"order_number_input" text,
	"email" text,
	"phone" text,
	"message" text,
	"eligible_group" "eligible_group" DEFAULT 'NONE' NOT NULL,
	"duplicate_of_id" uuid,
	"possible_duplicate" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ack_sent_at" timestamp with time zone,
	"ack_snapshot" jsonb,
	"window_ends_at" timestamp with time zone,
	"within_window" boolean,
	"fee_minor" integer,
	"refund_amount_minor" integer,
	"refund_id" uuid,
	"refund_due_at" timestamp with time zone,
	"return_tracking" text,
	"return_received_at" timestamp with time zone,
	"inspection_notes" text,
	"decision_reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellations_number_unique" UNIQUE("number"),
	CONSTRAINT "cancellations_identifier_present" CHECK ("cancellations"."id_number_enc" IS NOT NULL OR "cancellations"."order_number_input" IS NOT NULL OR "cancellations"."order_id" IS NOT NULL),
	CONSTRAINT "cancellations_rejected_has_reason" CHECK ("cancellations"."status" <> 'REJECTED' OR "cancellations"."decision_reason" IS NOT NULL),
	CONSTRAINT "cancellations_amounts_nonnegative" CHECK (("cancellations"."fee_minor" IS NULL OR "cancellations"."fee_minor" >= 0) AND ("cancellations"."refund_amount_minor" IS NULL OR "cancellations"."refund_amount_minor" >= 0)),
	CONSTRAINT "cancellations_id_last3_format" CHECK ("cancellations"."id_number_last3" IS NULL OR "cancellations"."id_number_last3" ~ '^[0-9A-Za-z]{1,3}$'),
	CONSTRAINT "cancellations_not_self_duplicate" CHECK ("cancellations"."duplicate_of_id" IS NULL OR "cancellations"."duplicate_of_id" <> "cancellations"."id")
);
--> statement-breakpoint
CREATE TABLE "admin_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"kind" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_alerts_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"template" text NOT NULL,
	"to_email" text NOT NULL,
	"locale" "locale" NOT NULL,
	"subject" text NOT NULL,
	"driver" text NOT NULL,
	"provider_message_id" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"html" text,
	"text" text,
	"attachments" jsonb,
	"order_id" uuid,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "email_messages_status_values" CHECK ("email_messages"."status" IN ('PENDING', 'SENT', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "job_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_jobs_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_jobs_attempts_nonnegative" CHECK ("outbox_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limits_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_limits_count_nonnegative" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_values" CHECK ("settings"."key" IN ('business_profile', 'checkout', 'shipping', 'cancellation_policy', 'site_content'))
);
--> statement-breakpoint
CREATE TABLE "shipment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" "shipment_status",
	"code" text DEFAULT '' NOT NULL,
	"description" text,
	"location" text,
	"source" "event_source" NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipment_events_dedupe_uq" UNIQUE("shipment_id","source","occurred_at","code")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "shipment_status" DEFAULT 'AWAITING_FULFILLMENT' NOT NULL,
	"method" "shipping_method" NOT NULL,
	"carrier" "carrier",
	"carrier_name" text,
	"service_code" text,
	"adapter_mode" text,
	"tracking_number" text,
	"tracking_url" text,
	"packages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declared_value_minor" integer,
	"declared_currency" "currency",
	"insured_value_minor" integer,
	"insurance_provider" text,
	"insurance_premium_minor" integer,
	"hs_code" text,
	"origin_country" char(2),
	"contents_description_en" text,
	"reason_for_export" text,
	"incoterm" text,
	"commercial_invoice_number" text,
	"export_declaration_number" text,
	"export_decl_status" "export_decl_status" DEFAULT 'NOT_REQUIRED' NOT NULL,
	"label_file_key" text,
	"invoice_file_key" text,
	"packing_photo_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pickup_confirmation" text,
	"cost_actual_minor" integer,
	"charged_to_buyer_minor" integer,
	"idempotency_key" uuid,
	"label_attempt" integer DEFAULT 0 NOT NULL,
	"message_reference" text,
	"provider_shipment_id" text,
	"provider_response_redacted" jsonb,
	"cancellation_override_reason" text,
	"shipped_at" timestamp with time zone,
	"estimated_delivery_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_tracked_at" timestamp with time zone,
	"insurance_claim_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shipments_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "shipments_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "shipments_amounts_nonnegative" CHECK (("shipments"."declared_value_minor" IS NULL OR "shipments"."declared_value_minor" >= 0) AND ("shipments"."insured_value_minor" IS NULL OR "shipments"."insured_value_minor" >= 0) AND ("shipments"."insurance_premium_minor" IS NULL OR "shipments"."insurance_premium_minor" >= 0) AND ("shipments"."cost_actual_minor" IS NULL OR "shipments"."cost_actual_minor" >= 0) AND ("shipments"."charged_to_buyer_minor" IS NULL OR "shipments"."charged_to_buyer_minor" >= 0) AND "shipments"."label_attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artwork_images" ADD CONSTRAINT "artwork_images_artwork_id_artworks_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artworks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_series_id_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artworks" ADD CONSTRAINT "artworks_reserved_by_order_id_orders_id_fk" FOREIGN KEY ("reserved_by_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_payments" ADD CONSTRAINT "mock_payments_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_artwork_id_artworks_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artworks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_paid_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("paid_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cancellation_id_cancellations_id_fk" FOREIGN KEY ("cancellation_id") REFERENCES "public"."cancellations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_artwork_id_artworks_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artworks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_requests" ADD CONSTRAINT "buyer_requests_artwork_id_artworks_id_fk" FOREIGN KEY ("artwork_id") REFERENCES "public"."artworks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_requests" ADD CONSTRAINT "buyer_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_duplicate_of_id_cancellations_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."cancellations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "artwork_images_one_main_idx" ON "artwork_images" USING btree ("artwork_id") WHERE "artwork_images"."role" = 'MAIN';--> statement-breakpoint
CREATE INDEX "artwork_images_artwork_sort_idx" ON "artwork_images" USING btree ("artwork_id","sort_order");--> statement-breakpoint
CREATE INDEX "artworks_listing_idx" ON "artworks" USING btree ("is_published","sale_status","sort_order");--> statement-breakpoint
CREATE INDEX "artworks_series_idx" ON "artworks" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "artworks_reserved_until_idx" ON "artworks" USING btree ("reserved_until") WHERE "artworks"."reserved_by_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "generated_documents_sale_idx" ON "generated_documents" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "mock_payments_attempt_idx" ON "mock_payments" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "order_items_artwork_idx" ON "order_items" USING btree ("artwork_id");--> statement-breakpoint
CREATE INDEX "orders_status_expires_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "orders_buyer_email_idx" ON "orders" USING btree (lower("buyer_email"));--> statement-breakpoint
CREATE INDEX "orders_client_ip_created_idx" ON "orders" USING btree ("client_ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "orders_created_desc_idx" ON "orders" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_provider_ref_idx" ON "payment_attempts" USING btree ("provider","provider_ref") WHERE "payment_attempts"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_one_winner_idx" ON "payment_attempts" USING btree ("order_id") WHERE "payment_attempts"."status" IN ('CAPTURING', 'PAYMENT_REVIEW', 'SUCCEEDED');--> statement-breakpoint
CREATE INDEX "payment_attempts_status_next_check_idx" ON "payment_attempts" USING btree ("status","next_check_at");--> statement-breakpoint
CREATE INDEX "payment_events_unprocessed_idx" ON "payment_events" USING btree ("received_at") WHERE "payment_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_events_attempt_idx" ON "payment_events" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_one_live_per_cancellation_idx" ON "refunds" USING btree ("cancellation_id") WHERE "refunds"."cancellation_id" IS NOT NULL AND NOT ("refunds"."status" = 'FAILED' AND "refunds"."failure_confirmed_at" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "refunds_attempt_idx" ON "refunds" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_one_active_per_artwork_idx" ON "sales" USING btree ("artwork_id") WHERE "sales"."voided_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_one_active_per_order_item_idx" ON "sales" USING btree ("order_item_id") WHERE "sales"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sales_order_idx" ON "sales" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_documents_one_receipt_per_attempt_idx" ON "tax_documents" USING btree ("attempt_id") WHERE "tax_documents"."kind" IN ('RECEIPT', 'INVOICE_RECEIPT') AND "tax_documents"."status" <> 'FAILED';--> statement-breakpoint
CREATE UNIQUE INDEX "tax_documents_one_credit_note_per_refund_idx" ON "tax_documents" USING btree ("refund_id") WHERE "tax_documents"."kind" = 'CREDIT_NOTE' AND "tax_documents"."status" <> 'FAILED';--> statement-breakpoint
CREATE INDEX "tax_documents_order_idx" ON "tax_documents" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "tax_documents_status_idx" ON "tax_documents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "buyer_requests_one_new_offer_idx" ON "buyer_requests" USING btree ("artwork_id",lower("email")) WHERE "buyer_requests"."kind" = 'OFFER' AND "buyer_requests"."status" = 'NEW';--> statement-breakpoint
CREATE INDEX "buyer_requests_email_idx" ON "buyer_requests" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "buyer_requests_status_idx" ON "buyer_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "cancellations_order_idx" ON "cancellations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "cancellations_status_due_idx" ON "cancellations" USING btree ("status","refund_due_at");--> statement-breakpoint
CREATE INDEX "admin_alerts_open_idx" ON "admin_alerts" USING btree ("severity","created_at") WHERE "admin_alerts"."acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity","entity_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "cron_runs_job_started_idx" ON "cron_runs" USING btree ("job","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_messages_order_idx" ON "email_messages" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "email_messages_created_idx" ON "email_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbox_jobs_status_run_after_idx" ON "outbox_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_carrier_tracking_idx" ON "shipments" USING btree ("carrier","tracking_number") WHERE "shipments"."tracking_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");