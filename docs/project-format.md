# The `.tunestudio` project format

A Tune Studio project is one file, `<name>.tunestudio`. It holds everything needed to edit a song
and to export it again as a regular UltraStar song folder: the chart, the song's details, its media
(audio, stems, cover, background, optionally video), analysis results and editor state. UltraStar
files are an export target; the project is the source of truth.

## Container

- A SQLite 3 database, opened in the main process through `@effect/sql-sqlite-node` (Node's
  built-in `node:sqlite`, no native module). Tables, queries and migrations use Drizzle 1.
- `PRAGMA application_id = 0x54535444` ("TSTD") marks the file as a Tune Studio project. A file
  without it is refused, never modified.
- `PRAGMA journal_mode = DELETE` and `synchronous = FULL`: while open, the project is still one
  file (WAL would add `-wal` and `-shm` files next to it), and a crash mid-write rolls back.
- Changes are written in transactions as they happen. There is no separate "save" that rewrites
  the file; media written once is never touched again, so saving a large project stays instant.

## Versioning

- `meta.format_version` is the schema version, one per Drizzle migration set shipped with the app.
- Opening a file with an older version migrates it forward inside one transaction. A file whose
  version is newer than the app supports is refused with "made with a newer Tune Studio", and
  never written to.
- `meta` also records the app version that created and last wrote the file.

## Tables

All times are seconds as `REAL`, absolute in the main audio (GAP included), as in the editor's
model. Exporting quantizes them to the chart's BPM grid. Pitches are MIDI note numbers
(UltraStar pitch + 60).

| Table          | Contents                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`         | `key` → `value` text: `format_version`, `project_id` (UUID), `created_at`, `updated_at`, `created_with`, `saved_with`                                                                                                                                  |
| `song`         | One row: title, artist, language (JSON list), year, genre, edition, creator, BPM, GAP, video gap, start, end, preview start, medley start/end, and `extra_headers` (JSON, every UltraStar header we don't model, kept in order)                        |
| `singers`      | Duet voices: `id`, `index` (1, 2), `name` (from `#P1`/`#P2`)                                                                                                                                                                                           |
| `lines`        | `id`, `singer_id`, `position`, `switch_start`, `switch_end` (when the next line appears; both null = automatic)                                                                                                                                        |
| `notes`        | `id`, `line_id`, `position`, `start`, `duration`, `pitch`, `lyric` (exact, spaces kept), `type` (normal, golden, freestyle, rap, golden-rap), `edited` (changed by hand since import or generation)                                                    |
| `media`        | `id`, `role` (audio, vocals, instrumental, video, cover, background), `file_name` (original name), `mime`, `size`, `sha256`, `duration`, `source` (imported, youtube, generated), `created_at`                                                         |
| `media_chunks` | `media_id`, `index`, `data` (`BLOB`, 1 MiB each). Media is stored byte-for-byte as imported, never re-encoded                                                                                                                                          |
| `analysis`     | `id`, `kind` (pitch, alignment, words, lyrics, beats), `input_media_id`, `input_sha256`, `producer`, `producer_version`, `params` (JSON), `created_at`, `encoding` (json, f32), `data` (`BLOB`). Stale when `input_sha256` no longer matches the media |
| `editor_state` | `key` → JSON: view, zoom, selected source, panels                                                                                                                                                                                                      |

Encoded values (JSON columns, analysis payloads) are described by Effect Schemas next to the
Drizzle tables and decoded on read; a value that doesn't decode is a typed error, not a crash.

## Importing an UltraStar song

From a song folder or its `.txt`:

1. Decode the chart: BOM, `#ENCODING`, UTF-8, and the Windows-1252 fallback for undeclared legacy
   charts. Unsupported or conflicting declarations fail with a clear message.
2. Parse it: headers, notes, line breaks, duets (`P1`/`P2`). Relative-timing charts and ambiguous
   singer records fail explicitly. Unknown headers go to `extra_headers`.
3. Copy the media the chart references (`#AUDIO`/`#MP3`, `#VOCALS`, `#INSTRUMENTAL`, `#COVER`,
   `#BACKGROUND`, and `#VIDEO` when "Include video" is on) from the song folder into `media`.
   Only files inside that folder are read. A referenced file that is missing is a warning,
   except the main audio, which is required.
4. Ask where to save the project (default `~/Music/Tune Studio/<Artist> - <Title>.tunestudio`),
   write it, add it to recents and open it.

The original folder is only read, never changed.

## Exporting an UltraStar song

Writes `<Artist> - <Title>/` into a folder the user picks:

- `<Artist> - <Title>.txt`, UTF-8, `#VERSION:1.2.0`, all modelled headers plus `extra_headers`,
  integer-beat notes on the chart's BPM grid, duets as `P1`/`P2`.
- The media, byte-for-byte as stored, with their headers pointing at them: the audio as
  `<Artist> - <Title>.<ext>` (`#AUDIO` and `#MP3`), `[VOC]` / `[INSTR]` stems (`#VOCALS`,
  `#INSTRUMENTAL`), `[CO]` cover, `[BG]` background, video as `<Artist> - <Title>.<ext>`.
- An existing export folder is only replaced after confirmation; files are written to a
  temporary sibling and moved into place, so a failed export leaves the old one intact.

Converting media to another format is never part of exporting; it is a separate action the user
asks for.

## Recents

The app keeps a list of recently opened project files in its data directory (JSON, an Effect
Schema): path, last opened, and the title, artist and a small cover thumbnail cached at open, so
the start screen shows projects without opening each file. A path that no longer exists is
dropped when the list is shown.
