import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import { createTools } from "./tools";

function setup() {
  let time = 0;
  const tools = createRoot(() => createTools(() => time));
  return {
    tools,
    at: (ms: number) => void (time = ms),
    down: (key: string, repeat = false) => {
      const handled = tools.keyDown({ key, repeat });
      flush();
      return handled;
    },
    up: (key: string) => {
      tools.keyUp({ key });
      flush();
    },
  };
}

describe("tools", () => {
  it("switches on a tap of the tool's key, and stays", () => {
    const { tools, down, up, at } = setup();
    expect(tools.tool()).toBe("select");
    expect(down("d")).toBe(true);
    at(100);
    up("d");
    expect(tools.tool()).toBe("draw");
    expect(down("x")).toBe(false);
  });

  it("switches only while a held key is down", () => {
    const { tools, down, up, at } = setup();
    down("c");
    at(200);
    down("c", true);
    at(500);
    expect(tools.tool()).toBe("split");
    up("c");
    expect(tools.tool()).toBe("select");
  });

  it("goes back to the tool from before the hold", () => {
    const { tools, down, up, at } = setup();
    down("D");
    up("D");
    at(1000);
    down("c");
    at(1600);
    up("c");
    expect(tools.tool()).toBe("draw");
  });
});
