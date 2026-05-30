ALTER TABLE `scans` ADD `artifact_storage_version` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_digest` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `artifact_size` integer;--> statement-breakpoint
CREATE INDEX `scans_artifact_backfill_idx` ON `scans` (`status`,`artifact_storage_version`,`created_at`);