PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_github_release_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`ecosystem` text,
	`artifact_name` text,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`environment` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- artifact_name is new on this rebuild; existing rows inherit NULL. Omit it
-- from the SELECT because the old table does not have that column yet.
INSERT INTO `__new_github_release_targets`("id", "organization_id", "installation_row_id", "ecosystem", "repository_id", "repository_full_name", "environment", "created_by_user_id", "created_at", "updated_at") SELECT "id", "organization_id", "installation_row_id", "ecosystem", "repository_id", "repository_full_name", "environment", "created_by_user_id", "created_at", "updated_at" FROM `github_release_targets`;--> statement-breakpoint
DROP TABLE `github_release_targets`;--> statement-breakpoint
ALTER TABLE `__new_github_release_targets` RENAME TO `github_release_targets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `github_release_targets_org_repo_env_unique_idx` ON `github_release_targets` (`organization_id`,`repository_id`,`environment`);--> statement-breakpoint
CREATE INDEX `github_release_targets_installation_idx` ON `github_release_targets` (`installation_row_id`);--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `review_started_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `gate_id` text REFERENCES github_workflow_gates(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `scans_gate_org_idx` ON `scans` (`gate_id`,`organization_id`);