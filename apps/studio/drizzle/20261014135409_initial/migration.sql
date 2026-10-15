CREATE TABLE `analysis` (
	`id` integer PRIMARY KEY,
	`kind` text NOT NULL,
	`input_media_id` integer,
	`input_sha256` text NOT NULL,
	`producer` text NOT NULL,
	`producer_version` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`encoding` text NOT NULL,
	`data` blob NOT NULL,
	CONSTRAINT `fk_analysis_input_media_id_media_id_fk` FOREIGN KEY (`input_media_id`) REFERENCES `media`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `editor_state` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lines` (
	`id` integer PRIMARY KEY,
	`singer_id` integer NOT NULL,
	`position` integer NOT NULL,
	`switch_start` real,
	`switch_end` real,
	CONSTRAINT `fk_lines_singer_id_singers_id_fk` FOREIGN KEY (`singer_id`) REFERENCES `singers`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` integer PRIMARY KEY,
	`role` text NOT NULL,
	`file_name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`duration` real,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media_chunks` (
	`media_id` integer NOT NULL,
	`index` integer NOT NULL,
	`data` blob NOT NULL,
	CONSTRAINT `media_chunks_pk` PRIMARY KEY(`media_id`, `index`),
	CONSTRAINT `fk_media_chunks_media_id_media_id_fk` FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY,
	`line_id` integer NOT NULL,
	`position` integer NOT NULL,
	`start` real NOT NULL,
	`duration` real NOT NULL,
	`pitch` integer NOT NULL,
	`lyric` text NOT NULL,
	`type` text NOT NULL,
	`edited` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_notes_line_id_lines_id_fk` FOREIGN KEY (`line_id`) REFERENCES `lines`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `singers` (
	`id` integer PRIMARY KEY,
	`index` integer NOT NULL,
	`name` text
);
--> statement-breakpoint
CREATE TABLE `song` (
	`id` integer PRIMARY KEY,
	`title` text NOT NULL,
	`artist` text NOT NULL,
	`language` text DEFAULT '[]' NOT NULL,
	`year` integer,
	`genre` text,
	`edition` text,
	`creator` text,
	`bpm` real NOT NULL,
	`gap` real DEFAULT 0 NOT NULL,
	`video_gap` real,
	`start` real,
	`end` real,
	`preview_start` real,
	`medley_start` real,
	`medley_end` real,
	`extra_headers` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lines_singer` ON `lines` (`singer_id`,`position`);--> statement-breakpoint
CREATE INDEX `notes_line` ON `notes` (`line_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `singers_index` ON `singers` (`index`);