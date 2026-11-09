CREATE TABLE `protection_health` (
	`release_target_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`snapshot_json` text,
	`checked_at` integer,
	`next_check_at` integer NOT NULL,
	`lease_id` text,
	`lease_until` integer,
	FOREIGN KEY (`release_target_id`) REFERENCES `github_release_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `protection_health_due_idx` ON `protection_health` (`next_check_at`);