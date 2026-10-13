CREATE TABLE `user_acquisition` (
	`user_id` text PRIMARY KEY NOT NULL,
	`experiment` text NOT NULL,
	`variant` text NOT NULL,
	`channel` text NOT NULL,
	`expires_at` integer NOT NULL,
	`first_review_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
