import { describe, expect, it } from "vitest";

import { guessLyricsLanguage } from "./lyrics-language";

describe("guessLyricsLanguage", () => {
  it("tells English from German lyrics", () => {
    expect(guessLyricsLanguage("We're out walking by the sea\nYou hold the light and so do I")).toBe("en");
    expect(guessLyricsLanguage("Ich hab dich nicht vergessen\nDu bist die eine für mich")).toBe("de");
  });

  it("doesn't guess from too few words or a mix", () => {
    expect(guessLyricsLanguage("Oh oh oh")).toBeNull();
    expect(guessLyricsLanguage("Je ne regrette rien, ni le bien qu'on m'a fait")).toBeNull();
    expect(guessLyricsLanguage("I love you, ich liebe dich, you and me, du und ich")).toBeNull();
  });
});
