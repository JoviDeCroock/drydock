CREATE TABLE `scan_detonations` (
	`scan_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_by_user_id` text,
	`artifact_sha256` text,
	`result_json` text,
	`error_code` text,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scan_detonations_org_idx` ON `scan_detonations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `scan_detonations_requested_by` ON `scan_detonations` (`requested_by_user_id`);