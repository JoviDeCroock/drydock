ALTER TABLE `npm_connections` ADD `next_discovery_at` integer;--> statement-breakpoint
ALTER TABLE `npm_connections` ADD `discovery_backoff_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `npm_connections_discovery_due_idx` ON `npm_connections` (`validation_status`,`next_discovery_at`);