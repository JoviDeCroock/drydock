ALTER TABLE `scans` ADD `ai_status` text;--> statement-breakpoint
CREATE INDEX `scans_status_started_idx` ON `scans` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `scans_ai_status_idx` ON `scans` (`ai_status`,`completed_at`);