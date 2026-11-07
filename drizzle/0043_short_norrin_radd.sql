ALTER TABLE `organization_api_keys` ADD `failed_totp_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organization_api_keys` ADD `last_totp_step` integer;