ALTER TABLE `scans` ADD `release_status` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `staged_shasum` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `stage_missing_since` integer;