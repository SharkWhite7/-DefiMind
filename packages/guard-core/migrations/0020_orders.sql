CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`chain` text NOT NULL,
	`token` text NOT NULL,
	`kind` text NOT NULL,
	`amount` text NOT NULL,
	`trigger_out` text NOT NULL,
	`max_slippage_bps` integer NOT NULL,
	`created_by` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`filled_intent_id` text,
	`fail_reason` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `orders_status` ON `orders` (`status`);--> statement-breakpoint
CREATE INDEX `orders_agent` ON `orders` (`agent_id`);