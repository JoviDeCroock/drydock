CREATE TABLE `release_authority_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`release_target_id` text NOT NULL,
	`gate_id` text NOT NULL,
	`run_id` integer NOT NULL,
	`workflow_path` text DEFAULT '' NOT NULL,
	`head_sha` text,
	`snapshot_json` text NOT NULL,
	`delta_json` text,
	`approved_at` integer,
	`approved_by_user_id` text,
	`artifact_binding_digest` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_target_id`) REFERENCES `github_release_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gate_id`) REFERENCES `github_workflow_gates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_authority_snapshots_gate_unique_idx` ON `release_authority_snapshots` (`gate_id`);--> statement-breakpoint
CREATE INDEX `release_authority_snapshots_baseline_idx` ON `release_authority_snapshots` (`organization_id`,`release_target_id`,`workflow_path`,`approved_at`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `require_authority_change_approval` integer DEFAULT false NOT NULL;