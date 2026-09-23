CREATE TABLE `npm_package_claims` (
	`registry_url` text NOT NULL,
	`ecosystem` text NOT NULL,
	`package_name` text NOT NULL,
	`organization_id` text,
	`first_stage_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	PRIMARY KEY(`registry_url`, `ecosystem`, `package_name`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `npm_package_claims_org_idx` ON `npm_package_claims` (`organization_id`);