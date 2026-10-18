# Studio: Agent Guide

## Package Identity

- **`@tunestudio/studio`**: the Tune Studio desktop app ("Tune Studio", `org.tuneperfect.studio`)
- **Renderer**: Solid 2, TanStack Router, base-ui-solid + shadcn-style components, Tailwind CSS v4
- **Main process**: Electron (`electron/`), talks to the renderer over Effect RPC (a schema contract) on a MessagePort

## Setup & Run

```bash
bun run dev              # Vite (:1430, strict) + main process in watch mode + Electron; restarts on main changes
bun run dev:vite         # renderer only, in a browser (no preload: platform reads as "browser")
bun run build            # vite build (dist/) + main/preload bundle (dist-electron/)
bun run start            # run the production build in Electron (renderer on app://tunestudio)
bun run package:dir      # build + unpacked app in release/ (ad-hoc signed on macOS)
bun run package          # build + installer for this OS (dmg / nsis / AppImage), checked (scripts/check-package.ts)
bun run typecheck        # route tree, main process, e2e, renderer
bun run test             # Vitest: unit + ui + electron projects (no build needed)
bun run test:watch       # Vitest in watch mode
bun run test:e2e         # Playwright end-to-end tests against the build (run `build` first; root turbo does)
bun run native:build     # the Rust addon (needs a Rust toolchain); `dev` runs this first
bun run native:test      # the addon's Rust tests (STFT round trip, chunk stitching)
bun run native:build:release  # optimized; `build` runs this
bun run shots            # screenshots of every start-screen state to ../../.local/shots/prod (build first)
node e2e/shots.ts dev    # the same against the dev server (starts Vite itself)
bun run shots:readme -- <audio>  # README screenshots in docs/images from a real chart (see e2e/readme-shots.ts)
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
│   ├── new-project/      # New-project flows (YouTube, audio file, song folder) and their shared stages
│   ├── editor/           # The editor's parts (roll, lanes, transport, dialogs)
│   ├── project/          # Export and problems menus, the replace-export dialog
│   ├── settings/         # Settings sections (Section, Row), Games, About and the open source licenses dialog
│   ├── route-error.tsx   # What a route shows when it fails (Try again, Back to start)
│   ├── brand-mark.tsx    # The Tune Studio mark
│   └── title-bar.tsx     # App-drawn title bar (the window has no native one)
├── lib/
│   ├── native/           # RPC contract and output schemas, MessagePort channel name, client, following progress
│   ├── editor/           # The editor's state and rules (document, history, edits, gestures, playback, export)
│   ├── recent-projects/  # Recent projects from main, and their search
│   ├── edit-commands.ts  # Which keys go to the editor and which to the focused control; undo/redo/clipboard commands
│   ├── desktop.ts        # platform and desktop helpers, provided synchronously by the preload
│   ├── import-files.ts   # Classifies picked/dropped files and folders (names only, nothing is read)
│   ├── steps.ts          # The progress steps main reports and the checklists list
│   ├── youtube.ts        # YouTube link parsing
│   ├── format.ts         # Relative times, dates, file sizes
│   └── utils.ts          # cn() and stateClass() for Base UI class props
├── routeTree.gen.ts      # Generated route tree (committed; never edit)
├── styles.css            # Theme tokens (shadcn names mapped to the studio palette) + Tailwind setup
└── icons.d.ts            # Types for ~icons/* (Solid 2 compatible)
electron/
├── main.ts               # App lifecycle, window, permissions, navigation rules
├── runtime.ts            # The Effect runtime with every service, built at startup and disposed on quit
├── windows.ts            # One window per project: which window shows what, where an opened file goes
├── flush.ts              # Asks a page to save what is waiting before its window closes, the app quits or it reloads
├── flush-channel.ts      # The IPC channels for that, shared with the preload
├── abortable.ts          # Native work and downloads that stop on a signal, waited for when interrupted
├── errors.ts             # Main-only errors and `mapFileError` (file system errors as user-facing ones)
├── permissions.ts        # Which web permissions the app's pages get (clipboard writes, the microphone)
├── preload.ts            # Hands the renderer's MessagePort to main; exposes platform, the app's version (an argument main passes) and Chromium's
├── chromium-licenses.ts  # Where Electron's LICENSES.chromium.html is, packaged or not
├── rpc/                  # Server, MessagePort protocol, connection listener; handlers per area in handlers/ (procedures.ts joins them)
├── protocols/            # app:// (dist/ with the CSP; originOf()) and media:// (a project's media) schemes
├── services/             # Effect services (settings, recents, drafts, path grants, desktop dialogs, app log); layer.ts wires them
├── project/              # An open project: its database, chart, media, edits, sung pitch, waveform, artwork
├── drafts/               # New projects' drafts: making their chart, listening, saving them as a project
├── youtube/              # YouTube projects: yt-dlp downloads, loudness, covers, lyrics
├── audio-file/           # New projects from an audio file
├── ultrastar/            # UltraStar song folders: import, export, USDB text and usdb_syncer's sidecar files
├── games/                # Try in game: the games, finding them, Info.plist, starting one with a song folder
├── charting/             # Making the chart (the PoC's pipeline), chart range and auto pitch
├── separation/           # Separating the voice from the song
├── listening/            # Hearing the lyrics with Whisper
├── models/               # Model downloads, and the features the settings screen lists
├── native/               # Loads the Rust addon
├── tools/                # yt-dlp, QuickJS and FFmpeg: sources, downloads, unzipping, running them
├── testing.ts            # Test helpers: temp folders, synthetic songs, a test runtime, fake addon and models
├── csp.ts                # Content Security Policy (also applied to the dev server's pages)
├── dev-reload.ts         # Dev-only: reload windows when only the preload was rebuilt
├── identity.ts           # Product name, app ID, window background
├── window-state.ts       # Window size/position across launches
├── logger.ts             # Log file in Electron's logs dir (renderer warnings/errors land here too)
└── menu.ts               # Application menu and the text-field context menu
scripts/                  # dev loop, main-process bundling, packaging, start, shared icons plugin, licenses/ (third-party notices)
tests/                    # Vitest setup (setup.ui.ts)
e2e/                      # Playwright tests (*.spec.ts), launch helper, screenshot script
components.json           # shadcn CLI config (base-nova style, `~` aliases)
resources/icons/          # App icon: icon.svg → icon.png (macOS, with Apple's margin), icon-full.svg → icon-full.png (Windows, Linux)
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
- Shared pieces: `ProgressBar` (`ui/progress-bar.tsx`, never a bare `<progress>`), `Note` (`ui/note.tsx`, a warning or error
  note in a dialog), `toastError(title, error)` (`ui/toast.tsx`: a failure toast that skips aborts, with
  `errorMessage`'s text)
- Icons: `import SearchIcon from "~icons/lucide/search"`. Vite moves Lucide's stroke width onto the `<svg>`
  (1.75, overridable with `stroke-width`) and sizes icons 18px unless a class sets `size-*`

### Routing

- Route files stay thin (`Route`, loader, `validateSearch`); the screen lives in `src/screens/<same path>.tsx` and
  reads route data with `getRouteApi("/path")`, never by importing the route file (keeps HMR working with
  `autoCodeSplitting`)
- `src/routeTree.gen.ts` is generated by the router plugin (or `tsr generate`, which `typecheck` runs) and committed,
  so a fresh checkout type-checks. Never edit it; lint and format skip it. Commit it with route changes

### Main process

- The renderer reaches main only through `native` from `~/lib/native/client`. Adding a call: add an `Rpc` to
  `NativeRpcs` in `src/lib/native/contract.ts` (`call`, `command`, `query`, or `withProgress` for a call that reports
  progress; outputs are schemas in `types.ts`) and its handler to its area's file in `electron/rpc/handlers/` (composed into `nativeHandlers` in
  `electron/rpc/procedures.ts`); a step label main reports and the renderer lists goes in `src/lib/steps.ts`.
  `native.<group>.<name>` appears by itself, named after the tag (`"project.open"`)
- Calls are Effect RPC over the MessagePort (`electron/rpc/port-protocol.ts` in main, `portProtocol` in `client.ts`),
  values encoded as for JSON (nothing is transferred: Electron's MessagePortMain only transfers ports). The facade
  keeps Effect out of components: a call returns a promise; one with progress returns a promise of an iterator that
  yields the progress and returns the result. Both take `{ signal }`; aborting interrupts the work in main and rejects
  with an AbortError (`isAbort`). Progress calls are streams of `Progress` events and one `Done` (`progressStream` in
  main); the client reads on to the end after `Done`, so a result main finished but the renderer never read goes to
  `onUndelivered` (a download is discarded)
- Dialogs belong to the calling window: handlers get it with `windowOf(client)` (the `Callers` service, by the
  connection's client id)
- Only the app's own top-level frame on the app origin may open an RPC connection (`electron/rpc/index.ts`)
- Renderers are sandboxed with context isolation; permissions are denied except clipboard writes and the microphone
  (audio only, for the requesting top-level frame of the app origin, after asking macOS; `electron/permissions.ts`); the window never
  navigates away from the app origin and never opens new windows (https links go to the browser)
- Compare origins with `originOf()` (`electron/protocols/schemes.ts`), never `URL#origin`
- Startup: `app://` is registered with `codeCache` (V8 keeps the page's compiled scripts between launches, as for
  https); the development Dock icon is set once the first window shows (none in a background run); main imports
  nothing big it doesn't need to start (the charting tables are read on first use). The packaged archive has no source
  maps

