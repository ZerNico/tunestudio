import type { JSX } from "@solidjs/web";
import { useRouter } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";
import PlusIcon from "~icons/lucide/plus";

import { Section } from "~/components/settings/section";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { toastError } from "~/components/ui/toast";
import { GAME_NAMES, type Game } from "~/lib/games";
import { native } from "~/lib/native/client";
import type { GamesStatus, GameStatus } from "~/lib/native/types";

/**
 * The settings' Games section: the games a song can be tried in (found where they are usually installed, or chosen)
 * and a way to add one from somewhere else. Main keeps the paths (`games.*`); the settings screen only shows them.
 * `#games` scrolls here.
 */
export function GamesSection() {
  const router = useRouter();
  // Looked up once, then replaced by each choice's answer. null until the first lookup lands, or if it fails.
  const [status, setStatus] = createSignal<GamesStatus | null>(
    () =>
      native.games.status().catch((error: unknown) => {
        toastError("Couldn't look for the games", error);
        return null;
      }),
    { loadingValue: null },
  );
  const [busy, setBusy] = createSignal(false);

  const run = async (title: string, call: () => Promise<GamesStatus>) => {
    setBusy(true);
    try {
      setStatus(await call());
    } catch (error) {
      toastError(title, error);
    } finally {
      setBusy(false);
    }
  };
  const choose = (game: Game) => void run("Couldn't use this app", () => native.games.choose({ game }));

  onSettled(() => {
    if (router.state.location.hash === "games")
      document.getElementById("games-title")?.scrollIntoView({ block: "start" });
  });

  /** The games with an app: found, chosen, or chosen and not startable anymore (so it can be fixed or cleared). */
  const listed = () => status()?.games.filter((entry) => entry.chosen !== null || entry.found !== null) ?? [];
  /** The games that can be added. */
  const missing = () =>
    status()
      ?.games.filter((entry) => entry.chosen === null && entry.found === null)
      .map((entry) => entry.game) ?? [];

  return (
    <Section
      id="games"
      title="Games"
      description="Try in game exports the song and opens it in a karaoke game. Games in the usual places are found by themselves. Add one that is somewhere else."
    >
      <Show when={status()}>
        <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
          <For
            each={listed()}
            fallback={
              <p class="m-0 px-4 py-3 text-[12px] text-muted-foreground" data-testid="games-empty">
                No games found. Add one to try songs in it.
              </p>
            }
          >
            {(entry) => (
              <GameRow
                status={entry}
                disabled={busy()}
                onChoose={() => choose(entry.game)}
                onClear={() => void run("Couldn't save the settings", () => native.games.clear({ game: entry.game }))}
              />
            )}
          </For>
        </div>
        <Show when={missing().length > 0}>
          <AddGame games={missing()} disabled={busy()} onChoose={choose} />
        </Show>
      </Show>
    </Section>
  );
}

/** "Add a game…": a menu of the games not there, each asking main for its app. */
function AddGame(props: { games: readonly Game[]; disabled: boolean; onChoose: (game: Game) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={props.disabled}
        render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
          <Button variant="outline" size="sm" class="self-start" {...triggerProps} data-testid="games-add">
            <PlusIcon />
            Add a game…
          </Button>
        )}
      />
      <DropdownMenuContent align="start" data-testid="games-add-menu">
        <For each={props.games}>
          {(game) => (
            <DropdownMenuItem onClick={() => props.onChoose(game)} data-testid={`games-add-${game}`}>
              {GAME_NAMES[game]}…
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GameRow(props: { status: GameStatus; disabled: boolean; onChoose: () => void; onClear: () => void }) {
  const id = () => `game-${props.status.game}`;
  const name = () => GAME_NAMES[props.status.game];
  /** Where the game is, or why it can't be started. */
  const where = () => {
    const status = props.status;
    if (status.chosen && status.found === status.chosen) return status.chosen;
    if (status.chosen) return `Can't be started from ${status.chosen}`;
    return `Found at ${status.found}`;
  };
  return (
    <div class="flex items-center gap-6 px-4 py-3" data-testid={id()}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={id()} class="text-[12.5px] font-medium text-foreground">
          {name()}
        </span>
        <p
          class="m-0 truncate text-[11px] leading-normal text-muted-foreground"
          title={props.status.chosen ?? props.status.found ?? undefined}
          data-testid={`${id()}-path`}
        >
          {where()}
        </p>
      </div>
      <div class="flex shrink-0 gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled}
          aria-label={`Choose ${name()}`}
          onClick={() => props.onChoose()}
          data-testid={`${id()}-choose`}
        >
          Choose…
        </Button>
        <Show when={props.status.chosen}>
          <Button
            variant="outline"
            size="sm"
            disabled={props.disabled}
            aria-label={`Clear ${name()}`}
            onClick={() => props.onClear()}
            data-testid={`${id()}-clear`}
          >
            Clear
          </Button>
        </Show>
      </div>
    </div>
  );
}
