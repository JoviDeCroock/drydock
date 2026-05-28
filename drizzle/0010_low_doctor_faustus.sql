ALTER TABLE `scans` ADD `changed_file_count` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `finding_count` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `risk_summary_json` text;