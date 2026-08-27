ALTER TABLE `github_workflow_gates` ADD `registry_verification_attempted_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `registry_verified_at` integer;