import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveTranscriptStatus, estimateTranscriptContext } from "./transcript-status";
import type { TranscriptStatus } from "./transcript-types";
import { readWorkspaceGitSummary } from "./workspace-inspection";

const ts = "2026-10-11T13:00:00.000Z";
const assistant = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", usage, ...extra } });

describe("disk transcript status", () => {
  test("native git counts pair exact renames but count edited moves as add plus delete", async () => {
    const repo = await mkdtemp(join(tmpdir(), "herdr-rename-status-"));
    try {
      await Bun.$`git init -q ${repo}`.quiet();
      const content = Array.from({ length: 100 }, (_, i) => `example line ${i}`).join("\n") + "\n";
      await writeFile(join(repo, "exact.txt"), content);
      await writeFile(join(repo, "edited.txt"), content + "different original ending\n");
      await Bun.$`git -C ${repo} add exact.txt edited.txt`.quiet();
      await Bun.$`git -C ${repo} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial`.quiet();
      await Bun.$`git -C ${repo} mv exact.txt exact-moved.txt`.quiet();
      await Bun.$`git -C ${repo} mv edited.txt edited-moved.txt`.quiet();
      await writeFile(join(repo, "edited-moved.txt"), content + "changed ending\n");
      await Bun.$`git -C ${repo} add edited-moved.txt`.quiet();
      expect(await readWorkspaceGitSummary(repo)).toMatchObject({ staged: 3, unstaged: 0, untracked: 0 });
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
  test("submodule dirtiness is counted without executing nested clean filters", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-submodule-status-"));
    const source = join(root, "source"), parent = join(root, "parent"), marker = join(root, "executed");
    try {
      for (const path of [source, parent]) {
        await mkdir(path);
        await Bun.$`git init -q ${path}`.quiet();
      }
      await writeFile(join(source, "tracked"), "before");
      await Bun.$`git -C ${source} add tracked`.quiet();
      await Bun.$`git -C ${source} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial`.quiet();
      await Bun.$`git -C ${parent} -c protocol.file.allow=always submodule add -q ${source} sub`.quiet();
      await Bun.$`git -C ${parent} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm sub`.quiet();
      const sub = join(parent, "sub");
      await Bun.$`git -C ${sub} config filter.probe.clean ${`sh -c "echo executed >> ${marker}; cat"`}`.quiet();
      await writeFile(join(sub, ".gitattributes"), "tracked filter=probe\n");
      await writeFile(join(sub, "tracked"), "alter!");
      expect(await readWorkspaceGitSummary(parent)).toMatchObject({ staged: 0, unstaged: 1, untracked: 0 });
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("uses active model, effort and mode changes without treating side usage as a switch", async () => {
    const status = await deriveTranscriptStatus([
      { type: "model_change", model: "missing-provider/first" },
      { type: "message", message: { role: "assistant", provider: "missing-provider", model: "second" } },
      { type: "model_usage", provider: "judge", model: "not-active" },
      { type: "thinking_level_change", thinkingLevel: "high", configured: "auto" },
      { type: "mode_change", mode: "vibe" },
      { type: "service_tier_change", serviceTier: "fast" },
      { type: "service_tier_change", serviceTier: null },
    ], "idle", ts);
    expect(status.model).toEqual({ id: "second", name: "second", provider: "missing-provider" });
    expect(status.thinking).toBe("high");
    expect(status.mode).toBe("vibe");
    expect(status.serviceTier).toBeUndefined();
    expect(status.context).toBeUndefined();
    expect(status.freshness).toEqual({ fileUpdatedAt: ts });
  });

  test("pairs starts with results, prefers newest unresolved activity, and clears inactive work", async () => {
    const entries = [
      { type: "message", timestamp: ts, message: { role: "user", content: "go" } },
      { type: "custom", customType: "tool_execution_start", data: { toolCallId: "a", toolName: "read", startedAt: ts, intent: "Read source" } },
      { type: "custom", customType: "tool_execution_start", data: { toolCallId: "b", toolName: "wait", startedAt: ts, intent: "Wait for audit" } },
      { type: "message", message: { role: "toolResult", toolCallId: "b" } },
    ];
    const working = await deriveTranscriptStatus(entries, "working", ts);
    expect(working.activity?.label).toBe("Read source");
    expect(working.turnStartedAt).toBe(ts);
    expect((await deriveTranscriptStatus(entries, "idle", ts)).activity).toBeUndefined();
    expect((await deriveTranscriptStatus(entries, "done", ts)).turnStartedAt).toBeUndefined();
    expect((await deriveTranscriptStatus([...entries, { type: "custom", customType: "session_exit" }], "working", ts)).activity).toBeUndefined();
    const retry = await deriveTranscriptStatus([...entries,
      { type: "message", message: { role: "toolResult", toolCallId: "a" } },
      { type: "custom", customType: "tool_execution_start", data: { toolCallId: "a", toolName: "ask", startedAt: ts } },
    ], "blocked", ts);
    expect(retry.activity?.toolName).toBe("ask");
    expect(retry.turnStartedAt).toBeUndefined();
  });

  test("estimates corrected prompt excluding anchor assistant output, and drops stale compaction anchors", () => {
    expect(estimateTranscriptContext([assistant({ input: 100, cacheRead: 200, cacheWrite: 50, output: 900, totalTokens: 9999 })], 2000)?.tokens).toBe(350);
    expect(estimateTranscriptContext([assistant({ input: 100 }, { content: [{ type: "text", text: "12345678" }] })], 1000)?.tokens).toBe(100);
    expect(estimateTranscriptContext([
      assistant({ input: 10 }, { contextSnapshot: { promptTokens: 600, historyRewriteTokensRemoved: 100 } }),
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "12345678" }] } },
    ], 1000)?.tokens).toBe(502);
    const compacted = [assistant({ input: 900 }), { type: "compaction", tokensBefore: 900 }];
    expect(estimateTranscriptContext(compacted, 1000)).toBeUndefined();
    expect(estimateTranscriptContext([...compacted, assistant({ input: 100 })], 1000)?.tokens).toBe(100);
    expect(estimateTranscriptContext([assistant({ input: 900 }, { stopReason: "error" })], 1000)).toBeUndefined();
    expect(estimateTranscriptContext([assistant({ input: 900 })], 0)).toBeUndefined();
  });

  test("pressure crosses the earliest percentage or absolute token boundary", () => {
    for (const [tokens, window, level] of [
      [149999, 1000000, "ok"], [150000, 1000000, "warn"],
      [270000, 1000000, "high"], [500000, 1000000, "critical"],
      [50, 100, "warn"], [70, 100, "high"], [90, 100, "critical"],
    ] as const) expect(estimateTranscriptContext([assistant({ input: tokens })], window)?.level).toBe(level);
  });

  test("actual read-only model cache and nonblocking git inspection in an isolated home", async () => {
    const home = await mkdtemp(join(tmpdir(), "herdr-status-"));
    const repo = await mkdtemp(join(tmpdir(), "herdr-status-repo-"));
    try {
      const dir = join(home, ".omp", "agent");
      await mkdir(dir, { recursive: true });
      const path = join(dir, "models.db");
      const db = new Database(path);
      db.run("CREATE TABLE model_cache(provider_id TEXT PRIMARY KEY, models TEXT)");
      db.query("INSERT INTO model_cache VALUES (?, ?)").run("fixture", JSON.stringify([{ id: "sonnet", name: "Claude Sonnet fixture", contextWindow: 1000000 }]));
      db.close();
      await Bun.$`git init -q ${repo}`.quiet();
      await writeFile(join(repo, "tracked.txt"), "initial\n");
      await Bun.$`git -C ${repo} add tracked.txt`.quiet();
      await Bun.$`git -C ${repo} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm initial`.quiet();
      await writeFile(join(repo, "tracked.txt"), "staged\n");
      await Bun.$`git -C ${repo} add tracked.txt`.quiet();
      await writeFile(join(repo, "tracked.txt"), "unstaged\n");
      await writeFile(join(repo, "untracked.txt"), "new file");
      await mkdir(join(repo, "untracked-dir"));
      await writeFile(join(repo, "untracked-dir", "a.txt"), "a");
      await writeFile(join(repo, "untracked-dir", "b.txt"), "b");
      const modulePath = join(import.meta.dir, "transcript-status.ts");
      // Yield through asynchronous filesystem completions, not wall-clock sleeps.
      const source = `import { deriveTranscriptStatus } from ${JSON.stringify(modulePath)};
        import { stat } from 'node:fs/promises';
        const entries = [{type:'model_change',model:'fixture/sonnet'}, {type:'message',message:{role:'assistant',usage:{input:206165}}}];
        const first = await deriveTranscriptStatus(entries,'idle',${JSON.stringify(ts)},${JSON.stringify(repo)});
        if (first.git !== undefined) throw new Error('cold git blocked response');
        let status;
        for (let n=0;n<1000;n++) {
          await stat(${JSON.stringify(repo)});
          status = await deriveTranscriptStatus(entries,'idle',${JSON.stringify(ts)},${JSON.stringify(repo)});
          if(status.git) break;
        }
        console.log(JSON.stringify(status));`;
      const child = Bun.spawn([process.execPath, "--eval", source], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
      const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(error).toBe("");
      expect(code).toBe(0);
      const status = JSON.parse(output) as TranscriptStatus;
      expect(status.model?.name).toBe("Sonnet fixture");
      expect(status.context).toEqual({ tokens: 206165, window: 1000000, percent: 20.6165, level: "warn", source: "estimate" });
      expect(status.git).toMatchObject({ staged: 1, unstaged: 1, untracked: 2, dirty: true });
      await rm(path);
      await symlink(join(home, "missing.db"), path);
      const blocked = Bun.spawn([process.execPath, "--eval", `import { deriveTranscriptStatus } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await deriveTranscriptStatus([{type:'model_change',model:'fixture/sonnet'}], 'idle', '')));`], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
      const rejected = JSON.parse(await new Response(blocked.stdout).text()) as TranscriptStatus;
      expect(rejected.model?.name).toBe("sonnet");
      expect(await blocked.exited).toBe(0);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
