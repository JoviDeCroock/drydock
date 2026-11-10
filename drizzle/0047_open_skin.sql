ALTER TABLE `dependency_reviews` ADD `attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `dependency_reviews` ADD `progress_json` text;