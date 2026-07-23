CREATE INDEX `scan_events_created_idx` ON `scan_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `scan_events_actor_idx` ON `scan_events` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `scans_decided_by_idx` ON `scans` (`decided_by_user_id`);--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);