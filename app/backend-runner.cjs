const path = require("node:path");
const readline = require("node:readline");
const { bootstrap } = require("./main.cjs");

process.env.SOLUNA_RESOURCES_DIR = path.resolve(__dirname, "..");

const allowed = new Set([
  "state",
  "hostPassword",
  "hostStart",
  "hostStop",
  "hostAllowClient",
  "connectPassword",
  "cancelConnect",
  "add",
  "remove",
  "favorite",
  "refresh",
  "discover",
  "saveSettings",
  "validateNativePath",
  "shortcut",
  "removeShortcut",
  "cancel",
  "sunshineUrl",
]);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

async function main() {
  const runtime = await bootstrap({
    headless: true,
    userDataDir: process.env.SOLUNA_USER_DATA_DIR,
    version: process.env.SOLUNA_APP_VERSION,
    emit: (event, value) => write({ event, value }),
    onError: (error) => {
      process.stderr.write(`Backend shutdown error: ${error.message}\n`);
    },
  });
  const input = readline.createInterface({ input: process.stdin });
  let stopping = false;

  input.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      write({ id: null, ok: false, error: "无效的后端请求。" });
      return;
    }
    if (
      !Number.isSafeInteger(request.id) ||
      typeof request.method !== "string" ||
      !allowed.has(request.method) ||
      typeof runtime.methods[request.method] !== "function"
    ) {
      write({
        id: request.id ?? null,
        ok: false,
        error: "不允许的后端请求。",
      });
      return;
    }
    Promise.resolve()
      .then(() => runtime.methods[request.method](request.input))
      .then((value) =>
        write({ id: request.id, ok: true, value: value ?? null }),
      )
      .catch((error) =>
        write({
          id: request.id,
          ok: false,
          error: error.message || "操作失败，请重试。",
        }),
      );
  });

  input.on("close", async () => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.shutdown();
    } catch (error) {
      process.stderr.write(`Backend shutdown error: ${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

main().catch((error) => {
  process.stderr.write(
    `Backend startup failed: ${error.stack || error.message}\n`,
  );
  process.exitCode = 1;
});
