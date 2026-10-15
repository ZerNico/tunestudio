# Studio: Agent Guide

## Package Identity

- **`@tunestudio/studio`**: the Tune Studio desktop app ("Tune Studio", `org.tuneperfect.studio`)
- **Renderer**: Solid 2, TanStack Router, base-ui-solid + shadcn-style components, Tailwind CSS v4
- **Main process**: Electron (`electron/`), talks to the renderer over a typed oRPC contract on a MessagePort

## Setup & Run

```bash
bun run dev              # Vite (:1430, strict) + main process in watch mode + Electron; restarts on main changes
bun run dev:vite         # renderer only, in a browser (no preload: platform reads as "browser")
bun run build            # vite build (dist/) + main/preload bundle (dist-electron/)
bun run start            # run the production build in Electron (renderer on app://tunestudio)
bun run package:dir      # build + unpacked app in release/ (ad-hoc signed on macOS)
bun run package          # build + installer for this OS (dmg / nsis / AppImage)
bun run typecheck        # route tree, main process, e2e, renderer
bun run test             # Vitest: unit + ui + electron projects (no build needed)
bun run test:watch       # Vitest in watch mode
bun run test:e2e         # Playwright end-to-end tests against the build (run `build` first; root turbo does)
bun run native:build     # the Rust addon (needs a Rust toolchain); once before `dev`, again after native/ changes
bun run native:test      # the addon's Rust tests (STFT round trip, chunk stitching)
bun run native:build:release  # optimized; `build` runs this
bun run shots            # screenshots of every start-screen state to ../../.local/shots/prod (build first)
node e2e/shots.ts dev    # the same against the dev server (starts Vite itself)
```

## Patterns & Conventions

### File organization

```
src/
├── routes/               # TanStack file routes: only `Route`, loaders, search validation
├── screens/              # The UI for each route, same path as its route file (default export)
├── components/
│   ├── ui/               # shadcn-style primitives on base-ui-solid (button, dialog, select, toast, ...)
│   ├── home/             # Start screen parts (start options, recent projects, flow dialogs, drop overlay)
│   ├── brand-mark.tsx    # The Tune Studio mark
│   └── title-bar.tsx     # App-drawn title bar (the window has no native one)
├── lib/
│   ├── native/           # oRPC contract, MessagePort channel name, typed client
│   ├── recent-projects/  # Recent projects loader; fixtures.ts is PLACEHOLDER data
│   ├── desktop.ts        # platform + version, provided synchronously by the preload
│   ├── import-files.ts   # Classifies picked/dropped files and folders (names only, nothing is read)
│   ├── youtube.ts        # YouTube link parsing
│   ├── format.ts         # Relative times, dates, file sizes
│   └── utils.ts          # cn() and stateClass() for Base UI class props
├── routeTree.gen.ts      # Generated route tree (committed; never edit)
├── styles.css            # Theme tokens (shadcn names mapped to the studio palette) + Tailwind setup
└── icons.d.ts            # Types for ~icons/* (Solid 2 compatible)
electron/
├── main.ts               # App lifecycle, window, permissions, navigation rules
├── preload.ts            # Hands the renderer's MessagePort to main; exposes platform + version
├── protocols/            # app:// scheme serving dist/ with the CSP; originOf()
├── rpc/                  # Contract implementation (procedures.ts) and the MessagePort listener
├── csp.ts                # Content Security Policy (also applied to the dev server's pages)
├── dev-reload.ts         # Dev-only: reload windows when only the preload was rebuilt
├── identity.ts           # Product name, app ID, window background
├── window-state.ts       # Window size/position across launches
├── logger.ts             # Log file in Electron's logs dir (renderer warnings/errors land here too)
└── menu.ts               # Application menu and the text-field context menu
scripts/                  # dev loop, main-process bundling, packaging, start, shared icons plugin
tests/                    # Vitest setup (setup.ui.ts)
e2e/                      # Playwright tests (*.spec.ts), launch helper, screenshot script
components.json           # shadcn CLI config (base-nova style, `~` aliases)
resources/icons/          # App icon (icon.svg is the source of icon.png)
```

### Solid 2

