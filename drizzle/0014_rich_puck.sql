ALTER TABLE `github_app_installations` ADD `last_failure_reason` text;--> statement-breakpoint
ALTER TABLE `github_app_installations` ADD `last_failure_at` integer;--> statement-breakpoint
ALTER TABLE `npm_connections` ADD `invalidated_at` integer;--> statement-breakpoint
ALTER TABLE `npm_connections` ADD `last_failure_reason` text;