DROP INDEX `scans_org_registry_status_idx`;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_url` text;--> statement-breakpoint
CREATE INDEX `scans_org_registry_release_idx` ON `scans` (`organization_id`,`registry_url`,`package_name`,`staged_version`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `scans_org_registry_status_idx` ON `scans` (`organization_id`,`registry_url`,`registry_version_status`,`registry_version_status_attempted_at`);