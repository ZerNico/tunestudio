import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { HistoryButton, ToolSwitch } from "./edit-controls";

describe("HistoryButton", () => {
  it("runs its action when clicked, saying what it undoes", () => {
    const onClick = vi.fn();
    render(() => (
      <HistoryButton label="Move note" action="Undo" onClick={onClick} testid="undo">
        ↶
      </HistoryButton>
    ));
    const button = screen.getByTestId("undo");
    expect(button).toHaveAccessibleName("Undo Move note");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is disabled with nothing to undo", () => {
    render(() => (
      <HistoryButton label={null} action="Redo" onClick={() => {}} testid="redo">
        ↷
      </HistoryButton>
    ));
    expect(screen.getByTestId("redo")).toBeDisabled();
  });
});

describe("ToolSwitch", () => {
  it("switches tools with a click", () => {
    const onTool = vi.fn();
    render(() => <ToolSwitch tool="select" onTool={onTool} />);
    fireEvent.click(screen.getByTestId("tool-split"));
    expect(onTool).toHaveBeenCalledWith("split");
  });
});
