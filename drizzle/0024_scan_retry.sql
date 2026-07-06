ALTER TABLE `scans` ADD `retry_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scans` ADD `last_retried_at` integer;