### Effect 4

- `effect`, `@effect/platform-node` and `@effect/vitest` are pinned to the same exact version; bump them together
- Main-process work and domain logic are Effects. Services: `class X extends Context.Service<X, Shape>()("studio/X")`,
  layers from `Layer.succeed` / `Layer.effect`, use with `X.use((x) => ...)` or `yield* X`. Everything is provided once
  in `electron/runtime.ts` (`ManagedRuntime`, disposed on quit); Node's file system, path and child processes come
  from `NodeServices`, so use `FileSystem` / `Path` / `ChildProcessSpawner` instead of `node:fs` in services
- Every call can fail with the user-facing errors (`UserError`, the classes in `src/lib/errors.ts`, shared with the
  renderer, which gets them as those classes): write their message for the user. A handler failing with anything
  else doesn't type-check (map file system errors with `mapFileError`). Defects (bugs, answers that don't fit
  their schema) are written to the log with their stack by the server's error reporter (`electron/rpc/server.ts`) and
  reach the renderer as a generic message (`errorMessage`)
- Errors users can act on are `Schema.TaggedError` classes with a `message`; bugs are defects (`Effect.die`, thrown)
- **Effect Schema** replaces Valibot: RPC inputs and outputs (`src/lib/native/contract.ts`, `types.ts`),
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
- Settings can remove a tool (`tools.remove`, under its install lock); it is installed again when next needed. A
  version a job is running (`runTool` keeps count, with what yt-dlp runs besides) stays until the next start. An
  update doesn't delete the old version either: at startup each tool keeps only the folder its manifest names, which
  also clears downloads a crash cut off. A release's version names its folder, so `safeVersion` refuses `..`,
  separators and a leading dot
- Every run of these tools goes through `tools/ffmpeg.ts`: `runTool`, `localInput` (FFmpeg and FFprobe read only the
  local file they are given, `-protocol_whitelist file`) and `decodeF32` (raw float samples through a scratch file
  with its own name, no more than `DECODE_SECONDS`)
- Native work and downloads that take an `AbortSignal` run through `abortable` (`electron/abortable.ts`): stopping
  them waits until they have stopped, so removing their folder or starting the next job never races them
- Updates: yt-dlp is checked daily, the others monthly (`CHECK_INTERVAL`); `ensure(..., { force: true })` checks now
  (use it when yt-dlp fails). A check that can't connect keeps the installed version; a first install offline fails
  with a message
- Tests never download: unit tests use a fake `Downloads`; e2e sets `TUNESTUDIO_OFFLINE=1`, so tool checks fail as if
  offline

### New projects (`src/components/new-project/`, `electron/drafts/`)

- A new project goes through stages (`Stage`, run by `createFlow`/`FlowView` in `flow-runner.tsx`): each has a header tag, a body, a primary button and maybe a job run on it (download, chart, save) whose progress the body shows. Back stops a running job (the stage stays), else goes back a stage; there is no Stop button. Saving can't be stopped (`stoppable: false`). A download that finishes as it is cancelled is discarded by main (`progressStream`'s `onUndelivered`). The dialog's Cancel and close stop it too. What the stages collect lives in `createNewProject()` (`new-project.ts`): details, cover, language, lyrics, the draft and the made chart. A source brings its own first stage (`youtubeSongStage`, the audio file and song folder stages) and shares Lyrics, Chart and Finish (`stages.tsx`).
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
- YouTube sometimes refuses a download link it just handed out (HTTP 403); `fetchStream` starts the yt-dlp run over (a fresh link) up to two more times. Downloads run with `--no-part --force-overwrites`, so a retry never takes a cut-off file for a finished one.
- Download hosts are an allowlist (`TOOL_HOSTS`, `THUMBNAIL_HOSTS`, `COVER_HOSTS`, `LYRICS_HOSTS`, `MODEL_HOSTS`); an entry starting with a dot allows subdomains.
- Tests use fake `yt-dlp`/`ffmpeg` scripts (`youtube.test.ts`); `launchStudio({ online: true })` is for manual screenshot runs only.

### Native addon, models and voice separation (`native/`, `electron/native/`, `electron/models/`, `electron/separation/`)

