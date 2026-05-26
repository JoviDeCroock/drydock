DROP INDEX `npm_connections_org_unique_idx`;--> statement-breakpoint
ALTER TABLE `npm_connections` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `npm_connections_org_active_unique_idx` ON `npm_connections` (`organization_id`) WHERE "npm_connections"."is_active" = 1;--> statement-breakpoint
CREATE INDEX `npm_connections_org_idx` ON `npm_connections` (`organization_id`);