- ✅ Props through `props.x`; split with `omit(props, ...)`; never destructure props
- ✅ Lifecycle with `onSettled(() => { ...; return cleanup })`; event listeners on `window` go there
- ✅ Signals are written in event handlers or `onSettled`, never in a component body or memo
- ✅ `<For>` (keyed by default: item is a value, index an accessor); `<Show>`/`<Match>` function children get accessors
- ❌ `solid-js/web`, `splitProps`, `mergeProps`, `onMount`, `classList`, `Suspense` (that's Solid 1)

### Components

- Primitives in `src/components/ui` are shadcn's Base UI variants ported to base-ui-solid and restyled for the
  studio. Base UI `class` props may be functions of state: merge with `class={(state) => cn(base, stateClass(props.class, state))}`
- Call sites only add layout classes (`shadcn/no-restyle`). Need a different look? Add a variant to the component
- Colours come from tokens in `styles.css` (`bg-card`, `text-muted-foreground`, `border-primary-line`, the
  generated `sage-*`/`lime-*` scale); raw colours fail lint
- Adding a shadcn component: `bunx shadcn@latest add <name>` (configured by `components.json`) writes the React Base
  UI variant. Port it before use: `@base-ui/react` → `base-ui-solid`, `className` → `class` (with `stateClass` for
  state functions), `omit` instead of destructuring/`splitProps`, React types and hooks → Solid 2, and the
  `lucide-react` imports → `~icons/lucide/*`
- Icons: `import SearchIcon from "~icons/lucide/search"`. Vite moves Lucide's stroke width onto the `<svg>`
  (1.75, overridable with `stroke-width`) and sizes icons 18px unless a class sets `size-*`

### Routing

- Route files stay thin (`Route`, loader, `validateSearch`); the screen lives in `src/screens/<same path>.tsx` and
  reads route data with `getRouteApi("/path")`, never by importing the route file (keeps HMR working with
  `autoCodeSplitting`)
- `src/routeTree.gen.ts` is generated by the router plugin (or `tsr generate`, which `typecheck` runs) and committed,
  so a fresh checkout type-checks. Never edit it; lint and format skip it. Commit it with route changes

### Main process

- The renderer reaches main only through `native` from `~/lib/native/client`. Adding a call: extend
  `src/lib/native/contract.ts`, implement it in `electron/rpc/procedures.ts`
- Only the app's own top-level frame on the app origin may open an RPC connection (`electron/rpc/index.ts`)
- Renderers are sandboxed with context isolation; permissions are denied except clipboard writes; the window never
  navigates away from the app origin and never opens new windows (https links go to the browser)
- Compare origins with `originOf()` (`electron/protocols/schemes.ts`), never `URL#origin`

### Effect 4

- `effect`, `@effect/platform-node` and `@effect/vitest` are pinned to the same exact version; bump them together
- Main-process work and domain logic are Effects. Services: `class X extends Context.Service<X, Shape>()("studio/X")`,
  layers from `Layer.succeed` / `Layer.effect`, use with `X.use((x) => ...)` or `yield* X`. Everything is provided once
  in `electron/runtime.ts` (`ManagedRuntime`, disposed on quit); Node's file system, path and child processes come
  from `NodeServices`, so use `FileSystem` / `Path` / `ChildProcessSpawner` instead of `node:fs` in services
- Procedures call `runRpc(runtime, effect, signal)` (`electron/rpc/base.ts`): typed failures reach the renderer as
  `BAD_REQUEST` with their message, so write that message for the user; defects stay internal; aborting a call
  interrupts its Effect
- Errors users can act on are `Schema.TaggedError` classes with a `message`; bugs are defects (`Effect.die`, thrown)
- **Effect Schema** replaces Valibot: RPC inputs (`Schema.toStandardSchemaV1(...)` in `src/lib/native/contract.ts`),
  route search params, and every format we persist
- The UI stays plain Solid: components and stores don't import `Effect`; they get promises from `native` (Schema is
  fine in the renderer for validation)
- Effect 4 differs from most Effect 3 material online: `Context.Service` (no `.Default`, no `dependencies`),
  `Effect.catch` (not `catchAll`), `Effect.forkDetach` (was `forkDaemon`), `Effect.result` captures typed failures
  only. Check `node_modules/effect/dist/*.d.ts`; its doc comments have runnable examples

### Download tools (`electron/tools/`)

