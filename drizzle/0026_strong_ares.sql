ALTER TABLE `scans` ADD `public_package_key` text;--> statement-breakpoint
CREATE INDEX `scans_public_package_key_idx` ON `scans` (`public_package_key`);