const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const https = require("node:https");
const { promisify } = require("node:util");
const { testIdentity } = require("./fixtures/identity.cjs");
const execute = promisify(execFile);
const executable = path.resolve(
  "native",
  "bin",
  process.platform === "win32" ? "soluna-stream.exe" : "soluna-stream",
);
function runConfig(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native invalid-configuration test timed out"));
    }, 10000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        events: output.trim().split("\n").filter(Boolean).map(JSON.parse),
      });
    });
    child.stdin.end(`${JSON.stringify(config)}\n`);
  });
}

async function main() {
  const version = JSON.parse((await execute(executable, ["--version"])).stdout);
  assert.equal(version.qt, false);
  const capabilities = JSON.parse(
    (await execute(executable, ["--capabilities"])).stdout,
  );
  assert.equal(capabilities.protocol, 1);
  assert.equal(typeof capabilities.launchParams, "string");
  if (process.argv.includes("--check-build")) {
    console.log(
      "Native build present and protocol compatible; no Qt required.",
    );
    return;
  }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "lan-native-smoke-"));
  const directory = path.join(parent, "identity-\u6d4b\u8bd5");
  await fs.mkdir(directory);
  try {
    const created = JSON.parse(
      (await execute(executable, ["--identity", directory])).stdout,
    );
    assert.equal(created.created, true);
    const [cert, key] = await Promise.all([
      fs.readFile(path.join(directory, "client-cert.pem")),
      fs.readFile(path.join(directory, "client-key.pem")),
    ]);
    assert.ok(
      new crypto.X509Certificate(cert).checkPrivateKey(
        crypto.createPrivateKey(key),
      ),
    );
    const serverIdentity = testIdentity();
    const server = https.createServer(
      {
        key: serverIdentity.key,
        cert: serverIdentity.cert,
        ca: cert,
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        assert.equal(req.socket.authorized, true);
        res.end('<root status_code="200"><paired>1</paired></root>');
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await new Promise((resolve, reject) => {
        const request = https.get(
          {
            host: "127.0.0.1",
            port: server.address().port,
            path: "/pair",
            ca: serverIdentity.cert,
            cert,
            key,
            checkServerIdentity: (_hostname, peer) =>
              peer.raw.equals(serverIdentity.x509.raw)
                ? undefined
                : new Error("Unexpected test server certificate"),
          },
          (result) => {
            let body = "";
            result.setEncoding("utf8");
            result.on("data", (chunk) => (body += chunk));
            result.on("error", reject);
            result.on("end", () =>
              resolve({ status: result.statusCode, body }),
            );
          },
        );
        request.on("error", reject);
      });
      assert.equal(response.status, 200);
      assert.match(response.body, /<paired>1<\/paired>/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const again = JSON.parse(
      (await execute(executable, ["--identity", directory])).stdout,
    );
    assert.equal(again.created, false);
    assert.deepEqual(
      await fs.readFile(path.join(directory, "client-key.pem")),
      key,
    );
    const selfTestWork = execute(executable, ["--self-test"], {
      timeout: 15000,
      windowsHide: false,
    });
    if (process.platform === "win32") {
      await Promise.race([
        new Promise((resolve) => {
          let output = "";
          selfTestWork.child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            if (output.includes('"event":"first-frame"')) resolve();
          });
        }),
        selfTestWork.then(() => {
          throw new Error(
            "Native self-test exited before a rendered frame was observed",
          );
        }),
      ]);
      const { stdout } = await execute("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${selfTestWork.child.pid} -ErrorAction Stop; if ($p.MainWindowHandle -eq 0) { throw 'Native SDL window is not visible' }; $p.MainWindowTitle`,
      ]);
      assert.match(stdout, /SolunaRemote/);
    }
    const selfTest = await selfTestWork;
    const events = selfTest.stdout.trim().split("\n").map(JSON.parse);
    assert.ok(events.some((event) => event.event === "first-frame"));
    const stopped = events.find((event) => event.event === "stopped");
    assert.equal(stopped.selfTest, true);
    assert.ok(stopped.rendered > 10);
    assert.ok(stopped.decoded > 10);
    assert.ok(stopped.audioPackets > 10);
    for (const [config, expected] of [
      [{ address: "8.8.8.8" }, /LAN IPv4/],
      [
        {
          address: "127.0.0.1",
          appVersion: "7.1.431.0",
          rtspUrl: "rtsp://127.0.0.1:48010@8.8.8.8/",
        },
        /RTSP/,
      ],
    ]) {
      const result = await runConfig(config);
      assert.notEqual(result.code, 0);
      assert.ok(
        result.events.some(
          (event) => event.event === "error" && expected.test(event.message),
        ),
      );
    }
    console.log(
      `Native smoke passed: no Qt, Unicode identity creation/preservation, real mutual TLS with native certificate, LAN/RTSP rejection, H.264 decode/SDL (${stopped.rendered} frames), Opus silence/audio queue (${stopped.audioPackets} packets).`,
    );
    console.log(
      "This synthetic self-test does not verify Sunshine/UDP streaming, physically audible audio, hardware decoding or remote input.",
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
