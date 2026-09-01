ALTER TABLE "sessions" ADD COLUMN "manual_title" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "generated_title" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_manual_title_bounds" CHECK ("sessions"."manual_title" is null or char_length("sessions"."manual_title") between 1 and 120);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_generated_title_bounds" CHECK ("sessions"."generated_title" is null or char_length("sessions"."generated_title") between 1 and 120);