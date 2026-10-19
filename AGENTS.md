# Tune Studio: Agent Guide

## Project Snapshot

- **Monorepo** (Bun workspaces + Turborepo): a desktop UltraStar chart editor in the TunePerfect family
- **Stack**: TypeScript, Electron, Solid 2, base-ui-solid, Tailwind CSS v4, TanStack Router, Effect RPC
- **Linter/Formatter**: Oxc (`oxlint.config.ts`, `.oxfmtrc.json`)
- Sub-packages have their own `AGENTS.md`; always check the nearest one first

## Setup

```bash
bun install
bun run dev          # the studio app (Vite on :1430 + Electron)
bun run build        # turbo build all
bun run typecheck    # turbo typecheck all
bun run test         # Vitest in every package (no build needed)
bun run test:e2e     # build, then the Playwright Electron end-to-end tests
bun run release 0.2.0  # on a clean main: set the app's version, commit and tag v0.2.0 (see Releasing)
```

## Universal Conventions

- **Solid 2, not Solid 1 or React**: `@solidjs/web` for DOM APIs and JSX types, `omit`/`merge` instead of
  `splitProps`/`mergeProps`, `onSettled` instead of `onMount`, two-argument `createEffect`, `class` objects/arrays
  instead of `classList`, lowercase attributes (`tabindex`), ARIA booleans as strings. Read
  `node_modules/solid-js/CHEATSHEET.md` when unsure
- **Formatting**: Oxfmt, 2-space indent, 120 line width, LF endings, sorted imports and Tailwind classes
- **Effect 4**: main-process services and domain logic run as Effects; **Effect Schema** validates RPC inputs and outputs,
  route search params and everything persisted (see `apps/studio/AGENTS.md`)
- **RPC**: Effect RPC (`effect/rpc`) between the renderer and Electron's main process, over a MessagePort
- **Routing**: TanStack Router (Solid) with file-based routes
- **Styling**: Tailwind CSS v4 with `class-variance-authority` for variants; colours only from theme tokens
- **UI primitives**: base-ui-solid (maintained by the repo owner: report bugs with a minimal repro, don't hide them)
- **Icons**: `unplugin-icons` with `@iconify-json/lucide` (`import XIcon from "~icons/lucide/x"`)
- **Comments**: short JSDoc on exports; explain why, not what. No em dashes in prose (lint enforces it)
- **Tests**: Vitest for logic and components (`*.test.ts`, `*.test.tsx` beside the code), Playwright for end-to-end
  tests that drive the built Electron app (`apps/studio/e2e`)

## Testing

- Vitest projects are by extension: `unit` is `src/**/*.test.ts` (node), `ui` is `src/**/*.test.tsx` (jsdom), `electron`
  is `electron/**/*.test.ts` (node). `bunx vitest run --project ui` (in `apps/studio`) runs one. Running a `.test.tsx`
  under `unit` prints "No test files found" and exits green. That is not a pass
- Smallest proof first: the one test file you touched (`bunx vitest run src/lib/youtube.test.ts`), then the whole
  `bun run test`, then `bun run test:e2e` for anything the Electron shell touches
- Tests assert real behaviour against real components: query by role and accessible name, drive them with
  `@testing-library/user-event`. Don't mock the unit under test; mock only what can't run in the test runtime
  (`electron` in node tests)
- A test that only passes with a timeout or sleep is wrong: wait for the state you expect (`findBy*`, `expect.poll`)
- No snapshot-only tests

## Lint Rules Worth Knowing

- `shadcn/no-restyle`: call sites may only add layout classes to components from `~/components/ui`; add a variant
  in the component instead of restyling it
- `shadcn/no-raw-colors` / `no-unknown-classes`: use the theme tokens in `apps/studio/src/styles.css`
- `slop/*`: no em dashes, jargon, trivial wrappers or over-long comments
- `solid/*`: Solid reactivity and JSX rules (`eslint-plugin-solid` as an Oxlint JS plugin)
- `import/no-cycle`

## JIT Index

| App           | Purpose                                 | Port | AGENTS.md                                      |
| ------------- | --------------------------------------- | ---- | ---------------------------------------------- |
| `apps/studio` | Electron desktop chart editor (Solid 2) | 1430 | [apps/studio/AGENTS.md](apps/studio/AGENTS.md) |

```bash
rg -n "createFileRoute" apps/*/src/routes      # find routes
rg -n "export function" apps/studio/src/components/ui   # find UI primitives
rg -n '^  "[a-z]+\.[a-zA-Z]+":' apps/studio/electron/rpc/handlers   # find RPC handlers
```

## CI and Releasing

- **CI** (`.github/workflows/ci.yaml`, on pull requests and pushes to main, Linux only): lint, format check, typecheck
  and Vitest's `unit`, `ui` and `electron` projects. No e2e or packaging there: both need the release build of the
  native addon (Rust, whisper.cpp), which only the release build makes
- **Releasing**: `bun run release 0.2.0` on an up-to-date, clean main sets `apps/studio/package.json`'s version (the
  one the app shows), commits "chore(release): v0.2.0" and tags `v0.2.0`; then `git push origin main v0.2.0`. The tag
  starts `draft-release.yaml`: `build-app.yaml` packages macOS Apple Silicon (dmg), Windows x64 (installer) and Linux
  x64 (AppImage) on their own runners, then a draft GitHub release gets the installers and a changelog of the commits
  since the previous tag, grouped by type (`build`, `docs`, `style` and the release commit left out, see Commits).
  Check the draft and publish it by hand. A tag that doesn't match the version fails the build
- **Dry run**: `gh workflow run build-app.yaml --ref <branch>` (or Actions → Build app → Run workflow) packages all
  three as the run's artifacts (kept 7 days), without a release
- Packaging checks what it made (`apps/studio/scripts/check-package.ts`): the addon and its GPU libraries, the
  archive's files, no source maps, and that the addon loads. Installers are unsigned (ad-hoc on macOS), and the app
  doesn't update itself

## Commits

- **Conventional Commits**: `type(scope): summary`, the summary lowercase and in the imperative, no period, e.g.
  `fix(editor): keep the selection when undoing a split` or `feat(import): read P3 duets`
- **Types**: `feat` (something users can do or see that's new), `fix` (a bug users hit), `perf`, `refactor`, `test`,
  `docs`, `build` (packaging, dependencies, the native build), `ci` (workflows), `chore` (everything else). The release
  notes group commits by type and leave out `build`, `docs` and `style`, so pick the type for what users notice
- **Scope** (optional): the area, e.g. `editor`, `import`, `export`, `usdb`, `native`, `transcribe`, `mac`, `windows`
- **Breaking changes**: `feat!:` plus a `BREAKING CHANGE:` footer saying what changed
- The body (optional) says why, wrapped at 72 characters

## Definition of Done

1. `bun run lint` and `bun run format:check` pass with no warnings
2. `bun run typecheck` passes
3. `bun run test` passes; `bun run build` and `bun run test:e2e` pass for changes the app shell or a screen sees
4. Screens you changed look right in a screenshot (`bun run shots` in `apps/studio`)
