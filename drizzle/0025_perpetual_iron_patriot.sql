ALTER TABLE `scans` ADD `public_share_token` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `public_shared_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `public_shared_by_user_id` text REFERENCES user(id);--> statement-breakpoint
CREATE INDEX `scans_public_shared_by_idx` ON `scans` (`public_shared_by_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scans_public_share_token_unique_idx` ON `scans` (`public_share_token`);