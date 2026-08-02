// Fire a one-off Web Push to every subscribed device — the manual counterpart to the automatic
// blocked/done notifications, so you can verify push end-to-end WITHOUT waiting for an agent to
// actually block. Routes through the running bridge so that process remains the sole owner of the
// subscription store while still exercising the real send path (VAPID → push service → device).
//
// Run via
//   bash scripts/collie-ctl.sh push-test ["title"] ["body"] ["paneId"]
// so the helper resolves the same configured bridge port.
import { loadConfig } from "../bridge/config.ts";

const [title = "Herdr Control test", body = "Push works — tap to open Herdr Control", paneId = "test"] =
  process.argv.slice(2);

const cfg = loadConfig();
let response: Response;
try {
  response = await fetch(`http://127.0.0.1:${cfg.port}/api/push-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body, paneId }),
  });
} catch (error) {
  console.error(
    `✗ could not reach the Herdr Control bridge on 127.0.0.1:${cfg.port}: ` +
      `${error instanceof Error ? error.message : String(error)}\n` +
      "  Start the bridge, then retry.",
  );
  process.exit(1);
}
if (!response.ok) {
  console.error(
    `✗ push test failed (${response.status}): ${await response.text()}\n` +
      "  Confirm push is configured and enable notifications in Herdr Control Settings.",
  );
  process.exit(1);
}
const result = await response.json() as { subscribers: number };
console.log(
  `✓ sent "${title}" to ${result.subscribers} device(s). Check your phone` +
    " (and `journalctl --user -u collie` for any per-endpoint send errors).",
);
