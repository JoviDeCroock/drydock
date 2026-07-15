CREATE TABLE `organization_milestones` (
	`organization_id` text NOT NULL,
	`milestone` text NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_milestones_org_milestone_unique_idx` ON `organization_milestones` (`organization_id`,`milestone`);--> statement-breakpoint
CREATE INDEX `organization_milestones_milestone_last_idx` ON `organization_milestones` (`milestone`,`last_at`);--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `callback_delivered_at` integer;