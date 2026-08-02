import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensurePrivateDirectory, writePrivateFile } from "./private-fs.ts";

describe("private filesystem helpers", () => {
  test("tightens existing directories and creates owner-only files", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-private-"));
    const dir = join(root, "state");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);

    await ensurePrivateDirectory(dir);
    const file = join(dir, "secret");
    await writePrivateFile(file, new TextEncoder().encode("sensitive"));

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
