CREATE TABLE `organization_webhook_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`hostname` text NOT NULL,
	`credentials_ciphertext` text NOT NULL,
	`credentials_nonce` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_webhook_connections_org_unique_idx` ON `organization_webhook_connections` (`organization_id`);