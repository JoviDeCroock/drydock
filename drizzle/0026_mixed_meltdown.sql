ALTER TABLE `scans` ADD `public_feed_listed_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `public_package_key` text;--> statement-breakpoint
CREATE INDEX `scans_package_completed_idx` ON `scans` (`package_name`,`completed_at`);--> statement-breakpoint
CREATE INDEX `scans_public_feed_listed_idx` ON `scans` (`public_feed_listed_at`);--> statement-breakpoint
CREATE INDEX `scans_public_package_key_idx` ON `scans` (`public_package_key`);