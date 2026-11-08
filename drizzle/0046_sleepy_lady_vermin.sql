ALTER TABLE `github_workflow_gates` ADD `run_attempt` integer;--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `reviewed_artifacts_json` text;--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `decision_delivered_at` integer;--> statement-breakpoint
CREATE INDEX `github_workflow_gates_run_key_idx` ON `github_workflow_gates` (`installation_row_id`,`repository_id`,`run_id`,`environment`);