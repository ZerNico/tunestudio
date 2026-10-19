import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import ChevronRightIcon from "~icons/lucide/chevron-right";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import SearchIcon from "~icons/lucide/search";
import XIcon from "~icons/lucide/x";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Note } from "~/components/ui/note";
import { toastError } from "~/components/ui/toast";
import { chromeVersion } from "~/lib/desktop";
import { DOWNLOADED_TOOLS, loadNotices, matchesQuery, type Notice, type Notices } from "~/lib/licenses";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";

/**
 * The open source licenses of everything Tune Studio is built with, grouped by where it comes from. Each entry opens
 * to its notice text, which is only rendered while it is open, so hundreds of entries stay quick.
 */
export function LicensesDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowModels: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <DialogContent class="w-[min(760px,calc(100vw-32px))]" data-testid="licenses">
        <LicensesView onShowModels={props.onShowModels} />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's content, mounted while it is open: the notices load the first time it opens. */
function LicensesView(props: { onShowModels: () => void }) {
  const [query, setQuery] = createSignal("");
  // Loads when the dialog first opens. Try again recomputes it.
  const notices = createMemo(() => loadNotices());

  return (
    <>
      <DialogHeader>
        <DialogTitle>Open source licenses</DialogTitle>
        <DialogDescription>
          Tune Studio is built with these libraries and tools. Open one to read its license.
        </DialogDescription>
        <InputGroup class="mt-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            placeholder="Search by name or license"
            aria-label="Search licenses"
            value={query()}
            data-testid="licenses-search"
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Esc clears the search first, then closes the dialog.
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
      </DialogHeader>
      <DialogBody>
        <div class="flex flex-col gap-7">
          <Errored
            fallback={(error, retry) => (
              <div class="flex flex-col items-start gap-3">
                <Note tone="error" testid="licenses-error">
                  Couldn't load the licenses. {errorMessage(error())}
                </Note>
                <Button variant="outline" size="sm" onClick={retry}>
                  Try again
                </Button>
              </div>
            )}
          >
            <Loading
              fallback={
                <p class="m-0 flex items-center gap-2 text-[11.5px] text-muted-foreground" aria-live="polite">
                  <LoaderCircleIcon class="size-4 animate-spin text-primary" />
                  Loading the licenses…
                </p>
              }
            >
              <NoticeGroups notices={notices()} query={query()} onShowModels={props.onShowModels} />
            </Loading>
          </Errored>
        </div>
      </DialogBody>
    </>
  );
}

