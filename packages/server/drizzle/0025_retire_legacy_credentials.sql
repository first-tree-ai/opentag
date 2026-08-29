DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM "users" GROUP BY lower("email") HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'Two Accounts share an email address; merge them before this migration can enforce one Account per address. Run: select lower(email) as email, count(*), array_agg(id order by created_at) as ids from users group by 1 having count(*) > 1;';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "account_legacy_upgrades" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "account_legacy_upgrades" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree (lower("email"));