- `native/` is a Rust napi-rs addon: `separateVocals` (Mel-Band RoFormer through ONNX Runtime, the `ort` crate) and `transcribe` (whisper.cpp through whisper-rs). `bun run native:build` (`scripts/native.ts`) builds it with napi, writes the generated `index.cjs`/`index.d.ts` (types come from `#[napi(object)]`; don't edit them) and copies the GPU libraries ONNX Runtime loads from `target/<this machine's triple>/` next to the `.node`, failing when one is missing: `libwebgpu_dawn` (Apple Silicon, x64 Linux), `webgpu_dawn.dll` + `dxcompiler.dll` (x64 Windows), `DirectML.dll` (Windows on ARM). On Windows it also copies Microsoft's C++ runtime (`msvcp140*.dll`, `vcruntime140*.dll`, which the addon, Dawn and DXC link) from Visual Studio's redistributable files: Electron doesn't ship it and not every PC has it. It refuses Intel Macs. ONNX Runtime's Windows builds also link the system's DirectML. There it passes CMake's release flags (`/O2`) itself: the cmake crate drops them for MSVC, and whisper.cpp ran 12 times slower unoptimized. Release builds compile whisper.cpp with `GGML_NATIVE=OFF` (x64 needs AVX2/FMA, ARM the base set) so they run on other machines' processors; that only applies when whisper-rs-sys is rebuilt (`cargo clean -p whisper-rs-sys --release`). `bun run package` refuses another architecture than the machine's (the addon is built for it). Packaged, all of it goes to `resources/native` (outside the archive); `Native` (`electron/native/native.ts`) loads it on first use. Which libraries each system gets is `GPU_LIBRARIES` (`scripts/native-libraries.ts`); after packing, `scripts/check-package.ts` checks they, the addon and the archive's files are there (no source maps) and loads the addon with Node, failing the build otherwise. Releases are built by GitHub Actions (root `AGENTS.md`, CI and Releasing).
- Whisper runs on the GPU: Metal on macOS, Vulkan on x64 Windows and Linux (`cfg(vulkan)` from `build.rs`, whisper-rs's `vulkan` feature), the CPU elsewhere. Building it there needs the Vulkan SDK (`VULKAN_SDK`; CI installs LunarG's, `VULKAN_VERSION` in `build-app.yaml`, plus `libvulkan-dev` on Linux) and on Windows Ninja on the PATH: `scripts/native.ts` builds whisper.cpp with it, since ggml's shader generator (a CMake project of its own) finds no compiler inside a Visual Studio build. That project's test compile also lands past Windows' 260-character paths inside the checkout, so on Windows Cargo builds into `<drive>:	unestudio-target` (`CARGO_TARGET_DIR`; CI uses `<checkout>/t`). The addon doesn't link the Vulkan loader, or a PC without a GPU driver couldn't load it at all: `native/src/vulkan.rs` defines the three Vulkan functions ggml calls by name and opens the loader on first use; without one, `vkEnumerateInstanceVersion` fails and whisper.cpp stays on the CPU. `scripts/check-package.ts` fails the build when the addon links anything Vulkan (a whisper.cpp update calling another function by name would: add it to `vulkan.rs`). A GPU that can't take the model (too little memory) falls back to the CPU too (`Transcribe::start`).
- Separation runs on the GPU where ort ships a runtime for it (`cfg(gpu)` from `build.rs`, features in `Cargo.toml`): WebGPU (Metal, Direct3D 12, Vulkan) on Apple Silicon and x64 Windows/Linux, DirectML on Windows on ARM, none on Linux on ARM. Intel Macs aren't supported: ort has no runtime for them. It falls back to the CPU when the GPU fails (`Stems.device` says which, `gpuProblem` why; logged). Not Core ML: ONNX Runtime's Core ML backend can't run this model (shape error, or 100+ partitions and minutes per song). `ort` picks Core ML on macOS by default even for "CPU only" sessions, so the CPU path sets `AutoDevicePolicy::PreferCPU` (pykeio/ort#662). `build.rs` links clang's runtime on macOS: ONNX Runtime's `@available` checks need it and a Node addon would otherwise call a null pointer at startup.
- The STFT/iSTFT and chunking (8 s chunks every 6 s, 0.8 s crossfades, `stitch`) are ours in Rust, with tests (`bun run native:test`); the ONNX graph is only the network. Output matches the PyTorch reference (checked against a Python ONNX Runtime run); a 3-minute song takes about 40 s on an M5 Pro GPU, 3 minutes on its CPU.
- Models (`models.ts`) are downloaded on first use from Hugging Face at a pinned revision, checked against their SHA-256 and size, into `<data>/models`: `mel-roformer.fp16.onnx` (audiojs export of Kimberley Jensen's vocals model, MIT, 464 MB) and `ggml-large-v3-turbo-q5_0.bin` (574 MB). `models.status` tells the dialog whether the download is part of the checklist. `installed.json` records each download's checksum and date, so a model only counts when it is the version this app pins (same size isn't enough: an update with a new pin downloads again); files from before the record are checked once by checksum and adopted with their file date. Each `ModelSource` has its `version` (release tag or pinned revision), `credit` and `license`. Settings lists them by feature (`models.list`/`download`/`remove`, `features.ts`; feature names in `src/lib/models.ts`) with versions, licenses and the download date, each downloadable ahead of time or removable to free the space; there is no update check (pins change with the app); sizes shown are binary like every file size in the app (547 MB for Whisper). Downloads and unpacked zips a crash or a quit cut off (`.<file>.<id>.download`, `.unpack`) are removed at startup.
- `separateStems` (`separation.ts`) decodes the song to raw 44.1 kHz float samples with our FFmpeg and separates the vocals; the instrumental is the song minus the vocals (no second model run). Both are encoded in the audio format, at the song's own bitrate but no more than the setting, and saved as `[VOC]` and `[INSTR]` (source `generated`).
- Listening (`listening/`): "Heard in the song" in the Lyrics stage (`drafts.listen`), picked when LRCLIB has nothing but only started by its "Listen to the song" button, in the song's language; Next waits while it runs. Whisper hears the separated vocals (16 kHz mono), only where something is sung (`voicedRanges`: loudness against the song's loud parts, breaths kept inside a line, stretches under 1 s dropped, nearby lines grouped up to 28 s). The addon votes on the language over the six longest stretches; "Several languages" (`mixed`) detects it per stretch (own language from 50% sure). `lyricsLines` drops what Whisper makes up (captions, low confidence, a word stretched over seconds) and splits run-on sentences at commas into lines of about 40 characters. Stored as lyrics with producer `whisper` and the language in the params. About 10 to 17 s per song on an M5 Pro. Language detection itself can't be interrupted (whisper.cpp has no abort there); cancelling takes effect after it, a few seconds at most.
- Memory inside Electron: Chromium's allocator replaces malloc in the main process and aborts the app (SIGTRAP, no log line) when an allocation can't be had, where plain Node would fail the run. ONNX Runtime's CPU arena grows in large aligned blocks and crashed the app on Beat This! (fine under Node). CPU sessions therefore run without the arena and memory pattern (`runtime.rs`), which also cut Beat This!'s peak from 1.6 GB to 0.4 GB. Native tests run under Node and don't catch this: check a new model inside Electron (`ELECTRON_RUN_AS_NODE=1 <electron> script.cjs` loading the addon) before relying on it.
- Progress to the renderer is throttled at the source (`Downloads.file` reports at most every 100 ms): one message per network chunk kept the renderer too busy to repaint while models downloaded.
- Tests use `fakeNative` and `fakeModels` (`electron/testing.ts`); the real addon only runs in manual checks.

### The editor (`src/screens/project.$id.tsx`, `src/components/editor/`, `src/lib/editor/`)

- An open project is the editor. The route loads `project.overview` and `project.chart` (`readEditorChart`: singers, lines and notes with their row ids, plus #BPM/#GAP).
- Layout: overview bar (every line, the view window; drag to scroll), time ruler (click to seek, drag for a loop range; the song's start, end and preview markers), piano roll, lyrics lane, transport. The song's details, files, timing and lyrics are in the Song details dialog (the song's name in the title bar).
- `view.ts` holds the maths (time↔px, zoom at a point, clamping, ruler steps, pitch rows, `visibleItems`): only notes and lines in view are rendered. The pitch range is the whole chart's (a row of room, at least 18 rows), so rows don't jump while scrolling.
- Playback (`playback.ts`): one `Audio` per source (song, vocals, music) on the project's `media://` URLs; switching keeps position and play state; the time is read every animation frame while playing, and the view follows page by page unless the user scrolled away. Pausing puts the element back to the position read just before it: Chromium moves `currentTime` on to the end of what was already sent to the device when pausing, so resuming would skip ahead (worst on Bluetooth).
- Sung pitch (`electron/project/pitch.ts`, `pitch-trace.tsx`): FCPE MIDI per 10 ms, quiet frames (under -45 dB) left out, stored as `analysis` kind `pitch` on the vocals (keyed by their checksum). Chart making stores the track it followed (Make the chart in its transaction, the YouTube flow onto the vocals when the project is created). Opening a project with vocals makes sure it's there (`project.pitch`): stored ones come at once, otherwise it's worked out then, getting FFmpeg and the pitch model first if needed, behind "Opening the project…" (shown after 150 ms). A failure only toasts; the editor opens without the trace. Drawn on a canvas behind the notes (which, with the breaks, are one layer of their own over it: notes each overlapping the canvas cost tens of ms a frame); the transport's Pitch button hides it. No vocals, no trace.
- Waveform (`electron/project/waveform.ts`, `src/lib/editor/waveform.ts`, `WaveformLane` in `lanes.tsx`): the vocals' loudness (the song's without vocals) as RMS per 10 ms (`levels`), decoded with FFmpeg at 8 kHz and stored as `analysis` of kind `waveform`. Stored analyses (this and the sung pitch) go through `electron/project/analysis-store.ts` (read, write and decode a media file); rows of a replaced file are deleted with it (`putRole`, one transaction with the new file and the removal of the old, like separating again's vocals and instrumental together), and one worked out for a file replaced meanwhile isn't stored. A lane between the roll and the lyrics draws it on a canvas (`fitCanvas` in `canvas.ts`, which only remakes its bitmap when the size changes), mirrored, scaled so the loudest 2% are cut off (`loudest`, counted, not sorted) and normal singing fills it. The transport's Waveform toggle shows or hides it (on at first); without a waveform (no FFmpeg offline, an unreadable file) main returns none (a warning in its log), and there is no lane and no toggle. FFmpeg only reads local files for it (`-protocol_whitelist file`).
- Video (`video-preview.tsx`, `video-sync.ts`, `video-box.ts`): with a video and the transport's Video toggle on (off at first), it shows muted in the roll's top-right corner, dragged elsewhere where it covers notes and resized from its bottom-left corner (`followDrag`; `video-box.ts` keeps it inside the editor, also when the editor shrinks), closed with its x (`Button` variant `overlay`). It plays at the song's time plus the video offset (`#VIDEOGAP`: positive skips the video's start), at the song's speed; a small drift is made up by playing up to 10% faster or slower, a jump over a second seeks (never while a seek is under way); paused, it shows the playhead's frame; dark outside the video.
- Lyrics as text (`line-text.ts` rules, `line-text-editing.ts` the field's state, `InlineField` in `inline-field.tsx` shared with the note syllable field): a double-click on a line's text in the lyrics lane (or Edit line lyrics in the note menu) edits the line as text, words split by spaces and syllables by `-` (`~` a held note, `\-` and `\ ` a hyphen or space in a syllable). Enter or leaving the field applies it as one edit (`tryEdit`, Edit line lyrics); Esc cancels, also while the syllables are still coming; a text Enter couldn't apply stays to be fixed; another line's field opened meanwhile stays open; the field stays while the view scrolls. `applyLineText` matches words (longest common run): unchanged words are left as they are; between them, changed words take over the old words' notes (word for word when the counts match). More syllables than notes split the longest notes; fewer leave held notes, after splitting words typed whole into syllables (`lyrics.syllabify` in main with the song's language code, the charting's splitter). A note without a syllable yet (drawn) is a word of its own, shown as an empty gap, taken only by words that need it and never deleted. Words moved within the line take its notes in order; gone words lose their notes; new words with no notes are refused before anything changes. Spaces follow the line's style (or the chart's), and the line's ends keep theirs.
- Singing along (`sing-along.ts`, `voice-pitch.ts`, the transport's mic button): the microphone (echo cancellation on, so the song itself stays out) is read when a playback frame reaches a new 0.02 s value; YIN finds its pitch (80 Hz to 1050 Hz, silence and unclear stretches have none; it stops at the first clear period), placed `DELAY` (0.05 s of real time, so less at slower speeds) back, folded to the octave of the note sung on, and drawn over the notes in its own colour (`PitchTrace` kind `voice`); the roll redraws only when a value changed. Singing a stretch again replaces it; turning it off forgets it. macOS asks for the microphone with `NSMicrophoneUsageDescription` (`scripts/package.ts`; signing with the hardened runtime will also need the audio-input entitlement); main allows it after asking macOS (`askForMediaAccess`); a refusal or a missing microphone says what to do (`microphoneProblem`). Tests replace `getUserMedia` with an oscillator.
- Help (`help-dialog.tsx`, the ? button in the title bar or the ? key) lists every key, what the mouse does where nothing shows it, a legend of the roll (note types drawn with `roll-note`, break markers, the pitch traces, duet colours) and the song's timing words. The keys come from `shortcuts.ts` (`SHORTCUTS`, written with `Mod` for Cmd or Ctrl and shown per platform by `shown`), which the tooltips and the note menu read too; tools and note types bring theirs (`TOOLS`, `NOTE_FLAGS`). A new key goes into `SHORTCUTS` and a help group (`shortcutGroups`); `shortcuts.test.tsx` checks each is listed once. Holding Cmd (Ctrl elsewhere) alone for a quarter second shows each button's key just past its edge, below in the title bar and above in the bottom bar (`key-hints.ts`, `KeyHint` in `icon-button.tsx`); another key, a click, a scroll or leaving the window hides them, and they don't show while typing in a field or a dialog (`isTyping`).
- Playhead (`playhead.tsx`): one lime line over the ruler, break strip, roll and lyrics lane, with a head in the ruler to drag; pressing or dragging along the ruler scrubs too. The view zooms out no further than the whole song. Line breaks are dashed lines at their switch times (`lineBreaks`), with markers in the strip above the roll; no line shading. A break without a stored time follows the default rule (`defaultSwitch`, as YASS, Karedi and USDX place it) as notes move: its marker is an outline, and the line looks the same. Import stores none for a break exactly at its default beat (`defaultBreakTick`, which export writes for it too); dragging or adding one stores its time, and a marker's context menu has Reset timing (back to the rule) and Remove.
- Grid: notes stay in seconds; the export grid step is 15 / #BPM seconds from #GAP; edits snap to it, with no snap-off (the file can only hold grid steps). Tempo changes are left to the even grid, like every UltraStar editor; the detected beats can be drawn as an overlay later.
- Edits and undo (`src/lib/editor/document.ts`, `history.ts`, `electron/project/chart-changes.ts`): every change to the chart goes through `doc.edit(label, (tx) => …)`, or `doc.tryEdit` for one that may be refused (its build returns why before changing anything, or null). The recorder (`tx.updateNote`, `createLine`, `deleteNote`, `updateSong`, …) records each row as it was and as it becomes (`ChartChange`); reads inside the edit see its own changes; a note changed this way counts as `edited`. The edit is applied to the editor's rows at once (plain objects and a signal `commit` bumps, flushed; a store's proxies made every edit read each row slowly), pushed onto the history and saved in order through `project.applyChanges`, which checks every `before` against the file in one transaction (`ChartOutOfStep` if it disagrees) and then renumbers positions (notes by start, lines by first note). The touched notes are read in one query up front and kept up to date as the changes apply, and note and position writes are prepared once per edit (a 2,000-note edit saves in about 30 ms). Undo applies a step's changes backwards with before and after swapped, redo applies them again; both restore the selection that went with the step. Steps with the same `merge` key within a second become one (holding a nudge key). New rows get ids above every existing one, never reused in a session. If a save fails, the history is dropped, a toast says why and the chart is loaded again. The history is per session; Song details share the same history.
- Nothing waiting to be saved is lost on the way out: closing the window, quitting and reloading first ask the page to save (`electron/flush.ts`: `FLUSH_CHANNEL`, `onFlushRequest` in the preload, `setFlushHandler` in `src/lib/flush.ts`, which the editor sets to `doc.saved()`), 3 s at most per page. In main, short calls on a project run through `Projects.track` and `Projects.close` waits for them, then for a transaction in progress (a long job's last write); `project.applyChanges` can't be interrupted once started. `project.close` keeps a session another window still shows. Opening, creating and closing one file take turns. A new project can't replace a file a window shows (`notShown`). The save dialogs add the extension themselves and ask before replacing a file that name then hits (Linux's dialog doesn't).
- Undo/Redo (`src/lib/edit-commands.ts`): on macOS the Edit menu's Undo and Redo are custom items (`EDIT_COMMAND_CHANNEL`; the roles would only reach text fields, and Cmd+Z never gets to the page); Windows and Linux get Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y from the editor's keys. In a text field they undo the typing (`execCommand`), elsewhere they go to the handler the editor registered. The title bar has Undo and Redo buttons saying what they would do.
- Cut, Copy and Paste go the same way on macOS: custom Edit menu items (the roles fire nothing in the page without a text selection), the page answers on `CLIPBOARD_CHANNEL` with text for the system clipboard or "do it natively" (a text field: main runs the web contents' own cut/copy/paste). On Windows and Linux the keys come as the page's `copy`/`cut`/`paste` events (`onCopy`/`onPaste` in the editor). Notes copy as a clip (`clipboard.ts`: notes relative to the first, and the breaks between their lines) plus their lyrics as text; a paste goes in at the playhead for the active singer as one edit that keeps the line rules (`pasteNotes`: the singer's breaks plus the clip's, any inside a note moved to the nearer edge of the notes there; every note to the line it starts in; empty lines dropped; notes past the song's end cut short or left out; new lines recorded before their notes and emptied ones deleted last, so the changes apply and undo in order) and only when the system clipboard still has the clip's text. Whole lines (the copy began at a line's first note and ended at a line's last) paste as their own lines, a part of a line joins the line it lands in. Copy, cut and paste cancel a drag in progress, like undo; a refused copy reports "handled" (`false`) so nothing else copies. Electron 44's `clipboard` is asynchronous: await `readText`/`writeText` (a promise sent to the page is silently dropped).
- Auto pitch (A, the wand button next to the tools, or the note menu; on the selected notes) runs in main (`project.autoPitch`, `charting/project-auto-pitch.ts` → `auto-pitch.ts`): the chart pipeline's pitch stages with the notes' timing kept. Per singer, for the lines the notes are in plus the lines either side (context for the corrector and the octave fix; GAME only runs on lines with asked-for notes): FCPE over that stretch, GAME with the notes' spans as known boundaries (a note takes its longest voiced GAME note, else the sung median; the trace keeps the unsnapped pitch as the pipeline's does, since the corrector's features compare the note with it), snapped to the song's key (tuning and key from the stored sung pitch), then the corrector and the octave fix with the lines' other notes as context. It saves the document first, shows its progress on the button (which then stops it) while the notes it works on pulse (`data-pending` on `roll-note`; dimmed instead with reduced motion), and returns pitches only; the editor applies them as one edit (`applyPitches`), skipping notes moved, resized, repitched or being dragged meanwhile and pitches that didn't change (nothing changed: nothing happens); a result for a chart that was made again meanwhile is dropped. Stop aborts between its stages too (GAME also within), and notes past the vocals' end find nothing. It needs the vocals; models are downloaded as needed.
- Chart range (beside Auto pitch and in the note menu) uses the ruler range while looping is on, else the selected notes; with neither it says how to choose a range. Its dialog reviews whole-note/grid expansion for the chosen singer, prefills affected lines and preserves edited text. English/German, with no duration, character or line-count cap: the range can cover the whole song. `project.chartRange` returns data only: existing vocals through the chart pipeline's passage mode, with no beat fit, lyric lookup, backing-word removal, golden marking or automatic line splitting. A common 20 ms crop origin and shifted local GAP retain the exact project ticks. Main rechecks chart and source checksums. `chart-range-job.ts` saves first, then guards document identity, synchronous revision and media-update identity before one `doc.edit`; Stop/close and stale or failed results never replace notes. `replaceRange` splits surviving prefix/suffix lines, keeps outside note fields and other singers, and supplies independent new breaks. Undo/Redo restores the exact chart and selection.
- Duets (`singer-switch.tsx`, `singers.ts`, `singers-view.ts`): a solo chart has Add singer in the transport (the bar at the bottom, after the listening controls); a duet has one chip per singer there. The active singer (`createSingersView`, a view not saved or undone) is where new notes, paste, B and break-lane double-clicks and Chart range's default go; clicking a chip chooses it, and pressing a note still makes its singer active. In the roll and lanes the other singer is dimmed and drawn under the active one's notes (`data-inactive`), so clicks where they overlap land on the active singer. A chip's eye hides a singer: their notes, breaks and lyrics leave the drawn lists (`notes`, `lines`, `breaks` in the screen), so no click, selection, command or tone reaches them; the last one shown can't be hidden, and hiding drops them from the selection. The timeline's length still includes every singer (`allNotes`), even without playable audio. Double-click a chip to rename; right-click it for Show only (or Show both), Rename and Remove; Add singer opens the new chip for its name. Who sings a note is a setting of it, not a command: with notes selected in a duet, Sung by (title bar, and the note menu's submenu) shows their singer (none pressed when both singers' notes are selected) and a click gives them all to that singer. Copy to (note menu) gives the other singer independent copies for a part sung together; there are no linked "both" notes, as in the file format and other editors. Both are `transferNotes`: the original notes and stored break switches go through `insertNotes`, the line-building shared with paste, but without snapping or a song-length cut. Exact timing and `edited` are kept, automatic breaks stay automatic, and two-point breaks keep both endpoints while they fit. Automatic edge breaks are added unless the notes bring theirs or land inside one of the other singer's lines. A transfer is refused where any note would overlap one of the other singer's. A double-click on the break lane adds the break for whichever shown singer has a line there, the active one first. Removing a singer (a chip's context menu; asks when it has notes) deletes its notes or moves them over (overlaps allowed: notes are never lost), then its lines and row; the remaining singer becomes P1. Singer rows are `ChartChange`s too (`index`, `name`; created before their lines, deleted after them; main refuses deleting one that still has lines). Export writes a duet only when both singers have notes (`singingSingers`), else a solo chart with a warning. Imported P3 parts of charts before `#VERSION:1.0.0` become copies in P1 and P2 (`packages/ultrastar`); in a v1 chart P3 is a third singer and is refused. Export names both singers of a duet (`#P1`/`#P2`, the part's name for an unnamed one), as the v1 format requires.
- The note menu (`note-menu.tsx`, right-click in the roll) has every key's action with its key, so it teaches them. A right-click on a note makes the menu about the selection (`menuOpen`: the note joins it unless it is in it already); on empty space it offers Chart range, Paste and Select all. It shares the keys' actions (`editing.commands`, which also say whether each applies). The roll tells the screen which note was right-clicked on the way up (`onNoteContextMenu`), before the menu's trigger opens it. Its Paste asks main for the clipboard (`pasteFromClipboard`: `{ send: "paste" }` on `CLIPBOARD_CHANNEL`; main sends Paste back with the text, as the Edit menu does), since the page can't read the clipboard. The type items are plain rows with a tick by the name (a check item reserves a tick column on every row).
- Listening (`loop.ts`, `tones.ts`, `playback.ts`, the transport): a click on the time ruler moves the playhead, a drag marks a loop range on the grid and turns looping on; its edges are dragged, a double-click removes it (the head lands under the first click, so the playhead's head passes double-clicks on too). L or the loop button turns looping on and off; with notes selected, on loops them. While looping, playing starts at the range from outside it and goes back at its end (`onFrame`). Scrubbing is on the playhead's head. Speed (1×/0.75×/0.5×, a Select) keeps the pitch (`preservesPitch`). Tones (one toggle, off at first, remembered in localStorage like Follow) play the notes as Web Audio tones along with playback, scheduled 0.2 s ahead each frame and restarted after a jump, a pause, a speed change or a change to the notes being played (including hiding or showing a singer); and a short tone when a pitch is dragged, moved with the arrows or drawn (`onPitch`). Rap and freestyle notes have no tone. Volume (inline sliders in the transport): the song (whichever source plays) with mute, and the tones, whose button works like mute (a slider at nothing turns them off; on again restores their volume); remembered in localStorage. The transport groups listening on the left (source, loop, speed, volumes, tones) and the view on the right (sung pitch, waveform, sing along, video, follow, zoom); the view toggles (`ViewToggle`) only show with something to show, and are remembered (`prefs.ts`). Follow (on at first) keeps the page-at-the-edge following; scrolling while playing pauses it until playback starts again, the playhead is moved, or the playhead is back on the page (`onPage`).
- Song details (`song-details-dialog.tsx`, from the song's name in the title bar; there is no Song sidebar any more, and no whole-song "Make the chart" in a project: use Chart range for passages): title, artist, languages, year, genre, edition, creator, tags, duet singers' names, each saved as an edit when left (undoable). Gap (ms, with the timing) works like `#GAP` in the file (`changeGap`): every singer's notes, stored breaks and the medley (beats in the file) move with the grid as one edit, while start, end and preview (audio times in the file) stay, and notes keep `edited`; refused when notes would start before the song or end after the audio. The editor's chart carries the song (`EditorChart.song`, `EditorSong`); tags live in `#TAGS` among the song's other headers (`electron/project/tags.ts`), singer names are a `singer` change. The title bar reads the song from the chart, and the media from `changedMedia` once the artwork changed, since the overview is only read when the project opens and reading it again would start the editor over. Artwork changes run one at a time per project and leave one file per role. Files (`song-files.tsx`): every media file with its size and length; the cover and background always have a row with Change…/Add… and Remove. The cover changes in its own dialog (`song-artwork.tsx`, setup's tiles via `CoverOption`, whose hints are our tooltips, not `title`), which only then looks for covers online; the background from an image file. Main: `electron/project/artwork.ts`, `project.setArtwork` (found cover downloads limited to the cover hosts; a picked file must be an allowed path); not part of undo (the screen keeps the returned media in `changedMedia`). The lyrics the song came with are a collapsible list at the end. Timing (`song-markers.ts`, `song-timing.tsx`): start and end are handles at the ruler's ends (outside dimmed, in the roll too), preview start a flag on the ruler, the medley a band in the overview bar whose edges snap to line starts and ends (every singer's); each dragged and written as one edit (a press that doesn't move is a click: the playhead goes there; loop edges win over them), start and end kept a second apart and inside the song, a start at 0 or an end at the song's end stored as none. Undo cancels marker and loop drags like the others (`cancelGestures`). The dialog sets them to the playhead (the medley to the selected notes' lines), plays from them or clears them, and edits the video offset. The Merge button sits next to the wand.
- Shared pieces: `drag.ts` follows every press-and-drag (notes, drawing, line breaks, the selection box: threshold `DRAG_PX`, edge scrolling, release, cancel, blur), each drag keeping its own maths and commit; `icon-button.tsx` is the editor's icon button with its tooltip (trigger props first); `prefs.ts` and `src/lib/stored.ts` keep the listening settings (and the home screen's view) in localStorage; `auto-pitch-job.ts` runs auto pitch for the screen; `song-details.tsx` wires the details dialog; `test-chart.ts` has the test notes and song.
- Keys (not while typing or in a dialog): Space play/pause, `,` / `.` previous/next line, Z fits the current line; Cmd/Ctrl+wheel or pinch zooms at the pointer, wheel and Shift+wheel scroll time (a frame's wheel events add up and change the view once).
- Editing notes: `src/lib/editor/note-editing.ts` turns clicks, the selection box and keys into selections and edits; `edits.ts` has the rules, `selection.ts` which notes a click, Shift-click, box or Tab selects. Click selects, Shift-click a range of that singer's notes, Cmd/Ctrl-click toggles; a click on empty space deselects and moves the playhead, a drag there draws a selection box. Dragging a note's body moves the selection in time and pitch (Shift: only the way it went first), its edges (notes 12 px wide or more) move starts or ends; a press on a selected note keeps the selection and selects just that note if it doesn't drag. A drag is a preview (`drag`, `previewed`) with a label at the pressed note, written as one edit when let go; Esc cancels, and so do undo/redo (`cancel`, its limits were for the chart before) and leaving the editor. Edits that make notes (add, split, merge) name their selection with `selectionAfter`, so redo brings it back. The roll keys notes by id (`For keyed`), so an edit updates elements instead of remaking them. Tools (`tools.ts`; `ToolSwitch` in `edit-controls.tsx`, in the title bar after Undo and Redo): Select V, Draw D, Split C; tapping the key switches, holding it switches until let go; Esc stops a drag, then goes back to Select, then deselects. Draw: a drag on empty space draws a note, a click adds one as long as the last note drawn or clicked (FL Studio's way; about ⅛ s at first, `defaultLength`), into the line the time falls in (`lineAt`), for the selected notes' singer. Split: a cut line follows the pointer on a note (red where a step wouldn't be left either side), a click splits (Shift: every note at that time); the second part gets `~`. Any tool: double-click on empty space adds a note, Cmd/Ctrl+K splits at the playhead. A new or double-clicked note (or Enter on one selected) gets its syllable typed in place; Enter keeps it, Tab goes on to the next note, Esc drops it. Line breaks (`breaks.ts` rules, `break-editing.ts` gestures, markers in `BreakLane`): everything between two of a singer's breaks is one line and every note belongs to the line it starts in. Dragging a marker moves it only to allowed spots (`breakLanding`: on the grid, never inside a note; over notes, the nearer edge of the stretch they cover, overlapping ones counting as one: `occupied`), moving the notes it passes to the other line, with a label ("0:21.3 · 2 notes move"); it keeps a note on either side. A press selects a marker (deselecting notes), Delete or a double-click removes it (joining the lines), a double-click on the lane adds one, B or Add line break (title bar) adds one with default timing, so it follows the gap: after the selected notes (`breakAfter`: after the last of them to start; also Line break after in the note menu), or with nothing selected in the gap nearest the playhead inside its line (`nearestGap`, refused when the nearest gap is between two lines, which has its break already; holding B adds one, and B waits while another gesture runs). A double-click on the lane stores the time clicked. Moving notes between lines keeps their `edited`. Dragging anything (a note, a drawn note, a line break, the selection box, the playhead's head or a loop range on the ruler) near or past the roll's left or right edge scrolls the view (`autoscroll.ts`: faster the further in, one frame at a time, redoing the drag at the pointer); drags measure from the view's start at the press (`viewStart`), so what is dragged keeps up, and the screen flushes after scrolling because the redo reads the view at once. Gestures keep their latest preview in locals: Solid writes signals on the next microtask, and a release can come first. Keys on the selection: ↑/↓ pitch (Shift octave), ←/→ a grid step, Shift+←/→ length, Tab/Shift+Tab next/previous note, Cmd/Ctrl+A, Esc, Delete/Backspace, M merge (joins syllables, drops `~`), G/R/F golden/rap/freestyle. Notes stay on the grid, at least a step long, inside the audio (its length, not the view's, which grows with the notes) and their line's room (`lineRooms`: up to its stored break, else the next line's first note, so lines never interleave); new notes are cut short to fit or refused; they may overlap (pasting is easier) and are then outlined red (`overlapping`). The pitch rows fit the notes (with room) except during a note drag: then they only grow, and only to fit the dragged notes (adding room would make the pointer's spot a further pitch each move, so the note would run off). A drag's pitch comes from the pointer's height in the roll as drawn now (`RollScale.pitchAt`), so the note stays under the pointer as the rows change; held past the top or bottom it goes on a semitone every 90 ms (`EDGE_STEP_MS`), the rows growing along. Let go, the rows fit the notes again.

### Making the chart (`electron/charting/`, `native/src/{aligner,pitch,beats,ctc,game,numpy_rng,harmonics,refiners,runtime}.rs`)

- Making the chart (in setup, `drafts.makeChart` via `chartFromFiles`): the song's vocals, audio and lyrics through the auto-tuner PoC's chart pipeline (its defaults: aligner fine-tuned on singing, syllable-start head, GAME notes, pitch corrector, learned note ends); the new project starts with the result. Existing projects can chart a selected passage with supplied lyrics (Chart range), without remaking the song grid. Needs the lyrics and the vocals; English and German only so far (`chartLanguage`).
- It is a port, checked against the PoC: every function reproduces the PoC's output (NumPy's arithmetic included: `numpy.ts` has pairwise sums, round-half-even, floor modulo, float32 statistics; never `Math.round` or `%` there). `pipeline.ts` runs the stages in the PoC's order; the models sit behind `ChartEngines` (`chartEngines` in `engines.ts` binds them to the addon). Charts are written on the PoC's rounded headers (#BPM to 3 decimals, #GAP in ms), so an export writes the PoC's beats.
- Native: CPU only for now. The aligner runs in ctc-forced-aligner's 30 s windows (one pass gives the CTC log-probabilities and the head's hidden states); the CTC Viterbi (`ctc.rs`) is ctc-forced-aligner's (BSD 2-Clause) in f32 with its tie-breaks; GAME's segmenter gets its random op replaced by an input on the protobuf (`patch_segmenter`) fed from NumPy's PCG64 (`numpy_rng.rs`), seeded per line like the PoC; Beat This! chunks like its own inference, peaks are picked in `beats.ts`.
- Text: `aligner-text.ts` is ctc-forced-aligner's `preprocess_text` (normalization and uroman) from generated tables (`data/aligner-text.json`, Latin, Hangul and Chinese characters, which romanize character by character). Syllables: the learned tables `data/syllables-{english,german}.json` plus rules. The generated files come from the PoC's `scripts/export_text_tables.py` / `export_fixtures.py`; don't edit them. They aren't bundled (1.2 MB of JSON every launch would parse): `scripts/build-electron.ts` (and `dev`) copies them to `dist-electron/data`, packaged inside the archive, and `tables.ts` reads each on first use (from the source folder in tests); what is made from them is made then too.
- Models: one `ensureAll(CHART_MODELS)` download (1.6 GB as the app counts, binary units): our aligner and note refiners and ONNX exports of FCPE and Beat This! from Hugging Face (`tuneperfect/*`, pinned revisions), and GAME as openvpi's v1.0.3 release zip from GitHub, unpacked with `unzip` and checked file by file (`unpack`).
- Tests: synthetic ones and committed fixtures (words, never song lyrics) run everywhere; the PoC's recorded calls on real songs (`goldens.ts`) run when `TUNESTUDIO_CHART_GOLDENS` points at the PoC's `out/golden`, the native ones (`native.test.ts`) also need `TUNESTUDIO_CHART_MODELS` (the PoC's `out/export`), `TUNESTUDIO_CHART_GAME` and a built addon.

### Settings (`src/lib/settings.ts`, `electron/services/settings.ts`, `/settings`)

- One schema shared by renderer and main; `settingsFrom` keeps every still-valid stored value and defaults the rest, so adding or dropping an option never resets the others. Stored as `<data>/settings.json` (`{ version: 1, settings }`).
- `newProject` isn't on the settings screen: it remembers the last new project's language, written only by main (`remember`, from `drafts.create`); `settings.set` keeps the stored one, since the screen's copy may be old.
- The settings screen saves each change right away (`settings.set` with the whole object); there is no Save button. Reached from the rail's bottom item; Home and Recent go back to `/` (Recent via `#recent`).
- YouTube download options follow USDB Syncer (defaults: M4A 256 kbps, no normalization; MP4 best codec, 1080p, 60 fps). No FLAC: YouTube audio is lossy. M4A and Opus are saved as served; the bitrate applies only when audio is converted or normalized. They shape new downloads only; media already in a project is never converted.

### Try in game (`electron/games/`, `src/lib/games.ts`, `components/settings/games-section.tsx`)

- Export menu has a "Try in <game>" per available game (chosen and startable, or found: `isAvailable`), in `GAMES` order, or a plain "Try in game" when there is none; the editor reads `games.status` on open and when the menu opens. File menu "Try in Game" and Mod+T (the page takes Ctrl+T off macOS) pass no game: main starts `defaultGame` (`games.last`, set on each successful try, else the first available), and only that item shows the key. Each saves, then `project.tryInGame` exports for games (`exportSong`, media byte for byte) into `<data>/try-in-game/<Artist - Title>` (`syncSong`: the folder ends up as a fresh export would, everything else in `try-in-game` is removed so only the last try is kept; `.exported.json` beside it records each media file's checksum, so trying again only writes the chart and the media that changed) and starts the game with that song folder, as USDB Syncer does: Tune Perfect `--songpath`, UltraStar Deluxe `-songpath`, Vocaluxe `-SongFolder`, Performous the folder alone (`launchArgs`). Nothing is exported when there is no game: `GameNotFound` gets a toast whose Open Settings closes the project and goes to `/settings#games`.
- Games are Tune Perfect, UltraStar Deluxe, Vocaluxe and Performous. Settings `games.paths` and `games.last` are main's own (`games.choose` opens main's dialog and checks the pick, `games.clear`); `settings.set` keeps the stored ones, so the renderer can never name what is run (only which game). The Games section lists games with an app (a chosen one that can't start too, to fix or clear) and "Add a game…" for the rest. Without a chosen app, `findGame` looks in `/Applications` and `~/Applications` by bundle name (renamed copies too), the Windows install folders, the Linux PATH (Windows and Linux untested).
- macOS: the program is `Contents/MacOS/<CFBundleExecutable>` from `Info.plist` (`plist.ts`: XML read by hand, binary through `plutil`), never a path out of the bundle. Started by `GameLauncher` (node `spawn`, detached, stdio ignored, unref; not Effect's spawner, which stops it with its scope) with `cleanEnv` (no `ELECTRON_*`, `NODE_OPTIONS`, `TUNESTUDIO_*`, `__CFBundleIdentifier`, AppImage variables). It counts as started once the process starts; only ENOENT/EACCES (or another spawn error) are failures. What the game does afterwards isn't watched: Tune Perfect is single-instance, so a copy already open takes the start over and the new process quits.
- Tests: `testRuntime` records starts (`launched`) and only looks for apps in the test's folder; e2e sets `TUNESTUDIO_APP_FOLDERS` to an empty folder so the computer's own games are never found, and `fakeGame` (a `.app` whose program is a script writing its arguments) checks the whole flow.

### Open source licenses (`scripts/licenses/`, `src/components/settings/`)

- `vite build` writes `dist/licenses.json` (`licensesPlugin` in `plugin.ts`, collected by `collect.ts`); it is generated, never committed, so it can't go stale. It lists the npm packages whose code is in the renderer bundle (Vite's rendered modules, assets, CSS `@import`s, `~icons/*` as `@iconify-json/*`) and in main/preload (esbuild's metafile with the build's options), the Rust crates the addon links (`cargo metadata --filter-platform` for this machine; build scripts' and proc macros' crates left out), its C/C++ libraries (whisper.cpp, ONNX Runtime with its version from ort-sys, Dawn, DXC, DirectML, compiler-rt, per system) and Electron's LICENSE. Workspace packages are skipped. Each text is stored once (`texts`)
- A package or crate without a known SPDX license (copyleft isn't on the list) or without a license file fails the build. One that really ships no file gets its text from `scripts/licenses/texts/` via `MISSING_TEXTS`; texts for ONNX Runtime (named by version: an ort bump fails until its LICENSE and ThirdPartyNotices are added), Dawn and the others live there too
- The renderer fetches it (`loadNotices`, `src/lib/licenses.ts`) only when the dialog opens. The dev server serves the last build's file, else empty lists with a note. Downloaded tools are a static list there (`DOWNLOADED_TOOLS`); models stay in the Models section; Chromium's `LICENSES.chromium.html` is opened in the browser by main (`app.openChromiumLicenses`)
- Settings' About section (`about-section.tsx`): version, the app's MIT text (the repo's `LICENSE`, imported `?raw`) and the licenses dialog (`licenses-dialog.tsx`). Tests: `scripts/licenses/collect.test.ts` (Vitest project `scripts`; builds with Vite and checks the real list, skipped without cargo), `about-section.test.tsx`, and the About test in `e2e/settings.spec.ts`

### Start screen

- `/` is the start screen. Recent projects come from main (`native.recents.list`, `src/lib/recent-projects`); removing
  one from recents is saved, with an Undo in its toast. Opening a project stores its title, artist and a cover
  thumbnail in recents; the thumbnail is kept while the cover's checksum (`coverSha256`, main's own) is the same
- A project file the OS hands a window (Finder, Explorer, the command line) is taken by `/`'s loader when the window
  arrives there, which redirects to the editor, so the start screen never flashes; one handed over while the start
  screen shows is the screen's (it waits while a new-project flow is open)
- The start options open the new-project flows (`components/home/flow-dialogs.tsx`): a YouTube link, an audio file, or
  a song folder
- Shortcuts only where they clearly help (the editor's are listed under The editor). Projects take Enter, Shift+F10 / menu key and Delete
- No "coming soon" placeholders: show only what exists

### Dev loop (`bun run dev`)

- Renderer edits hot-update through Vite with Solid's refresh (built into the Solid Vite plugin, dev only): a
  component edit keeps the page and other components' state; CSS and token edits apply in place
- `electron/` is bundled by esbuild in watch mode. If the main bundle changed, Electron restarts (the window's
  position and size are saved on close and restored; a rebuild while the old app is still quitting waits for that
  restart, which loads the newest bundle); if only the preload changed, the windows reload instead
- If Vite doesn't answer within 30 s, or exits (e.g. port 1430 taken), the loop stops with a message and exit
  code 1. Closing the app or Ctrl+C stops Vite, esbuild and Electron
- `bun run dev -- -- --remote-debugging-port=9333` (from the root) passes flags on to Electron

### Testing

- Vitest projects are by extension: `unit` = `src/**/*.test.ts` (node), `ui` = `src/**/*.test.tsx` (jsdom, Solid's
  browser dev build without HMR wrappers, `tests/setup.ui.ts`), `electron` = `electron/**/*.test.ts` (node).
  `scripts` = `scripts/**/*.test.ts` (node). `bunx vitest run --project ui` runs one. A `.test.tsx` under `--project unit` prints "No test files found" and exits
  green: that is not a pass
- Smallest proof first (`bunx vitest run src/lib/youtube.test.ts`), then `bun run test`, then `bun run test:e2e`
- Component tests render with `@solidjs/testing-library` (the Solid 2 beta), query by role and accessible name, and
  drive the UI with `@testing-library/user-event`. Don't mock the unit under test; Node tests of main-process code
  mock only `electron` itself
- Logic worth testing lives in plain modules (`src/lib`, `electron/csp.ts`) so the `unit`/`electron` projects can
  cover it without a DOM; a test that needs a timeout or sleep to pass is wrong
- Effects are tested with `@effect/vitest` (`it.effect`), providing test layers for services
  (`Layer.succeed(AppLog, ...)`) instead of mocking; see `electron/rpc/procedures.test.ts`
- RPC handlers are tested through the renderer's real client over a Node MessageChannel (`connectClient` in
  `electron/rpc/test-client.ts`), so encoding, errors and cancelling are covered; component tests mock
  `~/lib/native/client` instead
- Playwright e2e (`e2e/*.spec.ts`) drives the built Electron app; keep it to smoke flows that need the real shell
- E2e and `bun run shots` launch the app with `TUNESTUDIO_BACKGROUND=1`: the window is never shown and never takes
  focus (no Dock icon), pages still render for screenshots. `TUNESTUDIO_E2E_SHOW=1` shows it when debugging. Take
  screenshots only when a visual check is actually needed
- `bun run shots:readme -- <audio>` (after `build`) makes the README's screenshots from a real chart: the public
  domain "Amazing Grace" recording named in `e2e/readme-shots.ts` (not committed; download it), imported, separated and
  charted through the audio file flow with the lyrics in the script. It runs online with its own data folder in
  `.local/readme-shots`, seeded with the dev app's models and tools (`TUNESTUDIO_README_MODELS` points elsewhere), keeps
  the projects so a second run only takes pictures (delete the folder to start over), and writes 1440 px PNGs to
  `docs/images` with `sips` (macOS)
- E2e never touches the system clipboard: `stubDesktop` makes main's `clipboard` a string in main (`clipboardText`
  reads it) and gives each page's copy/cut/paste events a DataTransfer of their own, whose text goes to main through
  the preload. Wait for what main did (`expect.poll` on main-process state) rather than sleeping
- Turbo runs tasks in strict env mode: only listed variables reach them. `apps/studio/turbo.json` passes `TUNESTUDIO_*`
  to `test`, `test:e2e` and `dev` (so `TUNESTUDIO_CHART_GOLDENS=… bun run test` from the root runs the golden tests);
  `GGML_NATIVE` is part of the build's hash, and the build's cached outputs include the addon and its GPU libraries. A
  new variable a task reads goes there too

## base-ui-solid

Repros of suspected bugs live in `.repro/` (gitignored): run `bunx vite`, open
`http://localhost:1430/.repro/<name>.html`, or run `node .repro/run.mjs` with the dev server up. Compare with upstream
`@base-ui/react` before reporting one: focus guards, for one, hand focus on a frame later in both. No known issues in
0.3.0.

## Common Gotchas

- Terminals inside Electron-based editors may export `ELECTRON_RUN_AS_NODE=1`; the scripts strip it, clear it when
  running Electron by hand
- Playwright's Electron driver doesn't connect when run by Bun: `e2e/shots.ts` runs under Node (`bun run shots`
  does that), tests under `playwright test`
- Development data lives in `Tune Studio Dev` (userData/logs), releases in `Tune Studio`; `TUNESTUDIO_DATA_DIR`
  moves it (tests use a temp dir, so they never collide with a running copy)
- Electron downloads its binary on first `require("electron")`, not on install
- `@tanstack/router-plugin` and `@tanstack/router-cli` are pinned exact and share one `router-generator`: bump them
  together. `@types/node` follows the Node bundled with Electron (Electron 44: Node 24), not the newest

## Pre-PR Checks

```bash
bun run lint && bun run format:check && bun run typecheck && bun run test && bun run test:e2e
```
