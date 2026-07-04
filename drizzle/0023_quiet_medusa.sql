CREATE TABLE `organization_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_last4` text NOT NULL,
	`scopes_json` text NOT NULL,
	`created_by_user_id` text,
	`revoked_by_user_id` text,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_api_tokens_token_hash_unique_idx` ON `organization_api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `organization_api_tokens_org_active_idx` ON `organization_api_tokens` (`organization_id`,`revoked_at`,`created_at`);