ALTER TABLE `publication_alerts` ADD `review_scan_id` text REFERENCES scans(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `review_requested_at` integer;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `review_requested_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolution` text;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolved_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolution_badge` text;--> statement-breakpoint
CREATE INDEX `publication_alerts_review_scan` ON `publication_alerts` (`review_scan_id`);