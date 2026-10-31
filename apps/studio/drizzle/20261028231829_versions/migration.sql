CREATE TABLE `versions` (
	`id` integer PRIMARY KEY,
	`created_at` text NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`notes` integer NOT NULL,
	`lines` integer NOT NULL,
	`data` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `versions_kind` ON `versions` (`kind`,`created_at`);