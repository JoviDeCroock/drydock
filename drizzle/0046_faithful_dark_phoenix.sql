ALTER TABLE `github_workflow_gates` ADD `run_attempt` integer;--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `reviewed_artifacts_json` text;--> statement-breakpoint
ALTER TABLE `github_workflow_gates` ADD `decision_delivered_at` integer;--> statement-breakpoint
CREATE INDEX `github_workflow_gates_run_key_idx` ON `github_workflow_gates` (`installation_row_id`,`repository_id`,`run_id`,`environment`);--> statement-breakpoint
-- Gates decided before delivery was tracked count as delivered, so a replayed
-- request never re-posts their decision unchecked.
UPDATE `github_workflow_gates` SET `decision_delivered_at` = coalesce(`decided_at`, `updated_at`) WHERE `decision` IS NOT NULL;--> statement-breakpoint
-- Earlier duplicate requests for one deployment keep their row but drop the
-- deployment id, so the oldest gate per deployment owns the unique key.
UPDATE `github_workflow_gates` SET `deployment_id` = NULL WHERE `deployment_id` IS NOT NULL AND EXISTS (SELECT 1 FROM `github_workflow_gates` AS `older` WHERE `older`.`installation_row_id` = `github_workflow_gates`.`installation_row_id` AND `older`.`repository_id` = `github_workflow_gates`.`repository_id` AND `older`.`run_id` = `github_workflow_gates`.`run_id` AND `older`.`environment` = `github_workflow_gates`.`environment` AND `older`.`deployment_id` = `github_workflow_gates`.`deployment_id` AND (`older`.`created_at` < `github_workflow_gates`.`created_at` OR (`older`.`created_at` = `github_workflow_gates`.`created_at` AND `older`.`id` < `github_workflow_gates`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `github_workflow_gates_deployment_unique_idx` ON `github_workflow_gates` (`installation_row_id`,`repository_id`,`run_id`,`environment`,`deployment_id`) WHERE "github_workflow_gates"."deployment_id" is not null;