- YouTube projects use **yt-dlp** (downloads), **QuickJS** (yt-dlp's JavaScript runtime for YouTube's checks;
  Electron's own Node isn't used, so the `RunAsNode` fuse stays off) and **FFmpeg + ffprobe** (conversion, merging).
  None ships with the app: `Tools.ensure` downloads them into `<userData>/tools/<tool>/<version>/` on first use
- Sources (`sources.ts`): yt-dlp and QuickJS-ng GitHub releases; FFmpeg from Martin Riedl's signed builds on macOS
  and BtbN's newest release-branch LGPL build on Windows and Linux. Every file is checked against its published
  SHA-256 (GitHub asset digests, `.sha256` files) before it is used. Zip files are unpacked by `unzip.ts` (Linux's
  GNU tar can't read them; keeps Unix modes and symlinks), tar.xz with `tar`. It treats every zip as hostile: CRC and
  size checked per entry, inflate capped, 2 GB and 50,000 entries at most, no encryption/Zip64/split zips, Windows
  device names and `:` refused. Nothing is written through a symlink (files first, links last, compared case- and
  accent-insensitively), a link may only climb with leading `..`, and each link's folder must really be where it was
  checked (`realpath`: macOS and Windows treat "A" and "a" as one path)
- `Downloads` (`downloads.ts`) only talks HTTPS to the allowed hosts, checking every redirect hop; files stream
  through `pipeline`, so a disk error ends the download instead of leaving it waiting. `file` takes per-download
  `limits`: its own hosts (tools, models, covers and thumbnails each keep to theirs) and a size cap (images 20 MB,
  models their pinned size)
- Settings can remove a tool (`tools.remove`, under its install lock); it is installed again when next needed.
- Updates: yt-dlp is checked daily, the others monthly (`CHECK_INTERVAL`); `ensure(..., { force: true })` checks now
  (use it when yt-dlp fails). A check that can't connect keeps the installed version; a first install offline fails
  with a message
- Tests never download: unit tests use a fake `Downloads`; e2e sets `TUNESTUDIO_OFFLINE=1`, so tool checks fail as if
  offline

### New projects (`src/components/new-project/`, `electron/drafts/`)

- A new project goes through stages (`Stage`, run by `createFlow`/`FlowView` in `flow-runner.tsx`): each has a header tag, a body, a primary button and maybe a job run on it (download, chart, save) whose progress the body shows. Back stops a running job (the stage stays), else goes back a stage; there is no Stop button. Saving can't be stopped (`stoppable: false`). A download that finishes as it is cancelled is discarded by main (`withProgress`'s `onUndelivered`). The dialog's Cancel and close stop it too. What the stages collect lives in `createNewProject()` (`new-project.ts`): details, cover, language, lyrics, the draft and the made chart. A source brings its own first stage (`youtubeSongStage`; an audio file import gets its own later) and shares Lyrics, Chart and Finish (`stages.tsx`).
- Language: chosen on the first stage ("Sung in", `LanguageSelect`) and carried through: offered from the source (YouTube's `language`, else its one `-orig` automatic captions, `videoLanguage`), else the last new project's (`settings.newProject.language`, saved by `drafts.create`), else "Don't know", which falls back to what Whisper heard or `guessLyricsLanguage`. Listening listens in it; heard or found lyrics that seem to be in another language get a warning (`languageMismatch`, with "Listen again in …" for heard ones). Codes are ISO 639-1 in the renderer and RPCs (`src/lib/languages.ts`); projects store the English name.
- Chart stage: "Make the chart now" or "Leave it empty"; **Next** makes it (`drafts.makeChart`, `makeDraftChart`: `chartFromFiles` on the draft's files with placeholder details) and keeps it in the draft with `chartInputsKey(lines, language)`. Going back and on again doesn't remake it unless the lyrics or language changed. A chart that fails says why; the user can leave it empty instead.
- Finish stage: a summary of what the project gets (Back leads to where each was chosen), and **Create project…**: save dialog, then `drafts.create` (`createDraftProject`) writes the draft into the project (the made chart with the chosen details, or an empty one; the language, lyrics, audio, vocals, instrumental, video, cover; source from the draft, the stems `generated`). `chart: "made"` must match the draft's chart key, else `ChartOutdated`. Cancelling the save dialog stays on Finish.
- Drafts (`services/drafts.ts`): a draft has its source (`DraftSource`), media and made chart, in `<data>/drafts/<id>`; a failed or cancelled download removes its draft, closing the dialog discards it (`drafts.discard`, also a draft that arrives after closing), saving removes it, and the whole folder is cleared at startup (crash leftovers; one instance only) and on quit.

### YouTube projects (`electron/youtube/`, `src/components/new-project/youtube-flow.tsx`)

- Stages Song → Lyrics → Chart → Finish. Song: download tools (silent when current) → `youtube.inspect` → artist/title (suggested by `suggestSongDetails`), language and cover → **Next**: `youtube.download` into a draft (`downloadIntoDraft`; the checklist from the settings, then the voice separation, shown on the Song stage; done once, going back keeps it) → Lyrics (`youtube.findLyrics`, editable) → Chart → Finish (see New projects). Media source `youtube`, `imported_from` is the watch URL. Every stage waits visibly. LRCLIB or Whisper, never both.
- Main only takes an 11-character video ID and builds the URL itself; the URL goes after `--`. yt-dlp runs with `--ignore-config`, `--no-js-runtimes --js-runtimes quickjs:<ours>` and our FFmpeg, never anything from PATH.
- Videos over 20 minutes (`LONGEST_SONG_SECONDS`) are refused at the song step, and again before separation.
- Format choices follow USDB Syncer (`videoFormat`, `audioFormat`); every codec choice keeps the resolution and frame-rate limits (`<=?` lets formats without that information through), and only when nothing fits does the best of the rest come. M4A/Opus are saved as served; MP3/OGG converted. Normalization: two-pass EBU loudnorm to -18 LUFS (-23 for Opus); "replaygain" writes tags by remuxing, "rewrite" encodes once.
- A failure that isn't about the video forces a yt-dlp update check and retries once with a newer version; the video download gets its own update-and-retry. A video that still can't be downloaded keeps the audio and adds an import warning.
- yt-dlp is installed from its "onedir" zips (starts in 0.2 s; the single-file builds unpack themselves for 6 to 13 s per run) and run once after installing so macOS's first-run check doesn't land on the first lookup.
- The cover picker starts on the video thumbnail and stays there; found covers appear in front of it (a spinner tile while searching) and are only chosen by clicking. Year and genre come from the best confident match whatever the cover. Next doesn't wait for the search.
- Covers come only from the cover hosts when saving (`downloadCover` checks the renderer's URL against `COVER_HOSTS`). A release found in several catalogs falls back to the next one whose preview loads. `isVariant` works both ways ("Song (Live)" isn't the studio recording either); lyrics prefer the exact title over one that only contains it.
- Covers (`covers.ts`): iTunes (the user's store, `Desktop.country`), Deezer (songs, plus singles/EPs from its album search) and MusicBrainz + Cover Art Archive (singles via release-group search, then recordings with their album; one shared queue keeps MusicBrainz at one request a second). Scored by artist, title and length (`scoreMatch`): the song's own single first, other versions (`isVariant`, `isVariantAlbum`) and compilations lower, another artist or another song never. Only a `confident` match lends year and genre. Previews are data URLs fetched by main (the renderer's CSP blocks remote images). The picker also offers the video thumbnail (square crop), the user's own JPEG/PNG (`dialogs.chooseCoverImage`) and no cover.
- Lyrics (`lyrics.ts`): LRCLIB search by artist and title; `pickLyrics` prefers the requested version, with studio lyrics for the same song as a fallback. When a live/acoustic lookup has no matching version, a second search omits the recording label. Within each version, synced lyrics come first, then closest in length. A fallback carries `versionMismatch` and the dialog warns that words and timing may differ, even if the durations match. LRCLIB can be down for a while: one retry, then `LyricsUnavailable` and a "Try again" in the dialog; creating stays possible. The Lyrics step switches between sources ("Found online", "Heard in the song", "Your own"), with one line saying what the chosen lyrics are and the text below. Editing found lyrics copies them into "Your own" (stored without LRCLIB's timing, `source: "user"`); the found ones stay one click away. Stored as `analysis` kind `lyrics` on the main audio (`project/lyrics.ts`); the aligner times the text from the audio, LRCLIB's line times are only a cross-check.
- YouTube sometimes refuses a download link it just handed out (HTTP 403); `fetchStream` starts the yt-dlp run over (a fresh link) up to two more times.
- Download hosts are an allowlist (`TOOL_HOSTS`, `THUMBNAIL_HOSTS`, `COVER_HOSTS`, `LYRICS_HOSTS`, `MODEL_HOSTS`); an entry starting with a dot allows subdomains.
- Tests use fake `yt-dlp`/`ffmpeg` scripts (`youtube.test.ts`); `launchStudio({ online: true })` is for manual screenshot runs only.

### Native addon, models and voice separation (`native/`, `electron/native/`, `electron/models/`, `electron/separation/`)

- `native/` is a Rust napi-rs addon: `separateVocals` (Mel-Band RoFormer through ONNX Runtime, the `ort` crate) and `transcribe` (whisper.cpp through whisper-rs). `bun run native:build` (`scripts/native.ts`) builds it with napi, writes the generated `index.cjs`/`index.d.ts` (types come from `#[napi(object)]`; don't edit them) and copies the GPU libraries ONNX Runtime loads from `target/<this machine's triple>/` next to the `.node`, failing when one is missing: `libwebgpu_dawn` (Apple Silicon, x64 Linux), `webgpu_dawn.dll` + `dxcompiler.dll` (x64 Windows), `DirectML.dll` (Windows on ARM). It refuses Intel Macs. ONNX Runtime's Windows builds also link the system's DirectML. Release builds compile whisper.cpp with `GGML_NATIVE=OFF` (x64 needs AVX2/FMA, ARM the base set) so they run on other machines' processors; that only applies when whisper-rs-sys is rebuilt (`cargo clean -p whisper-rs-sys --release`). `bun run package` refuses another architecture than the machine's (the addon is built for it). Packaged, all of it goes to `resources/native` (outside the archive); `Native` (`electron/native/native.ts`) loads it on first use.
- Separation runs on the GPU where ort ships a runtime for it (`cfg(gpu)` from `build.rs`, features in `Cargo.toml`): WebGPU (Metal, Direct3D 12, Vulkan) on Apple Silicon and x64 Windows/Linux, DirectML on Windows on ARM, none on Linux on ARM. Intel Macs aren't supported: ort has no runtime for them. It falls back to the CPU when the GPU fails (`Stems.device` says which, `gpuProblem` why; logged). Not Core ML: ONNX Runtime's Core ML backend can't run this model (shape error, or 100+ partitions and minutes per song). `ort` picks Core ML on macOS by default even for "CPU only" sessions, so the CPU path sets `AutoDevicePolicy::PreferCPU` (pykeio/ort#662). `build.rs` links clang's runtime on macOS: ONNX Runtime's `@available` checks need it and a Node addon would otherwise call a null pointer at startup.
- The STFT/iSTFT and chunking (8 s chunks every 6 s, 0.8 s crossfades, `stitch`) are ours in Rust, with tests (`bun run native:test`); the ONNX graph is only the network. Output matches the PyTorch reference (checked against a Python ONNX Runtime run); a 3-minute song takes about 40 s on an M5 Pro GPU, 3 minutes on its CPU.
- Models (`models.ts`) are downloaded on first use from Hugging Face at a pinned revision, checked against their SHA-256 and size, into `<data>/models`: `mel-roformer.fp16.onnx` (audiojs export of Kimberley Jensen's vocals model, MIT, 464 MB) and `ggml-large-v3-turbo-q5_0.bin` (574 MB). `models.status` tells the dialog whether the download is part of the checklist. `installed.json` records each download's checksum and date, so a model only counts when it is the version this app pins (same size isn't enough: an update with a new pin downloads again); files from before the record are checked once by checksum and adopted with their file date. Each `ModelSource` has its `version` (release tag or pinned revision), `credit` and `license`. Settings lists them by feature (`models.list`/`download`/`remove`, `features.ts`; feature names in `src/lib/models.ts`) with versions, licenses and the download date, each downloadable ahead of time or removable to free the space; there is no update check (pins change with the app); sizes shown are binary like every file size in the app (547 MB for Whisper).
- `separateStems` (`separation.ts`) decodes the song to raw 44.1 kHz float samples with our FFmpeg and separates the vocals; the instrumental is the song minus the vocals (no second model run). Both are encoded in the audio format, at the song's own bitrate but no more than the setting, and saved as `[VOC]` and `[INSTR]` (source `generated`).
- Listening (`listening/`): "Heard in the song" in the Lyrics stage (`drafts.listen`), picked when LRCLIB has nothing but only started by its "Listen to the song" button, in the song's language; Next waits while it runs. Whisper hears the separated vocals (16 kHz mono), only where something is sung (`voicedRanges`: loudness against the song's loud parts, breaths kept inside a line, stretches under 1 s dropped, nearby lines grouped up to 28 s). The addon votes on the language over the six longest stretches; "Several languages" (`mixed`) detects it per stretch (own language from 50% sure). `lyricsLines` drops what Whisper makes up (captions, low confidence, a word stretched over seconds) and splits run-on sentences at commas into lines of about 40 characters. Stored as lyrics with producer `whisper` and the language in the params. About 10 to 17 s per song on an M5 Pro. Language detection itself can't be interrupted (whisper.cpp has no abort there); cancelling takes effect after it, a few seconds at most.
- Memory inside Electron: Chromium's allocator replaces malloc in the main process and aborts the app (SIGTRAP, no log line) when an allocation can't be had, where plain Node would fail the run. ONNX Runtime's CPU arena grows in large aligned blocks and crashed the app on Beat This! (fine under Node). CPU sessions therefore run without the arena and memory pattern (`runtime.rs`), which also cut Beat This!'s peak from 1.6 GB to 0.4 GB. Native tests run under Node and don't catch this: check a new model inside Electron (`ELECTRON_RUN_AS_NODE=1 <electron> script.cjs` loading the addon) before relying on it.
- Progress to the renderer is throttled at the source (`Downloads.file` reports at most every 100 ms): one message per network chunk kept the renderer too busy to repaint while models downloaded.
- Tests use `fakeNative` and `fakeModels` (`electron/testing.ts`); the real addon only runs in manual checks.

### The editor (`src/screens/project.$id.tsx`, `src/components/editor/`, `src/lib/editor/`)

- An open project is the editor (read-only so far; the plan is editing, then lines and lyrics, then the sung-pitch trace). The route loads `project.overview` and `project.chart` (`readEditorChart`: singers, lines and notes with their row ids, plus #BPM/#GAP).
- Layout: overview bar (every line, the view window; drag to scroll), time ruler (click to seek), piano roll, lyrics lane, transport. Everything else (cover, chart stats and Make the chart, details, media, lyrics, import notes) is the Song panel, opened from the title bar; it opens by itself when the chart is empty.
- `view.ts` holds the maths (time↔px, zoom at a point, clamping, ruler steps, pitch rows, `visibleItems`): only notes and lines in view are rendered. The pitch range is the whole chart's (±3, at least 18 rows), so rows don't jump while scrolling.
- Playback (`playback.ts`): one `Audio` per source (song, vocals, music) on the project's `media://` URLs; switching keeps position and play state; the time is read every animation frame while playing, and the view follows page by page unless the user scrolled away. Pausing puts the element back to the position read just before it: Chromium moves `currentTime` on to the end of what was already sent to the device when pausing, so resuming would skip ahead (worst on Bluetooth).
- Playhead (`playhead.tsx`): one lime line over the ruler, break strip, roll and lyrics lane, with a head in the ruler to drag; pressing or dragging along the ruler scrubs too. The view zooms out no further than the whole song. Line breaks are dashed markers at their switch times (fainter for the default timing, `lineBreaks`), with handles in the strip above the roll; no line shading.
- Grid: notes stay in seconds; the export grid step is 15 / #BPM seconds from #GAP; edits will snap to it, with no snap-off (the file can only hold grid steps). Tempo changes are left to the even grid, like every UltraStar editor; the detected beats can be drawn as an overlay later.
- Keys (not while typing or in a dialog): Space play/pause, `,` / `.` previous/next line, F fits the current line; Cmd/Ctrl+wheel or pinch zooms at the pointer, wheel and Shift+wheel scroll time.

### Making the chart (`electron/charting/`, `native/src/{aligner,pitch,beats,ctc,game,numpy_rng,harmonics,refiners,runtime}.rs`)

- "Make the chart" in the project's Chart panel (`MakeChart`, `project.makeChart`): the project's vocals, song and lyrics through the auto-tuner PoC's chart pipeline (its defaults: aligner fine-tuned on singing, syllable-start head, GAME notes, pitch corrector, learned note ends), replacing the project's singers, lines and notes and its BPM/GAP in one transaction (`replaceChart`), after asking when there are notes. Needs the lyrics and the `[VOC]` stem; English and German only so far (`chartLanguage`).
- It is a port, checked against the PoC: every function reproduces the PoC's output (NumPy's arithmetic included: `numpy.ts` has pairwise sums, round-half-even, floor modulo, float32 statistics; never `Math.round` or `%` there). `pipeline.ts` runs the stages in the PoC's order; the models sit behind `ChartEngines`. Charts are written on the PoC's rounded headers (#BPM to 3 decimals, #GAP in ms), so an export writes the PoC's beats.
- Native: CPU only for now. The aligner runs in ctc-forced-aligner's 30 s windows (one pass gives the CTC log-probabilities and the head's hidden states); the CTC Viterbi (`ctc.rs`) is ctc-forced-aligner's (BSD 2-Clause) in f32 with its tie-breaks; GAME's segmenter gets its random op replaced by an input on the protobuf (`patch_segmenter`) fed from NumPy's PCG64 (`numpy_rng.rs`), seeded per line like the PoC; Beat This! chunks like its own inference, peaks are picked in `beats.ts`.
- Text: `aligner-text.ts` is ctc-forced-aligner's `preprocess_text` (normalization and uroman) from generated tables (`data/aligner-text.json`, Latin, Hangul and Chinese characters, which romanize character by character). Syllables: the learned tables `data/syllables-{english,german}.json` plus rules. The generated files come from the PoC's `scripts/export_text_tables.py` / `export_fixtures.py`; don't edit them.
- Models: one `ensureAll(CHART_MODELS)` download (1.6 GB as the app counts, binary units): our aligner and note refiners and ONNX exports of FCPE and Beat This! from Hugging Face (`tuneperfect/*`, pinned revisions), and GAME as openvpi's v1.0.3 release zip from GitHub, unpacked with `unzip` and checked file by file (`unpack`).
- Tests: synthetic ones and committed fixtures (words, never song lyrics) run everywhere; the PoC's recorded calls on real songs (`goldens.ts`) run when `TUNESTUDIO_CHART_GOLDENS` points at the PoC's `out/golden`, the native ones (`native.test.ts`) also need `TUNESTUDIO_CHART_MODELS` (the PoC's `out/export`), `TUNESTUDIO_CHART_GAME` and a built addon.

### Settings (`src/lib/settings.ts`, `electron/services/settings.ts`, `/settings`)

- One schema shared by renderer and main; `settingsFrom` keeps every still-valid stored value and defaults the rest, so adding or dropping an option never resets the others. Stored as `<data>/settings.json` (`{ version: 1, settings }`).
- `newProject` isn't on the settings screen: it remembers the last new project's language, written only by main (`remember`, from `drafts.create`); `settings.set` keeps the stored one, since the screen's copy may be old.
- The settings screen saves each change right away (`settings.set` with the whole object); there is no Save button. Reached from the rail's bottom item; Home and Recent go back to `/` (Recent via `#recent`).
- YouTube download options follow USDB Syncer (defaults: M4A 256 kbps, no normalization; MP4 best codec, 1080p, 60 fps). No FLAC: YouTube audio is lossy. M4A and Opus are saved as served; the bitrate applies only when audio is converted or normalized. They shape new downloads only; media already in a project is never converted.

### Start screen (step 1)

- `/` is the start screen. `?recents=empty` shows the first-launch state
- Recent projects are **placeholder fixtures** (`src/lib/recent-projects/fixtures.ts`), loaded by the route loader
- Start options open stub dialogs (`components/home/flow-dialogs.tsx`) that end in a "Not implemented yet" note;
  project menu actions show toasts. Removing from recents works in memory, with undo
- Shortcuts only where they clearly help (the editor's are listed under The editor). Projects take Enter, Shift+F10 / menu key and Delete
- No "coming soon" placeholders: show only what exists

### Dev loop (`bun run dev`)

- Renderer edits hot-update through Vite with Solid's refresh (built into the Solid Vite plugin, dev only): a
  component edit keeps the page and other components' state; CSS and token edits apply in place
- `electron/` is bundled by esbuild in watch mode. If the main bundle changed, Electron restarts (the window's
  position and size are saved on close and restored); if only the preload changed, the windows reload instead
- If Vite doesn't answer within 30 s, or exits (e.g. port 1430 taken), the loop stops with a message and exit
  code 1. Closing the app or Ctrl+C stops Vite, esbuild and Electron
- `bun run dev -- -- --remote-debugging-port=9333` (from the root) passes flags on to Electron

### Testing

- Vitest projects are by extension: `unit` = `src/**/*.test.ts` (node), `ui` = `src/**/*.test.tsx` (jsdom, Solid's
  browser dev build without HMR wrappers, `tests/setup.ui.ts`), `electron` = `electron/**/*.test.ts` (node).
  `bunx vitest run --project ui` runs one. A `.test.tsx` under `--project unit` prints "No test files found" and exits
  green: that is not a pass
- Smallest proof first (`bunx vitest run src/lib/youtube.test.ts`), then `bun run test`, then `bun run test:e2e`
- Component tests render with `@solidjs/testing-library` (the Solid 2 beta), query by role and accessible name, and
  drive the UI with `@testing-library/user-event`. Don't mock the unit under test; Node tests of main-process code
  mock only `electron` itself
- Logic worth testing lives in plain modules (`src/lib`, `electron/csp.ts`) so the `unit`/`electron` projects can
  cover it without a DOM; a test that needs a timeout or sleep to pass is wrong
- Effects are tested with `@effect/vitest` (`it.effect`), providing test layers for services
  (`Layer.succeed(AppLog, ...)`) instead of mocking; see `electron/rpc/procedures.test.ts`
- Playwright e2e (`e2e/*.spec.ts`) drives the built Electron app; keep it to smoke flows that need the real shell
- E2e and `bun run shots` launch the app with `TUNESTUDIO_BACKGROUND=1`: the window is never shown and never takes
  focus (no Dock icon), pages still render for screenshots. `TUNESTUDIO_E2E_SHOW=1` shows it when debugging. Take
  screenshots only when a visual check is actually needed

## Known base-ui-solid Issues (0.2.0)

Repros live in `.repro/` (gitignored): run `bunx vite`, open `http://localhost:1430/.repro/<name>.html`, or run
`node .repro/run.mjs` with the dev server up.

- **Menu.Trigger crashes in development** (`menu-trigger`): opening a `Menu` through `Menu.Trigger` throws
  PRIMITIVE_IN_EFFECT_CALLBACK (`MenuTrigger.jsx` calls `createRoot` inside a `useIsoLayoutEffect` callback to
  insert focus guards) and halts Solid's reactivity. Production builds work. `DropdownMenu` is ported but unused
  until this is fixed; project actions use `ContextMenu`, which is unaffected
- **Modal Dialog focus doesn't wrap** (`focus-guard`): Tab from the last tabbable lands on a focus guard instead of
  the first tabbable. `ui/dialog.tsx` keeps the spike's temporary `wrapFocus` workaround
- **Dev reactivity diagnostics** (`tooltip`, `dialog`, `menu`): Tooltip, Dialog and Menu stores log
  EFFECT_RELAY_TEAR (and Tooltip inside a ToggleGroup EFFECT_WRITES_OWN_SOURCE) warnings in development, from
  `useSyncedValues` relaying props into the store from an effect. The Menu one appears when a recent project's
  `ContextMenu` opens (`MenuRootInternal`'s `useIsoLayoutEffect` deps re-run for one write of the store's `track`).
  Harmless for behaviour; `bun run shots` in dev mode prints them

## Common Gotchas

- Terminals inside Electron-based editors may export `ELECTRON_RUN_AS_NODE=1`; the scripts strip it, clear it when
  running Electron by hand
- Playwright's Electron driver doesn't connect when run by Bun: `e2e/shots.ts` runs under Node (`bun run shots`
  does that), tests under `playwright test`
- Development data lives in `Tune Studio Dev` (userData/logs), releases in `Tune Studio`; `TUNESTUDIO_DATA_DIR`
  moves it (tests use a temp dir, so they never collide with a running copy)
- Electron downloads its binary on first `require("electron")`, not on install

## Pre-PR Checks

```bash
bun run lint && bun run format:check && bun run typecheck && bun run test && bun run test:e2e
```
