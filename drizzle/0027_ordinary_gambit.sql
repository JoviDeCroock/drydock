ALTER TABLE `scans` ADD `registry_url` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_package_name` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version_status` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version_status_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version_status_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_status_superseded_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_publish_reminder_at` integer;--> statement-breakpoint
CREATE INDEX `scans_org_registry_status_idx` ON `scans` (`organization_id`,`registry_url`,`registry_status_superseded_at`,`registry_version_status`,`registry_version_status_attempted_at`);--> statement-breakpoint
CREATE INDEX `scans_org_registry_release_idx` ON `scans` (`organization_id`,`registry_url`,`registry_package_name`,`registry_version`,`created_at`,`id`);