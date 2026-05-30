DROP INDEX `github_release_targets_org_pkg_unique_idx`;--> statement-breakpoint
ALTER TABLE `github_release_targets` DROP COLUMN `package_name`;--> statement-breakpoint
ALTER TABLE `github_release_targets` DROP COLUMN `workflow_filename`;--> statement-breakpoint
ALTER TABLE `github_release_targets` DROP COLUMN `pypi_trusted_publisher_environment`;