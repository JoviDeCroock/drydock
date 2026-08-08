ALTER TABLE `scans` ADD `finding_profile_json` text;--> statement-breakpoint
CREATE INDEX `scans_org_package_decision_created_idx` ON `scans` (`organization_id`,`package_name`,`status`,`decision`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `scans_created_idx` ON `scans` (`created_at`);--> statement-breakpoint
CREATE INDEX `session_expires_idx` ON `session` (`expires_at`);--> statement-breakpoint
CREATE INDEX `verification_expires_idx` ON `verification` (`expires_at`);