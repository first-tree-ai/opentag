DROP INDEX "computers_current_installation_id_unique";--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "computers_current_installation_id_unique" ON "computers" USING btree ("current_installation_id") WHERE "computers"."deleted_at" IS NULL;