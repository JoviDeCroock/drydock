CREATE TABLE `pypi_project_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_name` text NOT NULL,
	`index_origin` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_nonce` text NOT NULL,
	`token_fingerprint` text NOT NULL,
	`token_last4` text,
	`validated_at` integer,
	`last_used_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pypi_project_tokens_org_project_unique_idx` ON `pypi_project_tokens` (`organization_id`,`index_origin`,`project_name`);--> statement-breakpoint
CREATE TABLE `pypi_stage_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`gate_id` text NOT NULL,
	`token_id` text,
	`project_name` text NOT NULL,
	`version` text NOT NULL,
	`index_origin` text NOT NULL,
	`links_ciphertext` text NOT NULL,
	`links_nonce` text NOT NULL,
	`session_fingerprint` text NOT NULL,
	`reviewed_files_json` text NOT NULL,
	`state` text DEFAULT 'held' NOT NULL,
	`state_detail` text,
	`expires_at` integer,
	`last_extended_at` integer,
	`last_checked_at` integer,
	`publish_claimed_at` integer,
	`approved_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`gate_id`) REFERENCES `github_workflow_gates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `pypi_project_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pypi_stage_sessions_gate_project_unique_idx` ON `pypi_stage_sessions` (`gate_id`,`project_name`);--> statement-breakpoint
CREATE INDEX `pypi_stage_sessions_state_idx` ON `pypi_stage_sessions` (`state`,`last_checked_at`);--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `decision_delivered_at` integer;