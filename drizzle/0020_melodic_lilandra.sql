CREATE TABLE `scan_comment_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`mentioned_user_id` text NOT NULL,
	`notified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `scan_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mentioned_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scan_comment_mentions_comment_user_unique_idx` ON `scan_comment_mentions` (`comment_id`,`mentioned_user_id`);--> statement-breakpoint
CREATE INDEX `scan_comment_mentions_user_idx` ON `scan_comment_mentions` (`mentioned_user_id`);--> statement-breakpoint
CREATE TABLE `scan_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`scan_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`author_user_id` text,
	`parent_id` text,
	`body` text NOT NULL,
	`anchor_type` text DEFAULT 'general' NOT NULL,
	`file_path` text,
	`line` integer,
	`file_sha256` text,
	`finding_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `scan_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `scan_findings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scan_comments_scan_created_idx` ON `scan_comments` (`scan_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scan_comments_org_idx` ON `scan_comments` (`organization_id`);--> statement-breakpoint
CREATE TABLE `user_notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`mention_emails` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
