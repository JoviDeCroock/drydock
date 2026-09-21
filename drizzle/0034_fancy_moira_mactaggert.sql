ALTER TABLE `scans` ADD `badge_package_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `badge_public` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `scans_badge_package_key_completed_idx` ON `scans` (`badge_package_key`,`completed_at`);