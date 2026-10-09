import { describe, expect, it } from "vitest";
import { anchoredScrollTop, isTranscriptNearBottom, transcriptScrollTop } from "./transcriptFollow";

describe("transcript follow", () => {
  it("follows only within the sixty-pixel bottom boundary", () => {
    expect(isTranscriptNearBottom({ scrollTop: 640, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(isTranscriptNearBottom({ scrollTop: 639, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
  });
  it("preserves the reader's anchor as earlier history changes height", () => {
    expect(anchoredScrollTop({ scrollTop: 120, scrollHeight: 1000 }, 1450)).toBe(570);
    expect(transcriptScrollTop({ scrollTop: 120, scrollHeight: 1450, clientHeight: 300 }, true, { scrollTop: 120, scrollHeight: 1000 })).toBe(570);
  });
  it("follows image growth without stealing an upward position", () => {
    const metrics = { scrollTop: 120, scrollHeight: 1450, clientHeight: 300 };
    expect(transcriptScrollTop(metrics, false)).toBe(120);
    expect(transcriptScrollTop(metrics, true)).toBe(1150);
    expect(transcriptScrollTop({ scrollTop: 0, scrollHeight: 100, clientHeight: 300 }, true)).toBe(0);
  });
});
