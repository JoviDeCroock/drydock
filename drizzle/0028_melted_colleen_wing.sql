CREATE TABLE `atpm_oauth_requests` (
	`state` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by_user_id` text,
	`did` text NOT NULL,
	`handle` text,
	`pds` text NOT NULL,
	`issuer` text NOT NULL,
	`token_endpoint` text NOT NULL,
	`pkce_verifier` text NOT NULL,
	`dpop_key_ciphertext` text NOT NULL,
	`dpop_key_nonce` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `atpm_oauth_requests_expiry_idx` ON `atpm_oauth_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `atpm_publishers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`did` text NOT NULL,
	`handle` text,
	`pds` text NOT NULL,
	`verification_method` text NOT NULL,
	`verified_at` integer NOT NULL,
	`disabled_at` integer,
	`last_swept_at` integer,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atpm_publishers_org_did_unique_idx` ON `atpm_publishers` (`organization_id`,`did`);--> statement-breakpoint
CREATE INDEX `atpm_publishers_did_idx` ON `atpm_publishers` (`did`);