ALTER TABLE `scans` ADD `artifact_storage_version` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_manifest_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_manifest_digest` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_manifest_size` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `report_artifact_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `file_samples_artifact_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `diff_artifact_key` text;--> statement-breakpoint
CREATE INDEX `scans_artifact_backfill_idx` ON `scans` (`organization_id`,`status`,`artifact_storage_version`,`id`);