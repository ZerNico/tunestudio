import { render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { LyricsList } from "./song-lyrics";

describe("LyricsList", () => {
  it("shows every line's text, also when the chorus repeats", () => {
    const chorus = ["Du brauchst ein bisschen mehr Liebe", "Schenk dir ein bisschen mehr Liebe"];
    render(() => (
      <LyricsList
        lines={[
          { start: 33.08, text: chorus[0]! },
          { start: 36.28, text: chorus[1]! },
          { start: 46.74, text: chorus[0]! },
          { start: 49.91, text: chorus[1]! },
        ]}
      />
    ));
    const items = within(screen.getByRole("list", { name: "Lyrics" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `0:33${chorus[0]}`,
      `0:36${chorus[1]}`,
      `0:47${chorus[0]}`,
      `0:50${chorus[1]}`,
    ]);
  });
});
