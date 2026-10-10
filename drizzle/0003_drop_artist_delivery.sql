ALTER TABLE "orders" ALTER COLUMN "shipping_method" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "method" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."shipping_method";--> statement-breakpoint
CREATE TYPE "public"."shipping_method" AS ENUM('CARRIER_TABLE', 'LOCAL_PICKUP', 'QUOTED', 'ISRAEL_POST');--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_method" SET DATA TYPE "public"."shipping_method" USING "shipping_method"::"public"."shipping_method";--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "method" SET DATA TYPE "public"."shipping_method" USING "method"::"public"."shipping_method";