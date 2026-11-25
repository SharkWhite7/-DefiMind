CREATE TABLE `price_samples` (
	`chain` text NOT NULL,
	`mint` text NOT NULL,
	`at` text NOT NULL,
	`price_usd` text NOT NULL,
	PRIMARY KEY(`chain`, `mint`, `at`)
);
--> statement-breakpoint
CREATE TABLE `trader_ticks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`started_at` text NOT NULL,
	`day` text NOT NULL,
	`model` text NOT NULL,
	`outcome` text NOT NULL,
	`actions` text NOT NULL,
	`reason` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write` integer NOT NULL,
	`detail` text,
	`running` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trader_ticks_agent` ON `trader_ticks` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `traders` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`paused_by` text,
	`streak_kind` text,
	`streak` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
