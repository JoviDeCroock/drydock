CREATE TABLE `marketing_referrals` (
	`day` text NOT NULL,
	`surface` text NOT NULL,
	`source` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `surface`, `source`)
);
--> statement-breakpoint
CREATE INDEX `marketing_referrals_day_idx` ON `marketing_referrals` (`day`);