function NoticeGroups(props: { notices: Notices; query: string; onShowModels: () => void }) {
  const javascript = createMemo(() => props.notices.javascript.filter((entry) => matchesQuery(entry, props.query)));
  const nativeLibraries = createMemo(() =>
    [...props.notices.libraries, ...props.notices.crates].filter((entry) => matchesQuery(entry, props.query)),
  );
  const tools = createMemo(() => DOWNLOADED_TOOLS.filter((tool) => matchesQuery(tool, props.query)));
  const electron = createMemo(() => {
    const entry = props.notices.electron;
    return entry && matchesQuery(entry, props.query) ? entry : null;
  });
  const chromium = () => matchesQuery({ name: "Chromium", license: CHROMIUM_LICENSE }, props.query);
  const searching = () => props.query.trim() !== "";
  const nothing = () =>
    javascript().length + nativeLibraries().length + tools().length === 0 && !electron() && !chromium() && searching();
  const text = (entry: Notice) => props.notices.texts[entry.text] ?? "";

  return (
    <>
      <Show when={!props.notices.generated}>
        <Note tone="warning" testid="licenses-not-built">
          The list is made when the app is built. Run bun run build to see it here.
        </Note>
      </Show>
      <Show when={nothing()}>
        <p class="m-0 text-[12px] text-muted-foreground">No licenses match “{props.query.trim()}”.</p>
      </Show>

      <Show when={javascript().length > 0}>
        <Group id="licenses-javascript" title="App libraries" count={javascript().length}>
          <For each={javascript()}>{(entry) => <NoticeRow notice={entry} text={text(entry)} />}</For>
        </Group>
      </Show>

      <Show when={nativeLibraries().length > 0}>
        <Group
          id="licenses-native"
          title="Native libraries"
          count={nativeLibraries().length}
          description="Rust crates and C and C++ libraries in the part of the app that runs the models."
        >
          <For each={nativeLibraries()}>{(entry) => <NoticeRow notice={entry} text={text(entry)} />}</For>
        </Group>
      </Show>

      <Show when={tools().length > 0}>
        <Group
          id="licenses-tools"
          title="Downloaded tools"
          count={tools().length}
          description="Downloaded the first time a feature needs them. They aren't part of the app and run as their own programs."
        >
          <For each={tools()}>
            {(tool) => (
              <li class="flex flex-col gap-1 px-3 py-2.5" data-testid="licenses-tool">
                <div class="flex items-baseline gap-3">
                  <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{tool.name}</span>
                  <span class="shrink-0 font-mono text-[10.5px] text-muted-foreground">{tool.license}</span>
                </div>
                <p class="m-0 text-[11px] leading-normal text-muted-foreground">
                  {tool.about}{" "}
                  <a href={tool.url} target="_blank" rel="noreferrer" class={LINK}>
                    {tool.url.replace(/^https:\/\//, "")}
                  </a>
                </p>
              </li>
            )}
          </For>
        </Group>
      </Show>

      <Show when={!searching()}>
        <section aria-labelledby="licenses-models-title" class="flex flex-col gap-2">
          <h3 id="licenses-models-title" class="m-0 eyebrow">
            Models
          </h3>
          <div class="flex items-center gap-4 rounded-[10px] border border-border bg-card px-3 py-2.5">
            <p class="m-0 flex-1 text-[11px] leading-normal text-muted-foreground">
              Models are downloaded when a feature first needs them. Settings lists each with its version and license.
            </p>
            <Button variant="outline" size="sm" onClick={() => props.onShowModels()} data-testid="licenses-models">
              Show models
            </Button>
          </div>
        </section>
      </Show>

      <Show when={electron() || chromium()}>
        <Group id="licenses-electron" title="Electron and Chromium">
          <Show when={electron()}>{(entry) => <NoticeRow notice={entry()} text={text(entry())} />}</Show>
          <Show when={chromium()}>
            <li class="flex items-center gap-3 px-3 py-2" data-testid="licenses-chromium">
              <span class="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">Chromium</span>
              <Show when={chromeVersion}>
                <span class="shrink-0 font-mono text-[10.5px] text-muted-foreground">{chromeVersion}</span>
              </Show>
              <span class="w-40 shrink-0 truncate text-right font-mono text-[10.5px] text-muted-foreground">
                {CHROMIUM_LICENSE}
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  native.app.openChromiumLicenses().catch((error: unknown) => {
                    toastError("Couldn't open Chromium's licenses", error);
                  })
                }
                data-testid="licenses-chromium-open"
              >
                Open in browser
              </Button>
            </li>
          </Show>
        </Group>
      </Show>
    </>
  );
}

const CHROMIUM_LICENSE = "BSD-3-Clause and others";

const LINK = "text-sage-73 underline-offset-2 hover:text-primary hover:underline";

function Group(props: { id: string; title: string; count?: number; description?: string; children: JSX.Element }) {
  return (
    <section aria-labelledby={`${props.id}-title`} class="flex flex-col gap-2" data-testid={props.id}>
      <div class="flex flex-col gap-1">
        <h3 id={`${props.id}-title`} class="m-0 eyebrow">
          {props.title}
          <Show when={props.count !== undefined}> ({props.count})</Show>
        </h3>
        <Show when={props.description}>
          <p class="m-0 text-[11px] leading-normal text-muted-foreground">{props.description}</p>
        </Show>
      </div>
      <ul class="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-[10px] border border-border bg-card p-0">
        {props.children}
      </ul>
    </section>
  );
}

/** A library: name, version and license, opening to its link and notice text. */
function NoticeRow(props: { notice: Notice; text: string }) {
  const [open, setOpen] = createSignal(false);
  const id = () => `notice-${props.notice.name}-${props.notice.version ?? ""}`.replaceAll(/[^\w-]/g, "-");
  return (
    <li data-testid="licenses-entry">
      <button
        type="button"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id()}
        onClick={() => setOpen(!open())}
        class="group flex w-full cursor-pointer items-center gap-3 bg-transparent px-3 py-2 text-left text-foreground hover:bg-muted"
      >
        <ChevronRightIcon class="size-3 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-90" />
        <span class="min-w-0 flex-1 truncate text-[12px] font-medium">{props.notice.name}</span>
        <Show when={props.notice.version}>
          <span class="shrink-0 font-mono text-[10.5px] text-muted-foreground">{props.notice.version}</span>
        </Show>
        <span
          class="w-40 shrink-0 truncate text-right font-mono text-[10.5px] text-muted-foreground"
          title={props.notice.license}
        >
          {props.notice.license}
        </span>
      </button>
      <Show when={open()}>
        <div id={id()} class="flex flex-col gap-2 px-3 pt-1 pb-3 pl-9">
          <Show when={props.notice.url}>
            {(url) => (
              <a href={url()} target="_blank" rel="noreferrer" class={`self-start text-[11px] ${LINK}`}>
                {url().replace(/^https?:\/\//, "")}
              </a>
            )}
          </Show>
          <pre
            class="m-0 max-h-80 scrollbar-thin overflow-auto rounded-lg bg-muted/40 px-3 py-2 font-mono text-[10.5px] leading-[1.6] whitespace-pre-wrap text-muted-foreground"
            data-testid="licenses-text"
          >
            {props.text}
          </pre>
        </div>
      </Show>
    </li>
  );
}
