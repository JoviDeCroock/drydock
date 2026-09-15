CREATE TABLE `publication_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`package_name` text NOT NULL,
	`version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`acknowledged_at` integer,
	`acknowledged_by` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_alerts_org_release` ON `publication_alerts` (`organization_id`,`package_name`,`version`);--> statement-breakpoint
CREATE TABLE `publication_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`watch_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`version` text NOT NULL,
	`published_at` integer,
	`first_seen_at` integer NOT NULL,
	`checked_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`sha256` text,
	`sha1` text,
	`scan_id` text,
	FOREIGN KEY (`watch_id`) REFERENCES `publication_watches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_observations_watch_version` ON `publication_observations` (`watch_id`,`version`);--> statement-breakpoint
CREATE INDEX `publication_observations_org_watch` ON `publication_observations` (`organization_id`,`watch_id`,`first_seen_at`);--> statement-breakpoint
CREATE TABLE `publication_watch_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`package_name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`stopped_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_watch_candidates_org_package` ON `publication_watch_candidates` (`organization_id`,`package_name`);--> statement-breakpoint
CREATE INDEX `publication_watch_candidates_pending` ON `publication_watch_candidates` (`stopped_at`,`source`,`created_at`);--> statement-breakpoint
CREATE TABLE `publication_watches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`package_name` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_watches_org_package` ON `publication_watches` (`organization_id`,`package_name`);--> statement-breakpoint
CREATE INDEX `publication_watches_due` ON `publication_watches` (`last_checked_at`);