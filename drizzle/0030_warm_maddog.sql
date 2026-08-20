DROP INDEX `scans_org_registry_status_idx`;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_status_superseded_at` integer;--> statement-breakpoint
CREATE INDEX `scans_org_registry_status_idx` ON `scans` (`organization_id`,`registry_url`,`registry_status_superseded_at`,`registry_version_status`,`registry_version_status_attempted_at`);