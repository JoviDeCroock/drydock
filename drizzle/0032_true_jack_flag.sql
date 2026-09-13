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
CREATE UNIQUE INDEX `publication_alerts_org_release` ON `publication_alerts` (`organization_id`,`package_name`,`version`);