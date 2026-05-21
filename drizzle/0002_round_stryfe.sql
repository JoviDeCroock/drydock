CREATE TABLE `npm_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`registry_url` text NOT NULL,
	`label` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_nonce` text NOT NULL,
	`token_fingerprint` text NOT NULL,
	`token_last4` text,
	`validation_status` text DEFAULT 'unvalidated' NOT NULL,
	`capabilities_json` text,
	`validated_at` integer,
	`last_used_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `npm_connections_org_unique_idx` ON `npm_connections` (`organization_id`);--> statement-breakpoint
CREATE INDEX `npm_connections_fingerprint_idx` ON `npm_connections` (`token_fingerprint`);