/*
 * Expand only. Nothing here changes how the previous server revision behaves, which a rollback requires because
 * rolling back application code does not roll back migrations.
 *
 * A `users_email_unique` index deliberately does NOT land here, or in any migration in this series. That revision
 * handles an unknown provider subject by inserting a new `users` row without first resolving the Account already
 * holding the address, so creating the index while it is still serving would turn its bootstrap-Account first sign-in
 * from a silent duplicate into a raw `23505`. Staging deploys the tip and skips revisions it has passed, so no later
 * migration in this series can assume that revision has drained either. The index is a backstop for writers that skip
 * the resolver; it belongs in a later release, once the resolver revision is confirmed to be the one serving.
 * Correctness until then comes from the resolver's advisory lock on the address itself.
 */
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
UPDATE "users" SET "email" = lower("email"), "updated_at" = now() WHERE "email" <> lower("email");--> statement-breakpoint
UPDATE "users" SET "email_verified" = true, "updated_at" = now()
WHERE EXISTS (SELECT 1 FROM "auth_identities" WHERE "auth_identities"."user_id" = "users"."id");
