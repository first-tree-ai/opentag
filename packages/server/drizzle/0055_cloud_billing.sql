CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TABLE "billing"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_hash" text,
	"encrypted_key" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"needs_sync" boolean DEFAULT true NOT NULL,
	"sync_after" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_failures" integer DEFAULT 0 NOT NULL,
	"spent_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "accounts_sync_failures_nonnegative" CHECK ("billing"."accounts"."sync_failures" >= 0),
	CONSTRAINT "accounts_spent_nonnegative" CHECK ("billing"."accounts"."spent_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"account" uuid NOT NULL,
	"model" text NOT NULL,
	"generation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"charge_micros" bigint,
	"reconcile_after" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "attempts_generation_unique" UNIQUE("generation"),
	CONSTRAINT "attempts_reconcile_failures_nonnegative" CHECK ("billing"."attempts"."reconcile_failures" >= 0),
	CONSTRAINT "attempts_usage_nonnegative" CHECK ("billing"."attempts"."input_tokens" >= 0 AND "billing"."attempts"."output_tokens" >= 0 AND "billing"."attempts"."charge_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"account" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"session" text,
	"payment" text,
	"refunded" integer DEFAULT 0 NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "checkouts_session_unique" UNIQUE("session"),
	CONSTRAINT "checkouts_payment_unique" UNIQUE("payment"),
	CONSTRAINT "checkouts_amount_positive" CHECK ("billing"."checkouts"."amount_cents" > 0),
	CONSTRAINT "checkouts_refund_valid" CHECK ("billing"."checkouts"."refunded" >= 0 AND "billing"."checkouts"."refunded" <= "billing"."checkouts"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "billing"."grants" (
	"id" text PRIMARY KEY NOT NULL,
	"account" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."payment_changes" (
	"payment" text PRIMARY KEY NOT NULL,
	"refunded" integer DEFAULT 0 NOT NULL,
	"disputed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "payment_changes_refund_nonnegative" CHECK ("billing"."payment_changes"."refunded" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing"."settings" (
	"id" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing"."accounts" ADD CONSTRAINT "accounts_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."attempts" ADD CONSTRAINT "attempts_account_accounts_id_fk" FOREIGN KEY ("account") REFERENCES "billing"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."checkouts" ADD CONSTRAINT "checkouts_account_accounts_id_fk" FOREIGN KEY ("account") REFERENCES "billing"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."grants" ADD CONSTRAINT "grants_account_accounts_id_fk" FOREIGN KEY ("account") REFERENCES "billing"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_pending" ON "billing"."accounts" USING btree ("sync_after","id") WHERE "billing"."accounts"."needs_sync" = true;--> statement-breakpoint
CREATE INDEX "attempts_account" ON "billing"."attempts" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "attempts_pending" ON "billing"."attempts" USING btree ("reconcile_after","created_at") WHERE "billing"."attempts"."charge_micros" IS NULL AND "billing"."attempts"."generation" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "checkouts_account" ON "billing"."checkouts" USING btree ("account");--> statement-breakpoint
CREATE INDEX "grants_account" ON "billing"."grants" USING btree ("account");
