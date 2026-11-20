CREATE TABLE `reward_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`xp` integer NOT NULL,
	`gold` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`level` integer DEFAULT 1 NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`gold` integer DEFAULT 50 NOT NULL,
	`max_hp` integer DEFAULT 100 NOT NULL,
	`attack` integer DEFAULT 15 NOT NULL,
	`defense` integer DEFAULT 6 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);