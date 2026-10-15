# Tune Studio

A desktop editor for UltraStar karaoke charts, in the [TunePerfect](https://tuneperfect.org) family. Start from a
YouTube link, an audio file or an existing song folder; Tune Studio drafts the chart and you refine it in a
Premiere-style editor.

> Early days: step 1 (the start screen) is in place. Nothing is downloaded, imported or generated yet.

## Stack

- **App**: Electron 44 with a sandboxed Solid 2 renderer, served from a custom `app://` scheme
- **UI**: Solid 2 (`solid-js` + `@solidjs/web`), [base-ui-solid](https://github.com/ZerNico/base-ui-solid),
  shadcn-style components (Tailwind CSS v4, `class-variance-authority`), Lucide icons through `unplugin-icons`
- **Routing**: TanStack Router for Solid 2, file-based routes
- **Main ↔ renderer**: oRPC over a MessagePort
- **Tooling**: Bun workspaces, Turborepo, Oxlint + Oxfmt, Vitest (unit, component and main-process tests),
  Playwright (Electron) for end-to-end tests

## Getting started

```bash
bun install
bun run dev          # Vite (port 1430) + Electron with live reload
```

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `bun run dev`       | Develop the studio app                                              |
| `bun run build`     | Build every package (renderer to `dist/`, main to `dist-electron/`) |
| `bun run typecheck` | Type-check the renderer, main process and tests                     |
| `bun run test`      | Vitest: unit, component (jsdom) and main-process tests              |
| `bun run test:e2e`  | Build, then run the Electron end-to-end tests (Playwright)          |
| `bun run lint`      | Oxlint (with Solid, shadcn and slop rules)                          |
| `bun run format`    | Oxfmt; `format:check` only checks                                   |

App-specific commands (packaging, screenshots) are in [apps/studio/AGENTS.md](apps/studio/AGENTS.md).

## Structure

```
apps/
└── studio/        # the Electron app (@tunestudio/studio)
packages/          # shared packages, none yet
```

## Plan

1. **Start screen** (done): monorepo, Electron shell, lint/format setup and the UI of the Photoshop-style home
   screen with stub flows for YouTube, audio and song folders. Recent projects come from placeholder fixtures.
2. **Editor shell**: open an existing UltraStar chart with its audio; piano roll, lyrics and transport, carried over
   from the Auto-Tuner editor spike.
3. **Projects**: project folders, saving, real recent projects (replacing the fixtures), reveal in Finder.
4. **Import**: audio import, YouTube download, vocal separation.
5. **Charting**: automatic pitch, timing and lyrics alignment to draft a chart; assisted editing.
6. **USDB**: find existing charts and open them directly.
7. **Release**: signing, installers, updates.
