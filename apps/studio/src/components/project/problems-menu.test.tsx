import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ChartProblem } from "~/lib/editor/checks";

import { ProblemsMenu } from "./problems-menu";

const PROBLEMS: ChartProblem[] = [
  { key: "overlap:1", message: "Notes overlap", noteIds: [1, 2], start: 12.4, end: 13 },
  { key: "empty:7", message: "Empty syllable", noteIds: [7], start: 64.25, end: 64.5 },
];

describe("ProblemsMenu", () => {
  it("shows a check mark while nothing is wrong", () => {
    render(() => <ProblemsMenu problems={[]} onShow={() => {}} />);
    expect(screen.getByTestId("problems")).toHaveAccessibleName("No problems found");
  });

  it("counts the problems, lists them by time, and shows the one chosen", async () => {
    const onShow = vi.fn();
    render(() => <ProblemsMenu problems={PROBLEMS} onShow={onShow} />);
    const user = userEvent.setup();
    expect(screen.getByTestId("problems")).toHaveTextContent("2");
    await user.click(screen.getByTestId("problems"));
    const items = await screen.findAllByTestId("problem");
    expect(items.map((item) => item.textContent)).toEqual(["Notes overlap0:12.4", "Empty syllable1:04.2"]);
    await user.click(items[1]!);
    expect(onShow).toHaveBeenCalledWith(PROBLEMS[1]);
  });
});
