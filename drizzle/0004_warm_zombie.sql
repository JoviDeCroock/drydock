ALTER TABLE `scans` ADD `error_json` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_version` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_digest` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `completed_at` integer;