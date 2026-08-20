DROP INDEX `scans_org_registry_release_idx`;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_package_name` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_version` text;--> statement-breakpoint
CREATE INDEX `scans_org_registry_release_idx` ON `scans` (`organization_id`,`registry_url`,`registry_package_name`,`registry_version`,`created_at`,`id`);