import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("collie launcher", () => {
  test("prints a quote-safe managed reinstall command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-control-launcher-"));
    temporaryDirectories.push(directory);
    const herdr = join(directory, "herdr");
    await writeFile(
      herdr,
      `#!/bin/sh
cat <<'JSON'
{"result":{"plugins":[{"plugin_id":"herdr.control","source":{"owner":"acme","repo":"herdr-control","subdir":"plugins/mobile","requested_ref":"release'candidate"}}]}}
JSON
`,
    );
    await chmod(herdr, 0o755);

    const script = resolve(import.meta.dir, "../scripts/collie-ctl.sh");
    const result = Bun.spawnSync(["/bin/bash", "-c", 'source "$1"; managed_reinstall_command', "bash", script], {
      env: {
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: directory,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(
      "herdr plugin install 'acme/herdr-control/plugins/mobile' --ref 'release'\\''candidate' --yes",
    );
  });

  test("launchd stop removes the RunAtLoad plist so the bridge stays stopped after login", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herdr-control-launchd-stop-"));
    temporaryDirectories.push(directory);
    const plist = join(directory, "Library/LaunchAgents/dev.herdr.control.plist");
    await mkdir(join(directory, "Library/LaunchAgents"), { recursive: true });
    await writeFile(plist, "placeholder");
    const script = resolve(import.meta.dir, "../scripts/collie-ctl.sh");
    const result = Bun.spawnSync(
      [
        "/bin/bash",
        "-c",
        'source "$1"; have_systemd() { return 1; }; have_launchd() { return 0; }; launchd_domain() { echo gui/501; }; launchctl() { return 0; }; cmd_stop; test ! -e "$LAUNCHD_FILE"',
        "bash",
        script,
      ],
      {
        env: {
          ...process.env,
          HOME: directory,
          HERDR_PLUGIN_CONFIG_DIR: join(directory, "config"),
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("reference systemd unit leaves launcher-only effective values unset", async () => {
    const unit = await Bun.file(resolve(import.meta.dir, "../systemd/herdr-control.service")).text();
    expect(unit).not.toContain("HERDR_CONTROL_EFFECTIVE_PORT");
    expect(unit).not.toContain("HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS");
  });
});
