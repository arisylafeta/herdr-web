import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompletionStateStore } from "./completion-state.ts";

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CompletionStateStore", () => {
  test("persists session-scoped completion timestamps and deletions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-completions-"));
    dirs.push(dir);
    const file = join(dir, "completion-state.json");
    const first = new CompletionStateStore(file);
    await first.load();
    first.forSession("default").set("p1", 123_456);

    const second = new CompletionStateStore(file);
    await second.load();
    expect(second.forSession("default").get("p1")).toBe(123_456);
    expect(second.forSession("other").get("p1")).toBeUndefined();

    second.forSession("default").delete("p1");
    const third = new CompletionStateStore(file);
    await third.load();
    expect(third.forSession("default").get("p1")).toBeUndefined();
  });

  test("keeps notification handling alive when durable storage is unavailable", async () => {
    const store = new CompletionStateStore("/dev/null/completion-state.json");
    await store.load();
    const ledger = store.forSession("default");

    expect(() => ledger.set("p1", 123_456)).not.toThrow();
    expect(ledger.get("p1")).toBe(123_456);
    expect(() => ledger.delete("p1")).not.toThrow();
  });
});
