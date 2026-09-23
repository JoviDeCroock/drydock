ALTER TABLE `publication_alerts` ADD `notified_at` integer;--> statement-breakpoint
ALTER TABLE `publication_observations` ADD `previous_version` text;--> statement-breakpoint
ALTER TABLE `publication_observations` ADD `dist_tags` text;
