CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TABLE "billing"."accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing"."attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"account" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid,
	"source" text NOT NULL,
	"gateway" text NOT NULL,
	"model" text NOT NULL,
	"response_id" text,
	"provider_call_id" text,
	"rates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"state" text DEFAULT 'in_flight' NOT NULL,
	"resolution" text,
	"resolution_reason" text,
	"usage_complete" boolean DEFAULT false NOT NULL,
	"input_tokens" bigint,
	"cached_input_tokens" bigint,
	"output_tokens" bigint,
	"priced_micros" bigint,
	"debited_micros" bigint,
	"reconcile_after" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "attempts_source_valid" CHECK ("billing"."attempts"."source" IN ('execution','connectivity_probe')),
	CONSTRAINT "attempts_state_valid" CHECK ("billing"."attempts"."state" IN ('in_flight','pending_usage','finalized')),
	CONSTRAINT "attempts_resolution_valid" CHECK (("billing"."attempts"."state" = 'finalized') = ("billing"."attempts"."resolution" IS NOT NULL) AND ("billing"."attempts"."resolution" IS NULL OR "billing"."attempts"."resolution" IN ('charged','no_charge','unbilled','written_off'))),
	CONSTRAINT "attempts_usage_nonnegative" CHECK ("billing"."attempts"."input_tokens" >= 0 AND "billing"."attempts"."output_tokens" >= 0 AND "billing"."attempts"."cached_input_tokens" >= 0 AND "billing"."attempts"."cached_input_tokens" <= "billing"."attempts"."input_tokens"),
	CONSTRAINT "attempts_debit_valid" CHECK ("billing"."attempts"."priced_micros" >= 0 AND "billing"."attempts"."debited_micros" >= 0 AND "billing"."attempts"."debited_micros" <= "billing"."attempts"."priced_micros"),
	CONSTRAINT "attempts_reconcile_failures_nonnegative" CHECK ("billing"."attempts"."reconcile_failures" >= 0)
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
ALTER TABLE "im_message_deliveries" ADD COLUMN "execution_origin" text;--> statement-breakpoint
ALTER TABLE "billing"."accounts" ADD CONSTRAINT "accounts_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."attempts" ADD CONSTRAINT "attempts_account_users_id_fk" FOREIGN KEY ("account") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."checkouts" ADD CONSTRAINT "checkouts_account_accounts_id_fk" FOREIGN KEY ("account") REFERENCES "billing"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."grants" ADD CONSTRAINT "grants_account_accounts_id_fk" FOREIGN KEY ("account") REFERENCES "billing"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempts_account" ON "billing"."attempts" USING btree ("account","created_at");--> statement-breakpoint
CREATE INDEX "attempts_agent" ON "billing"."attempts" USING btree ("account","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_pending" ON "billing"."attempts" USING btree ("reconcile_after","created_at") WHERE "billing"."attempts"."state" = 'pending_usage';--> statement-breakpoint
CREATE INDEX "checkouts_account" ON "billing"."checkouts" USING btree ("account");--> statement-breakpoint
CREATE INDEX "grants_account" ON "billing"."grants" USING btree ("account");