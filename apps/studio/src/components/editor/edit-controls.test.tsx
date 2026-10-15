import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { HistoryButton, MergeButton, ToolSwitch } from "./edit-controls";

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

describe("MergeButton", () => {
  it("merges when the selection can be merged, and is disabled otherwise", () => {
    const onMerge = vi.fn();
    const { unmount } = render(() => <MergeButton canMerge={false} onMerge={onMerge} />);
    expect(screen.getByTestId("merge")).toBeDisabled();
    unmount();
    render(() => <MergeButton canMerge onMerge={onMerge} />);
    fireEvent.click(screen.getByTestId("merge"));
    expect(onMerge).toHaveBeenCalledTimes(1);
  });
});
