DO $$
DECLARE
	duplicate_count integer;
	duplicate_ids text;
BEGIN
	SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id")
	INTO duplicate_count, duplicate_ids
	FROM "users"
	WHERE lower("email") IN (
		SELECT lower("email") FROM "users" GROUP BY lower("email") HAVING count(*) > 1
	);
	IF duplicate_count > 0 THEN
		RAISE EXCEPTION 'Account email normalization found % Accounts sharing an email address (users.id: %)', duplicate_count, duplicate_ids
			USING HINT = 'Merge each duplicate before migrating: keep the earliest users row, repoint every foreign key that references the others, then delete them.';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
UPDATE "users" SET "email" = lower("email"), "updated_at" = now() WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "users" SET "email_verified" = true, "updated_at" = now()
WHERE EXISTS (SELECT 1 FROM "auth_identities" WHERE "auth_identities"."user_id" = "users"."id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));
