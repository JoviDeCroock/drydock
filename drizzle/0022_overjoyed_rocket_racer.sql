CREATE TABLE `scan_report_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_report_shares_scan_unique_idx` ON `scan_report_shares` (`scan_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scan_report_shares_token_hash_unique_idx` ON `scan_report_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `scan_report_shares_org_idx` ON `scan_report_shares` (`organization_id`);