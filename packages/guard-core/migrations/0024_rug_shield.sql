CREATE TABLE `shield_baselines` (
	`agent_id` text NOT NULL,
	`chain` text NOT NULL,
	`token` text NOT NULL,
	`freeze_authority` integer NOT NULL,
	`mint_authority` integer NOT NULL,
	`extensions` text NOT NULL,
	`supply` text NOT NULL,
	`taken_at` text NOT NULL,
	PRIMARY KEY(`agent_id`, `chain`, `token`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
