CREATE TABLE `dependency_review_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`ecosystem` text NOT NULL,
	`package_name` text NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`source` text DEFAULT 'public' NOT NULL,
	`approved_by_login` text NOT NULL,
	`approved_by_github_id` integer NOT NULL,
	`review_id` text,
	`approved_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_id`) REFERENCES `dependency_reviews`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_review_approvals_change_unique_idx` ON `dependency_review_approvals` (`organization_id`,`repository_id`,`ecosystem`,`package_name`,`from_version`,`to_version`,`source`);--> statement-breakpoint
CREATE TABLE `dependency_review_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`policy_json` text DEFAULT '{}' NOT NULL,
	`extra_bot_logins_json` text DEFAULT '[]' NOT NULL,
	`updated_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `dependency_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`pull_number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`author_login` text NOT NULL,
	`check_run_id` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`bump_count` integer DEFAULT 0 NOT NULL,
	`held_count` integer DEFAULT 0 NOT NULL,
	`bumps_json` text,
	`unread_lockfiles_json` text DEFAULT '[]' NOT NULL,
	`listing_complete` integer DEFAULT true NOT NULL,
	`failure_reason` text,
	`approved_by_login` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dependency_reviews_repo_head_unique_idx` ON `dependency_reviews` (`installation_row_id`,`repository_id`,`head_sha`);--> statement-breakpoint
CREATE INDEX `dependency_reviews_org_created_idx` ON `dependency_reviews` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `dependency_reviews_repo_pull_idx` ON `dependency_reviews` (`installation_row_id`,`repository_id`,`pull_number`);