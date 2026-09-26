ALTER TABLE `publication_alerts` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `publication_alerts` ADD `delivery_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `publication_observations` ADD `previous_version` text;--> statement-breakpoint
ALTER TABLE `publication_observations` ADD `dist_tags` text;--> statement-breakpoint
ALTER TABLE `publication_observations` ADD `coverage_notified_at` integer;--> statement-breakpoint
ALTER TABLE `publication_watches` ADD `coverage_gap` text;--> statement-breakpoint
ALTER TABLE `publication_watches` ADD `coverage_gap_since` integer;--> statement-breakpoint
ALTER TABLE `publication_watches` ADD `coverage_gap_notified_at` integer;--> statement-breakpoint
ALTER TABLE `publication_watches` ADD `dist_tags_checked_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `staged_declared_sha1` text;