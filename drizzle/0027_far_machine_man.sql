ALTER TABLE `scans` ADD `registry_version_status` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version_status_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_publish_reminder_at` integer;--> statement-breakpoint
CREATE INDEX `scans_org_registry_status_idx` ON `scans` (`organization_id`,`registry_version_status`,`registry_version_status_at`);