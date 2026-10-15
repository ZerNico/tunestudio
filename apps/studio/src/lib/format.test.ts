import { describe, expect, it } from "vitest";

import { formatDuration, formatFileSize, formatNumber, formatRelativeTime, formatSeconds } from "./format";

const now = Date.parse("2026-10-14T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

describe("formatRelativeTime", () => {
  it("says just now under a minute, in either direction", () => {
    expect(formatRelativeTime(ago(0), now)).toBe("Just now");
    expect(formatRelativeTime(ago(59), now)).toBe("Just now");
    expect(formatRelativeTime(ago(-30), now)).toBe("Just now");
  });

  it("picks the largest unit that fits and capitalizes the phrase", () => {
    expect(formatRelativeTime(ago(60), now)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(12 * 60), now)).toBe("12 minutes ago");
    expect(formatRelativeTime(ago(3 * 3600), now)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(24 * 3600), now)).toBe("Yesterday");
    expect(formatRelativeTime(ago(3 * 86400), now)).toBe("3 days ago");
    expect(formatRelativeTime(ago(7 * 86400), now)).toBe("Last week");
    expect(formatRelativeTime(ago(21 * 86400), now)).toBe("3 weeks ago");
  });

  it("switches to a date from two months on, with the year only when it differs", () => {
    expect(formatRelativeTime("2026-08-01T12:00:00Z", now)).toBe("Aug 1");
    expect(formatRelativeTime("2025-12-24T12:00:00Z", now)).toBe("Dec 24, 2025");
  });
});

describe("formatFileSize", () => {
  it("keeps bytes whole and gives one decimal below 10 of a unit", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(4.2 * 1024 * 1024)).toBe("4.2 MB");
    expect(formatFileSize(512 * 1024 * 1024)).toBe("512 MB");
  });

  it("stops at gigabytes", () => {
    expect(formatFileSize(3 * 1024 ** 4)).toBe("3072 GB");
  });
});

describe("formatDuration", () => {
  it("shows minutes and seconds, and hours once there are any", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(221.4)).toBe("3:41");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(-3)).toBe("0:00");
  });
});

describe("formatSeconds and formatNumber", () => {
  it("drop float noise", () => {
    expect(formatSeconds(1.2505000000000002)).toBe("1.251 s");
    expect(formatSeconds(-0.5)).toBe("-0.5 s");
    expect(formatNumber(312.5)).toBe("312.5");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
  });
});
