const readline = require("node:readline");

// Protocol fixture only: these are synthetic events, not decoded Sunshine video.
const input = readline.createInterface({ input: process.stdin });
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let configured = false;
let firstFrameTimer;
input.on("line", (line) => {
  if (configured) {
    clearTimeout(firstFrameTimer);
    emit({ event: "stopped", selfTest: true });
    process.exit(0);
  }
  const config = JSON.parse(line);
  if (config.testFixture !== true)
    throw new Error("Missing test fixture marker");
  configured = true;
  emit({ event: "stage", name: "TEST synthetic connection" });
  emit({ event: "connected" });
  firstFrameTimer = setTimeout(() => {
    emit({ event: "first-frame", width: config.width, height: config.height });
    emit({ event: "stats", decoded: 1, rendered: 1, audioPackets: 0 });
  }, 250);
});
input.on("close", () => {
  clearTimeout(firstFrameTimer);
  process.exit(0);
});
