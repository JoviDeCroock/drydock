ALTER TABLE `publication_alerts` ADD `review_scan_id` text REFERENCES scans(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `review_requested_at` integer;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `review_requested_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolution` text;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolved_at` integer;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolved_by` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `resolution_badge` text;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `reviewed_bytes` text;--> statement-breakpoint
CREATE INDEX `publication_alerts_review_scan` ON `publication_alerts` (`review_scan_id`);--> statement-breakpoint
CREATE INDEX `publication_alerts_package_badge` ON `publication_alerts` (`package_name`,`resolution_badge`);--> statement-breakpoint
CREATE INDEX `publication_alerts_review_requested_by` ON `publication_alerts` (`review_requested_by`);--> statement-breakpoint
CREATE INDEX `publication_alerts_resolved_by` ON `publication_alerts` (`resolved_by`);