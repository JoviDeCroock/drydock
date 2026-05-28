CREATE TABLE `github_workflow_gates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`release_target_id` text NOT NULL,
	`delivery_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`environment` text NOT NULL,
	`run_id` integer NOT NULL,
	`deployment_id` integer,
	`deployment_callback_url` text NOT NULL,
	`event_action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision` text,
	`decision_comment` text,
	`report_url` text,
	`scan_id` text,
	`failure_reason` text,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`release_target_id`) REFERENCES `github_release_targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_workflow_gates_delivery_unique_idx` ON `github_workflow_gates` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `github_workflow_gates_org_status_idx` ON `github_workflow_gates` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `github_workflow_gates_release_target_idx` ON `github_workflow_gates` (`release_target_id`);