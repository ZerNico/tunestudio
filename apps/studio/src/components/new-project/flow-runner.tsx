import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled, Show } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "~/components/ui/dialog";

/**
 * One stage of a new project, as the dialog's header lists it. Its primary button moves on, after running the stage's
 * job if it has one (downloading the song, making the chart, saving); Back stops a running job, else goes back a stage.
 */
export interface Stage {
  id: string;
  /** The stage's name in the header. */
  tag: string;
  body: () => JSX.Element;
  /** The primary button's label; "Next" by default. */
  primary?: string;
  /** Whether the primary button can be pressed. */
  canAdvance: () => boolean;
  /**
   * The stage's job, run when the primary button is pressed: resolves true to move on, false to stay (it failed and
   * says why, or was stopped). `signal` aborts when Back is pressed or the dialog closes.
   */
  run?: (signal: AbortSignal) => Promise<boolean>;
  /** Whether Back stops the job (true by default). */
  stoppable?: boolean;
  /** Called each time the stage is shown. */
  enter?: () => void;
}

/** A row of stages, one shown at a time. */
export function createFlow(stages: readonly Stage[]) {
  const [index, setIndex] = createSignal(0);
  const [running, setRunning] = createSignal(false);
  let controller: AbortController | undefined;

  const show = (next: number) => {
    setIndex(next);
    stages[next]?.enter?.();
  };
  const stop = () => controller?.abort();

  return {
    stages,
    index,
    current: () => stages[index()]!,
    /** A job is running. */
    running,
    /** A job that can't be stopped is running (saving): the dialog stays open until it's done. */
    locked: () => running() && stages[index()]!.stoppable === false,
    back: () => {
      if (running()) stop();
      else if (index() > 0) show(index() - 1);
    },
    advance: async () => {
      const stage = stages[index()]!;
      if (running() || !stage.canAdvance()) return;
      if (!stage.run) {
        if (index() < stages.length - 1) show(index() + 1);
        return;
      }
      const current = new AbortController();
      controller = current;
      setRunning(true);
      let done = false;
      try {
        done = await stage.run(current.signal);
      } finally {
        if (controller === current) controller = undefined;
        setRunning(false);
      }
      if (done && !current.signal.aborted && stage === stages[index()] && index() < stages.length - 1) {
        show(index() + 1);
      }
    },
    stop,
    /** Shows the first stage. */
    start: () => show(0),
  };
}

export type Flow = ReturnType<typeof createFlow>;

/** The dialog's body and footer for a flow: the current stage, Back, Cancel and the stage's primary button. */
export function FlowView(props: {
  flow: Flow;
  header: (index: number) => JSX.Element;
  /** False once the dialog closes: a running job stops. */
  open: boolean;
  /** The body is busy beyond a running job (looking something up). */
  busy?: boolean;
  /** Shown above every stage: what the project is made from. */
  source?: JSX.Element;
  /** Whether the dialog may close now: not while a job that can't be stopped runs. */
  onLockedChange?: (locked: boolean) => void;
}) {
  onSettled(() => () => props.flow.stop());
  createEffect(
    () => props.flow.locked(),
    (locked) => {
      props.onLockedChange?.(locked);
    },
  );
  createEffect(
    () => props.open,
    (open) => {
      if (!open) props.flow.stop();
    },
  );
  const stage = () => props.flow.current();
  let next: HTMLButtonElement | undefined;
  return (
    <>
      {props.header(props.flow.index())}
      <DialogBody aria-busy={props.flow.running() || props.busy ? "true" : "false"} data-stage={stage().id}>
        {props.source}
        {stage().body()}
      </DialogBody>
      <DialogFooter class="items-center">
        <Show when={props.flow.running() ? stage().stoppable !== false : props.flow.index() > 0}>
          <Button
            variant="outline"
            class="mr-auto"
            onClick={() => {
              props.flow.back();
              // Back to the first stage, this button goes: the keyboard's place moves to the primary one.
              if (props.flow.index() === 0) queueMicrotask(() => next?.focus());
            }}
            data-testid="flow-back"
          >
            Back
          </Button>
        </Show>
        <DialogClose
          disabled={props.flow.locked()}
          render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => <Button variant="outline" {...closeProps} />}
        >
          Cancel
        </DialogClose>
        {/* Pressed, it stays focusable while the stage runs: keyboard and screen readers keep their place. */}
        <Button
          ref={(element: HTMLButtonElement) => (next = element)}
          disabled={props.flow.running() || !stage().canAdvance()}
          focusableWhenDisabled={props.flow.running()}
          onClick={() => void props.flow.advance()}
          data-testid="flow-next"
        >
          <Show when={props.flow.running()}>
            <LoaderCircleIcon class="animate-spin" />
          </Show>
          {stage().primary ?? "Next"}
        </Button>
      </DialogFooter>
    </>
  );
}
