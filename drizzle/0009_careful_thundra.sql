CREATE TABLE `github_app_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`target_type` text DEFAULT 'Organization' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_at` integer,
	`uninstalled_at` integer,
	`created_by_user_id` text,
	`installed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_app_installations_installation_unique_idx` ON `github_app_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `github_app_installations_org_idx` ON `github_app_installations` (`organization_id`);--> statement-breakpoint
CREATE TABLE `github_release_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`installation_row_id` text NOT NULL,
	`ecosystem` text NOT NULL,
	`package_name` text NOT NULL,
	`repository_id` integer NOT NULL,
	`repository_full_name` text NOT NULL,
	`workflow_filename` text,
	`environment` text NOT NULL,
	`pypi_trusted_publisher_environment` text NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`installation_row_id`) REFERENCES `github_app_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_release_targets_org_pkg_unique_idx` ON `github_release_targets` (`organization_id`,`ecosystem`,`package_name`);--> statement-breakpoint
CREATE INDEX `github_release_targets_repo_env_idx` ON `github_release_targets` (`repository_id`,`environment`);--> statement-breakpoint
CREATE INDEX `github_release_targets_installation_idx` ON `github_release_targets` (`installation_row_id`);