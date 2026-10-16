import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import FolderSearchIcon from "~icons/lucide/folder-search";
import LayoutGridIcon from "~icons/lucide/layout-grid";
import ListIcon from "~icons/lucide/list";
import SearchIcon from "~icons/lucide/search";
import SearchXIcon from "~icons/lucide/search-x";
import XIcon from "~icons/lucide/x";

import { BrandMark } from "~/components/brand-mark";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { revealLabel } from "~/lib/desktop";
import { projectNameExtra } from "~/lib/file-names";
import { formatFullDate, formatRelativeTime } from "~/lib/format";
import { type RecentProject, searchRecentProjects } from "~/lib/recent-projects";
import { createStored, type StoredFormat } from "~/lib/stored";

import { ProjectCover } from "./project-cover";

type View = "grid" | "list";

/** "grid" or "list". */
const VIEW_FORMAT: StoredFormat<View> = {
  read: (text) => (text === "list" || text === "grid" ? text : undefined),
  write: (view) => view,
};

const VIEW_STORAGE_KEY = "tunestudio.home.recentView";

export interface RecentProjectActions {
  onOpen: (project: RecentProject) => void;
  onReveal: (project: RecentProject) => void;
  onRemove: (project: RecentProject) => void;
}

/** The "Recent projects" section: search, grid/list switch, the projects, and the empty states. */
export function RecentProjects(
  props: RecentProjectActions & {
    projects: RecentProject[];
    searchRef: (element: HTMLInputElement) => void;
    /** Buttons at the end of the header, shown with or without projects. */
    headerActions?: JSX.Element;
  },
) {
  const [query, setQuery] = createSignal("");
  const [view, changeView] = createStored<View>(VIEW_STORAGE_KEY, VIEW_FORMAT, "grid");
  const filtered = createMemo(() => searchRecentProjects(props.projects, query()));

  return (
    <section id="recent" aria-labelledby="recent-title" class="flex flex-col gap-4" data-testid="recent-projects">
      <div class="flex flex-wrap items-center gap-3">
        <h2 id="recent-title" class="m-0 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.2px]">
          Recent projects
          <Show when={props.projects.length > 0}>
            <Badge variant="secondary">{props.projects.length}</Badge>
          </Show>
        </h2>
        <div class="ml-auto flex items-center gap-2">
          <Show when={props.projects.length > 0}>
            <InputGroup class="w-60">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                ref={props.searchRef}
                type="search"
                placeholder="Search projects"
                aria-label="Search recent projects"
                value={query()}
                data-testid="recent-search"
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query()) {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              <InputGroupAddon align="end">
                <Show when={query()}>
                  <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                    <XIcon />
                  </Button>
                </Show>
              </InputGroupAddon>
            </InputGroup>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Layout"
              value={[view()]}
              onValueChange={(value: unknown[]) => {
                const next = value[0];
                if (next === "grid" || next === "list") changeView(next);
              }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                    <ToggleGroupItem value="grid" aria-label="Grid" {...triggerProps}>
                      <LayoutGridIcon />
                    </ToggleGroupItem>
                  )}
                />
                <TooltipContent>Grid</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                    <ToggleGroupItem value="list" aria-label="List" {...triggerProps}>
                      <ListIcon />
                    </ToggleGroupItem>
                  )}
                />
                <TooltipContent>List</TooltipContent>
              </Tooltip>
            </ToggleGroup>
          </Show>
          {props.headerActions}
        </div>
      </div>

      <Switch>
        <Match when={props.projects.length === 0}>
          <EmptyRecents />
        </Match>
        <Match when={filtered().length === 0}>
          <div class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
            <SearchXIcon class="size-6 text-faint-foreground" />
            <p class="m-0 text-[12px] text-muted-foreground">
              No projects match <span class="text-foreground">“{query().trim()}”</span>
            </p>
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        </Match>
        <Match when={view() === "grid"}>
          <ul
            aria-label="Recent projects"
            class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-4 gap-y-5 p-0"
          >
            <For each={filtered()}>
              {(project) => (
                <li>
                  <ProjectMenu project={project} actions={props}>
                    {(triggerProps) => <ProjectTile project={project} actions={props} triggerProps={triggerProps} />}
                  </ProjectMenu>
                </li>
              )}
            </For>
          </ul>
        </Match>
        <Match when={view() === "list"}>
          <div class="flex flex-col">
            <div
              aria-hidden="true"
              class="grid grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_120px] gap-4 border-b border-border px-3 pb-2 eyebrow"
            >
              <span>Song</span>
              <span>Location</span>
              <span class="text-right">Last opened</span>
            </div>
            <ul aria-label="Recent projects" class="m-0 flex list-none flex-col gap-px p-0 pt-1">
              <For each={filtered()}>
                {(project) => (
                  <li>
                    <ProjectMenu project={project} actions={props}>
                      {(triggerProps) => <ProjectRow project={project} actions={props} triggerProps={triggerProps} />}
                    </ProjectMenu>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Match>
      </Switch>
    </section>
  );
}

type TriggerProps = JSX.HTMLAttributes<HTMLButtonElement>;

