CREATE TABLE `battles` (
	`id` text PRIMARY KEY NOT NULL,
	`zone_id` text NOT NULL,
	`player1_id` text NOT NULL,
	`player2_id` text NOT NULL,
	`active_turn_player_id` text NOT NULL,
	`turn_number` integer DEFAULT 1 NOT NULL,
	`turn_deadline_at` integer NOT NULL,
	`p1_timeouts` integer DEFAULT 0 NOT NULL,
	`p2_timeouts` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ACTIVE' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_battles_status_deadline` ON `battles` (`status`,`turn_deadline_at`);--> statement-breakpoint
CREATE TABLE `pending_rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`xp` integer NOT NULL,
	`gold` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pending_rewards_retry` ON `pending_rewards` (`next_retry_at`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`x` real DEFAULT 120 NOT NULL,
	`y` real DEFAULT 120 NOT NULL,
	`hp` integer DEFAULT 100 NOT NULL,
	`max_hp` integer DEFAULT 100 NOT NULL,
	`attack` integer DEFAULT 15 NOT NULL,
	`defense` integer DEFAULT 6 NOT NULL,
	`current_zone_id` text,
	`battle_id` text
);
