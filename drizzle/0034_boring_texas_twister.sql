CREATE TABLE `package_badge_opt_outs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`package_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_badge_opt_outs_package_org` ON `package_badge_opt_outs` (`package_key`,`organization_id`);--> statement-breakpoint
ALTER TABLE `scans` ADD `badge_package_key` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `badge_public` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `scans_badge_package_key_completed_idx` ON `scans` (`badge_package_key`,`completed_at`);