/** Right-click (or Shift+F10 / the menu key) menu shared by tiles and rows. */
function ProjectMenu(props: {
  project: RecentProject;
  actions: RecentProjectActions;
  children: (triggerProps: TriggerProps) => JSX.Element;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={(triggerProps: TriggerProps) => props.children(triggerProps)} />
      <ContextMenuContent data-testid="project-menu">
        <ContextMenuItem onClick={() => props.actions.onOpen(props.project)}>
          Open
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => props.actions.onReveal(props.project)}>{revealLabel}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => props.actions.onRemove(props.project)}>
          Remove from recents
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function itemKeyDown(event: KeyboardEvent, project: RecentProject, actions: RecentProjectActions) {
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    actions.onRemove(project);
  } else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    // Windows sends a contextmenu event for these keys itself, macOS doesn't: open the
    // project menu at the item, the way a right-click would.
    event.preventDefault();
    const item = event.currentTarget as HTMLElement;
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.min(24, rect.width / 2),
        clientY: rect.top + Math.min(rect.height - 8, 48),
      }),
    );
  }
}

function projectLabel(project: RecentProject) {
  const extra = projectNameExtra(project.path, project.artist, project.title);
  const name = extra ? `${project.title} ${extra}` : project.title;
  return `${project.artist}, ${name}. Opened ${formatRelativeTime(project.lastOpened).toLowerCase()}.`;
}

/**
 * The song title, and what the project's file name adds to it, so two projects of the same
 * song ("… (Duet)", "… (2)") can be told apart.
 */
function ProjectTitle(props: { project: RecentProject }) {
  const extra = () => projectNameExtra(props.project.path, props.project.artist, props.project.title);
  return (
    <span class="truncate text-[12.5px] font-medium text-foreground" data-testid="recent-title">
      {props.project.title}
      <Show when={extra()}>{(text) => <span class="font-normal text-muted-foreground"> {text()}</span>}</Show>
    </span>
  );
}

function ProjectTile(props: { project: RecentProject; actions: RecentProjectActions; triggerProps: TriggerProps }) {
  return (
    <button
      type="button"
      {...props.triggerProps}
      aria-label={projectLabel(props.project)}
      data-testid="recent-item"
      class="group/tile flex w-full flex-col gap-2.5 rounded-[10px] p-0 text-left outline-none focus-visible:outline-none"
      onClick={() => props.actions.onOpen(props.project)}
      onKeyDown={(event) => itemKeyDown(event, props.project, props.actions)}
    >
      <span class="relative block w-full rounded-[10px] ring-offset-2 ring-offset-background transition-shadow group-hover/tile:ring-1 group-hover/tile:ring-sage-38 group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-ring group-data-popup-open/tile:ring-2 group-data-popup-open/tile:ring-sage-38">
        <ProjectCover id={props.project.id} src={props.project.coverUrl} class="aspect-square w-full rounded-[10px]" />
      </span>
      <span class="flex min-w-0 flex-col gap-0.5 px-0.5">
        <ProjectTitle project={props.project} />
        <span class="flex min-w-0 items-baseline gap-1.5 text-[11px] text-muted-foreground">
          <span class="truncate">{props.project.artist}</span>
          <span aria-hidden="true" class="text-faint-foreground">
            ·
          </span>
          <span class="shrink-0 text-faint-foreground">{formatRelativeTime(props.project.lastOpened)}</span>
        </span>
      </span>
    </button>
  );
}

function ProjectRow(props: { project: RecentProject; actions: RecentProjectActions; triggerProps: TriggerProps }) {
  return (
    <button
      type="button"
      {...props.triggerProps}
      aria-label={projectLabel(props.project)}
      data-testid="recent-item"
      class="grid w-full grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_120px] items-center gap-4 rounded-lg px-3 py-2 text-left outline-none hover:bg-gray-15 focus-visible:bg-gray-15 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:bg-gray-15"
      onClick={() => props.actions.onOpen(props.project)}
      onKeyDown={(event) => itemKeyDown(event, props.project, props.actions)}
    >
      <span class="flex min-w-0 items-center gap-3">
        <ProjectCover id={props.project.id} src={props.project.coverUrl} class="size-9" />
        <span class="flex min-w-0 flex-col">
          <ProjectTitle project={props.project} />
          <span class="truncate text-[11px] text-muted-foreground">{props.project.artist}</span>
        </span>
      </span>
      <span class="min-w-0">
        <Tooltip>
          <TooltipTrigger render={(triggerProps: JSX.HTMLAttributes<HTMLDivElement>) => <div {...triggerProps} />}>
            <span class="block truncate font-mono text-[10.5px] text-sage-63 [direction:rtl]" data-testid="recent-path">
              <bdi>{props.project.path}</bdi>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <span class="font-mono text-[10.5px]">{props.project.path}</span>
          </TooltipContent>
        </Tooltip>
      </span>
      <span class="text-right text-[11px] text-muted-foreground tabular-nums">
        <Tooltip>
          <TooltipTrigger render={(triggerProps: JSX.HTMLAttributes<HTMLSpanElement>) => <span {...triggerProps} />}>
            {formatRelativeTime(props.project.lastOpened)}
          </TooltipTrigger>
          <TooltipContent side="top">{formatFullDate(props.project.lastOpened)}</TooltipContent>
        </Tooltip>
      </span>
    </button>
  );
}

function EmptyRecents() {
  return (
    <div
      class="flex flex-col items-center gap-4 rounded-xl border border-dashed border-sage-29 bg-sage-9/40 px-6 py-14 text-center"
      data-testid="recent-empty"
    >
      <span class="relative flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
        <BrandMark class="size-6 opacity-80" />
        <FolderSearchIcon class="absolute -right-2 -bottom-2 size-6 rounded-full border border-border bg-bar p-1 text-sage-67-2" />
      </span>
      <div class="flex max-w-sm flex-col gap-1.5">
        <p class="m-0 text-[13px] font-semibold text-foreground">No recent projects yet</p>
        <p class="m-0 text-[11.5px] leading-[1.6] text-muted-foreground">
          Projects you start, import or open show up here.
        </p>
      </div>
    </div>
  );
}
