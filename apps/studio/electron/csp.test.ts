import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "./csp";

/** The policy as a map of directive to sources. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name!, sources];
    }),
  );
}

describe("contentSecurityPolicy", () => {
  it("only allows the app's own scripts and never inline or eval'd code", () => {
    for (const development of [false, true]) {
      const policy = directives(contentSecurityPolicy(development));
      expect(policy.get("script-src")).toEqual(["'self'"]);
      expect(policy.get("default-src")).toEqual(["'self'"]);
      expect(policy.get("object-src")).toEqual(["'none'"]);
      expect(policy.get("frame-src")).toEqual(["'none'"]);
      expect(policy.get("form-action")).toEqual(["'none'"]);
    }
  });

  it("opens Vite's HMR socket in development only", () => {
    expect(directives(contentSecurityPolicy(true)).get("connect-src")).toEqual([
      "'self'",
      "media:",
      "ws://localhost:*",
    ]);
    expect(directives(contentSecurityPolicy(false)).get("connect-src")).toEqual(["'self'", "media:"]);
  });

  it("declares each directive once", () => {
    const names = contentSecurityPolicy(true)
      .split(";")
      .map((part) => part.trim().split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
  });
});
