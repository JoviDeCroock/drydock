CREATE TABLE `publisher_setup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`failure_json` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `publisher_setup_jobs_owner_idx` ON `publisher_setup_jobs` (`organization_id`,`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `publisher_setup_jobs_expiry_idx` ON `publisher_setup_jobs` (`expires_at`);