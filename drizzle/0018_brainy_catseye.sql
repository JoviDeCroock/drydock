CREATE TABLE `organization_slack_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`team_id` text NOT NULL,
	`team_name` text,
	`bot_user_id` text,
	`scope` text,
	`bot_token_ciphertext` text NOT NULL,
	`bot_token_nonce` text NOT NULL,
	`channel_id` text,
	`channel_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slack_connections_org_unique_idx` ON `organization_slack_connections` (`organization_id`);