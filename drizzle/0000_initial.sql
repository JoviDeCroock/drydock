CREATE TABLE `scans` (
  `id` text PRIMARY KEY NOT NULL,
  `stage_id` text NOT NULL,
  `package_name` text,
  `staged_version` text,
  `previous_version` text,
  `risk` text DEFAULT 'unknown' NOT NULL,
  `status` text DEFAULT 'pending' NOT NULL,
  `summary_json` text,
  `ai_json` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE INDEX `scans_stage_id_idx` ON `scans` (`stage_id`);
CREATE INDEX `scans_package_idx` ON `scans` (`package_name`);

CREATE TABLE `scan_files` (
  `id` text PRIMARY KEY NOT NULL,
  `scan_id` text NOT NULL,
  `path` text NOT NULL,
  `status` text NOT NULL,
  `size` integer,
  `sha256` text,
  `flags_json` text NOT NULL,
  `text_sample` text,
  FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `scan_files_scan_path_idx` ON `scan_files` (`scan_id`,`path`);

CREATE TABLE `scan_findings` (
  `id` text PRIMARY KEY NOT NULL,
  `scan_id` text NOT NULL,
  `severity` text NOT NULL,
  `file` text NOT NULL,
  `evidence` text NOT NULL,
  `reason` text NOT NULL,
  `source` text DEFAULT 'rule' NOT NULL,
  FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `user` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `email_verified` integer DEFAULT false NOT NULL,
  `image` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);

CREATE TABLE `session` (
  `id` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL,
  `token` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);

CREATE TABLE `account` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` integer,
  `refresh_token_expires_at` integer,
  `scope` text,
  `password` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `verification` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer,
  `updated_at` integer
);
