CREATE INDEX `session_expires_idx` ON `session` (`expires_at`);--> statement-breakpoint
CREATE INDEX `verification_expires_idx` ON `verification` (`expires_at`);