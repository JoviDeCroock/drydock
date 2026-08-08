CREATE TABLE `ci_release_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`release_set_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`release_set_id`) REFERENCES `ci_release_sets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_release_artifacts_set_path_unique_idx` ON `ci_release_artifacts` (`release_set_id`,`path`);--> statement-breakpoint
CREATE INDEX `ci_release_artifacts_set_idx` ON `ci_release_artifacts` (`release_set_id`);--> statement-breakpoint
CREATE TABLE `ci_release_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`run_id` integer NOT NULL,
	`run_attempt` integer DEFAULT 1 NOT NULL,
	`release_key` text DEFAULT '' NOT NULL,
	`ecosystem` text,
	`sha` text,
	`ref` text,
	`workflow_ref` text,
	`job_workflow_ref` text,
	`actor` text,
	`event_name` text,
	`status` text DEFAULT 'open' NOT NULL,
	`artifact_count` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`scan_id` text,
	`review_started_at` integer,
	`failure_reason` text,
	`verified_at` integer,
	`sealed_at` integer,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_release_sets_run_unique_idx` ON `ci_release_sets` (`organization_id`,`repository_id`,`run_id`,`run_attempt`,`release_key`);--> statement-breakpoint
CREATE INDEX `ci_release_sets_repo_run_idx` ON `ci_release_sets` (`organization_id`,`repository_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `ci_release_sets_org_status_idx` ON `ci_release_sets` (`organization_id`,`status`);--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `release_set_id` text REFERENCES ci_release_sets(id);--> statement-breakpoint
CREATE INDEX `github_workflow_gates_release_set_idx` ON `github_workflow_gates` (`release_set_id`);--> statement-breakpoint
ALTER TABLE `scans` ADD `release_set_id` text REFERENCES ci_release_sets(id);--> statement-breakpoint
CREATE INDEX `scans_release_set_org_idx` ON `scans` (`release_set_id`,`organization_id`);