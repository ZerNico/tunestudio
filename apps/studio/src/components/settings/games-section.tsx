import { useRouter } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toastError } from "~/components/ui/toast";
import { GAME_NAMES, GAMES, type Game } from "~/lib/games";
import { native } from "~/lib/native/client";
import type { GamesStatus, GameStatus } from "~/lib/native/types";

const GAME_OPTIONS = GAMES.map((game) => ({ value: game, label: GAME_NAMES[game] }));

/**
 * The settings' Games section: where each game is (chosen, or found where it is usually installed) and which one "Try
 * in game" opens. Main keeps the paths (`games.*`); the settings screen only shows them. `#games` scrolls here.
 */
export function GamesSection() {
  const router = useRouter();
  const [status, setStatus] = createSignal<GamesStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  let section: HTMLElement | undefined;

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

  onSettled(() => {
    native.games.status().then(setStatus, (error: unknown) => toastError("Couldn't look for the games", error));
    if (router.state.location.hash === "games") section?.scrollIntoView({ block: "start" });
  });

  const entry = (game: Game) => status()?.games.find((item) => item.game === game);

  return (
    <section
      ref={(element) => (section = element)}
      id="games"
      aria-labelledby="games-title"
      class="flex flex-col gap-4"
      data-testid="settings-games"
    >
      <div class="flex flex-col gap-1">
        <h2 id="games-title" class="m-0 text-[15px] font-semibold tracking-[-0.2px]">
          Games
        </h2>
        <p class="m-0 text-[12px] leading-[1.6] text-muted-foreground">
          Try in game exports the song and opens it in a karaoke game. Games in the usual places are found by
          themselves.
        </p>
      </div>
      <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
        <div class="flex items-center gap-6 px-4 py-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span id="games-try-with" class="text-[12.5px] font-medium text-foreground">
              Try in game opens
            </span>
          </div>
          <Select
            items={GAME_OPTIONS}
            value={status()?.tryWith ?? "tune-perfect"}
            disabled={status() === null || busy()}
            onValueChange={(game: Game | null) => {
              if (game) void run("Couldn't save the settings", () => native.games.use({ game }));
            }}
          >
            <SelectTrigger class="w-44 shrink-0" aria-labelledby="games-try-with" data-testid="games-try-with">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <For each={GAME_OPTIONS}>{(option) => <SelectItem value={option.value}>{option.label}</SelectItem>}</For>
            </SelectContent>
          </Select>
        </div>
        <For each={GAMES}>
          {(game) => (
            <GameRow
              game={game}
              status={entry(game)}
              disabled={status() === null || busy()}
              onChoose={() => void run("Couldn't use this app", () => native.games.choose({ game }))}
              onClear={() => void run("Couldn't save the settings", () => native.games.clear({ game }))}
            />
          )}
        </For>
      </div>
    </section>
  );
}

function GameRow(props: {
  game: Game;
  status: GameStatus | undefined;
  disabled: boolean;
  onChoose: () => void;
  onClear: () => void;
}) {
  const id = () => `game-${props.game}`;
  /** Where the game is, or why it can't be started. */
  const where = () => {
    const status = props.status;
    if (!status) return "";
    if (status.chosen && status.found === status.chosen) return status.chosen;
    if (status.chosen) return `Can't be started from ${status.chosen}`;
    if (status.found) return `Found at ${status.found}`;
    return "Not set";
  };
  return (
    <div class="flex items-center gap-6 px-4 py-3" data-testid={id()}>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={id()} class="text-[12.5px] font-medium text-foreground">
          {GAME_NAMES[props.game]}
        </span>
        <p
          class="m-0 truncate text-[11px] leading-normal text-muted-foreground"
          title={props.status?.chosen ?? props.status?.found ?? undefined}
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
          aria-label={`Choose ${GAME_NAMES[props.game]}`}
          onClick={() => props.onChoose()}
          data-testid={`${id()}-choose`}
        >
          Choose…
        </Button>
        <Show when={props.status?.chosen}>
          <Button
            variant="outline"
            size="sm"
            disabled={props.disabled}
            aria-label={`Clear ${GAME_NAMES[props.game]}`}
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
