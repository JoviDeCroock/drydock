CREATE TABLE `scan_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_approvals_scan_user_unique_idx` ON `scan_approvals` (`scan_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `scan_approvals_scan_idx` ON `scan_approvals` (`scan_id`);--> statement-breakpoint
CREATE INDEX `scan_approvals_org_idx` ON `scan_approvals` (`organization_id`);--> statement-breakpoint
CREATE INDEX `scan_approvals_user_idx` ON `scan_approvals` (`user_id`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `required_release_approvals` integer DEFAULT 1 NOT NULL;