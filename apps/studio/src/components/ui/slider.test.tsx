import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import { Slider } from "./slider";

describe("Slider", () => {
  it("keeps its thumb as a controlled value changes, so the keys go on from the new value", () => {
    const [value, setValue] = createSignal(50);
    render(() => (
      <Slider
        min={0}
        max={100}
        value={value()}
        getAriaLabel={() => "Volume"}
        onValueChange={(next: number | readonly number[]) => setValue(typeof next === "number" ? next : next[0]!)}
      />
    ));
    const thumb = screen.getByLabelText("Volume");
    setValue(20);
    flush();
    expect(screen.getByLabelText("Volume")).toBe(thumb);
    expect(thumb).toHaveAttribute("aria-valuenow", "20");
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    flush();
    expect(thumb).toHaveAttribute("aria-valuenow", "19");
  });
});
