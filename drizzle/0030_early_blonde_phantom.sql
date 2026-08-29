CREATE TABLE `out_of_band_publishes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`registry_url` text NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`status_confirmed` integer DEFAULT false NOT NULL,
	`detected_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by_user_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`acknowledged_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `out_of_band_publishes_release_unique_idx` ON `out_of_band_publishes` (`organization_id`,`registry_url`,`package_name`,`version`);--> statement-breakpoint
CREATE INDEX `out_of_band_publishes_org_ack_idx` ON `out_of_band_publishes` (`organization_id`,`acknowledged_at`);--> statement-breakpoint
CREATE TABLE `package_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`registry_url` text NOT NULL,
	`package_name` text NOT NULL,
	`versions_json` text NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `package_watches_org_package_unique_idx` ON `package_watches` (`organization_id`,`registry_url`,`package_name`);--> statement-breakpoint
CREATE INDEX `package_watches_org_checked_idx` ON `package_watches` (`organization_id`,`last_checked_at`);