/**
 * The chart's versions (the title bar's Versions button): earlier states kept in the project, automatically before the
 * first edit of a session, before large edits and every half hour, plus the ones the user saves and names. Restoring
 * one is an edit like any other (undo takes it back), and the chart from before it is kept as a version too.
 */
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import EllipsisIcon from "~icons/lucide/ellipsis";
import PencilIcon from "~icons/lucide/pencil";
import Trash2Icon from "~icons/lucide/trash-2";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { formatNumber, formatRelativeTime } from "~/lib/format";
import type { ChartVersion } from "~/lib/native/types";

export interface VersionActions {
  /** The versions, newest first. */
  list: () => Promise<readonly ChartVersion[]>;
  /** Keeps the chart as it is now, named `name`. */
  save: (name: string) => Promise<void>;
  restore: (version: ChartVersion) => Promise<void>;
  rename: (version: ChartVersion, name: string) => Promise<void>;
  remove: (version: ChartVersion) => Promise<void>;
  onError: (title: string, error: unknown) => void;
}

const plural = (count: number, word: string) => `${formatNumber(count)} ${word}${count === 1 ? "" : "s"}`;

/** A version's name, edited in place: Enter or leaving the field keeps it, Esc doesn't. */
function NameField(props: { value: string; onDone: (name: string | null) => void }) {
  let done = false;
  const finish = (name: string | null) => {
    if (done) return;
    done = true;
    props.onDone(name);
  };
  return (
    <Input
      value={props.value}
      aria-label="Version name"
      maxlength={100}
      ref={(element) => queueMicrotask(() => element.select())}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value.trim() || null);
        else if (event.key === "Escape") {
          // The dialog would close on Esc too.
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
      data-testid="version-name"
    />
  );
}

function VersionRow(props: {
  version: ChartVersion;
  actions: VersionActions;
  /** Another row's action is under way: one at a time, or two restores could follow each other. */
  busy: boolean;
  /** Runs the row's action, saying when it failed, then lists the versions again. */
  run: (title: string, work: () => Promise<void>) => Promise<void>;
}) {
  const [renaming, setRenaming] = createSignal(false);
  return (
    <li class="flex items-center gap-3 border-b border-popover-line py-2.5 last:border-b-0" data-testid="version">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <Show
          when={renaming()}
          fallback={
            <span
              class="truncate text-[12px] data-[kind=auto]:text-sage-73 data-[kind=named]:font-medium data-[kind=named]:text-foreground"
              data-kind={props.version.kind}
            >
              {props.version.label}
            </span>
          }
        >
          <NameField
            value={props.version.label}
            onDone={(name) => {
              setRenaming(false);
              // Naming an automatic version keeps it, even under the name it had.
              if (name && (name !== props.version.label || props.version.kind === "auto")) {
                void props.run("Couldn't rename the version", () => props.actions.rename(props.version, name));
              }
            }}
          />
        </Show>
        <span class="text-[11px] text-muted-foreground">
          {formatRelativeTime(props.version.createdAt)} · {plural(props.version.notes, "note")},{" "}
          {plural(props.version.lines, "line")}
        </span>
      </div>
      <Button
        variant="outline"
        size="xs"
        disabled={props.busy}
        onClick={() => void props.run("Couldn't restore the version", () => props.actions.restore(props.version))}
        data-testid="restore-version"
      >
        Restore
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
            <Button
              {...triggerProps}
              variant="ghost"
              size="icon-sm"
              aria-label={`More for “${props.version.label}”`}
              disabled={props.busy}
            >
              <EllipsisIcon />
            </Button>
          )}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <PencilIcon />
            {props.version.kind === "named" ? "Rename" : "Name and keep"}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => void props.run("Couldn't delete the version", () => props.actions.remove(props.version))}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function VersionsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: VersionActions;
}) {
  const [versions, setVersions] = createSignal<readonly ChartVersion[] | null>(null);
  const [name, setName] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const refresh = async () => {
    try {
      setVersions(await props.actions.list());
    } catch (error) {
      props.actions.onError("Couldn't read the versions", error);
    }
  };
  createEffect(
    () => props.open,
    (open) => {
      if (open) void refresh();
    },
  );
  const run = async (title: string, work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      props.actions.onError(title, error);
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const save = async () => {
    const trimmed = name().trim();
    if (!trimmed || saving()) return;
    setSaving(true);
    try {
      await props.actions.save(trimmed);
      setName("");
      await refresh();
    } catch (error) {
      props.actions.onError("Couldn't save the version", error);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <DialogContent class="w-[min(520px,calc(100vw-32px))]" data-testid="versions">
        <DialogHeader>
          <DialogTitle>Versions</DialogTitle>
          <DialogDescription>
            Earlier states of the chart, kept in the project: before you start editing, before large edits and every
            half hour. Name one to keep it for good. Restoring can be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Input
              value={name()}
              placeholder="Name the chart as it is now"
              aria-label="New version's name"
              maxlength={100}
              onInput={(event) => setName(event.currentTarget.value)}
              data-testid="new-version-name"
            />
            <Button type="submit" size="sm" disabled={!name().trim() || saving()} data-testid="save-version">
              Save version
            </Button>
          </form>
          <Show when={versions()}>
            {(list) => (
              <Show
                when={list().length > 0}
                fallback={
                  <p class="m-0 text-[11px] text-muted-foreground" data-testid="no-versions">
                    No versions yet. The first is kept when you start editing.
                  </p>
                }
              >
                <ul class="m-0 flex list-none flex-col p-0">
                  <For each={list()}>
                    {(version) => (
                      <VersionRow
                        version={version}
                        actions={{
                          ...props.actions,
                          // A restored version closes the dialog: the chart behind it is what the user wants to see.
                          restore: async (chosen) => {
                            await props.actions.restore(chosen);
                            props.onOpenChange(false);
                          },
                        }}
                        busy={busy()}
                        run={run}
                      />
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Show>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
