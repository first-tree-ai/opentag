DO $$
DECLARE
	conflicting_ids text;
BEGIN
	SELECT string_agg("id"::text, ', ' ORDER BY "id")
	INTO conflicting_ids
	FROM "auth_identities"
	WHERE ("issuer", "subject") IN (
		SELECT "issuer", "subject" FROM "auth_identities" GROUP BY "issuer", "subject" HAVING count(*) > 1
	);
	IF conflicting_ids IS NOT NULL THEN
		RAISE EXCEPTION 'Identity issuer/subject pairs are shared by more than one identity (auth_identities.id: %)', conflicting_ids
			USING HINT = 'Better Auth resolves an account by issuer and subject alone. Reconcile these rows before migrating.';
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "access_token" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "id_token" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "access_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "password" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_unique" ON "auth_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "auth_verifications_expires_at_idx" ON "auth_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_issuer_subject_unique" ON "auth_identities" USING btree ("issuer","subject");--> statement-breakpoint
/*
 * Repeat the verification backfill from the Account email migration.
 *
 * 0020 is deliberately expand-only so the previous server revision keeps running against the new schema, which a
 * rollback requires because rolling back application code does not roll back migrations. That revision predates the
 * writer which maintains `email_verified`, so any Account it created between the two deployments carries `false`
 * despite holding a verified provider identity. Every migration that precedes a consumer of this flag repeats the
 * reconciliation; it is idempotent, and the stage that first reads the flag must repeat it again.
 *
 * The `users_email_unique` backstop is deliberately in neither this migration nor 0020. Staging deploys the tip and
 * skips revisions it has passed, so a rollout can go straight from a pre-resolver server to this head with the old
 * container still serving — and that container inserts a `users` row without resolving the address, which the index
 * would answer with a raw `23505`. Nothing depends on the index; the resolver's advisory claim already keeps one
 * address on one Account. It belongs in a later release, once the resolver revision is confirmed to be the one serving.
 */
UPDATE "users" SET "email_verified" = true, "updated_at" = now()
WHERE "email_verified" = false
	AND EXISTS (SELECT 1 FROM "auth_identities" WHERE "auth_identities"."user_id" = "users"."id");
