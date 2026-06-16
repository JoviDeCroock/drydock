CREATE INDEX `github_workflow_gates_scan_idx` ON `github_workflow_gates` (`scan_id`);--> statement-breakpoint
CREATE INDEX `scan_events_created_at_idx` ON `scan_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `scans_created_at_idx` ON `scans` (`created_at`);