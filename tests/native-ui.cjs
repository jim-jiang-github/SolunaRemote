const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { nativeEvidence } = require("./live-password.cjs");

async function main() {
  const output = path.resolve("test-results", "native-ui");
  await fs.mkdir(output, { recursive: true });
  const child = spawn(path.resolve("native", "bin", "soluna-stream.exe"), [], {
    windowsHide: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const timer = setTimeout(() => child.kill(), 35000);
  try {
    child.stdin.write(
      `${JSON.stringify({
        selfTest: true,
        selfTestSeconds: 30,
        decoder: "software",
        deviceName: "Native UI test (synthetic)",
      })}\n`,
    );
    const deadline = Date.now() + 10000;
    while (!stdout.includes('"first-frame"')) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`Native UI test never rendered: ${stderr || stdout}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await nativeEvidence(
      child.pid,
      path.join(output, "native-live-desktop.png"),
      true,
    );
    assert.equal(await completion, 0, stderr || stdout);
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);
    await fs.writeFile(
      path.join(output, "events.json"),
      JSON.stringify(events, null, 2),
    );
    const stopped = events.find((entry) => entry.event === "stopped");
    assert.equal(stopped.selfTest, true);
    assert.ok(stopped.rendered > 30);
    const clicks = events.filter((entry) => entry.event === "self-test-click");
    assert.ok(
      clicks.some((entry) => entry.muted),
      "Mute must activate after real click",
    );
    assert.ok(
      clicks.some((entry) => entry.fullscreen),
      "Fullscreen must activate after real click",
    );
    assert.equal(
      clicks.at(-1).fullscreen,
      false,
      "Fullscreen must restore after real click",
    );
    assert.deepEqual(stopped.controls, {
      performance: true,
      panel: false,
      muted: false,
    });
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        {
          fixture:
            "Synthetic H.264 and Opus; real native SDL window, no VM/network",
          actualClicks: [
            "Open control center",
            "Mute",
            "Unmute",
            "Enter fullscreen",
            "Leave fullscreen",
            "Enable performance",
            "Close control center",
            "Disconnect",
          ],
          stopped,
          remoteKeyboardVerified: false,
        },
        null,
        2,
      ),
    );
    console.log(
      "Native UI passed: real rendered window, control center, performance toggle and disconnect; synthetic media only.",
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await completion;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
