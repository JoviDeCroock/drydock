ALTER TABLE `scans` ADD `registry_published_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_first_viewed_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_last_viewed_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_view_count` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_first_view_surface` text;