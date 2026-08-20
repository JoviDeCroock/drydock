DROP INDEX `scans_ai_status_idx`;--> statement-breakpoint
ALTER TABLE `scans` ADD `ai_started_at` integer;--> statement-breakpoint
CREATE INDEX `scans_ai_status_idx` ON `scans` (`ai_status`,`ai_started_at`,`completed_at`);