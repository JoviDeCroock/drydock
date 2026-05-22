ALTER TABLE `scans` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `decided_by_user_id` text REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `scans` ADD `decided_at` integer;--> statement-breakpoint
CREATE INDEX `scans_org_decision_created_idx` ON `scans` (`organization_id`,`decision`,`created_at`);