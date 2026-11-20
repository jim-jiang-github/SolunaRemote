const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test(
  "MSIX PE validation rejects dangling certificate tables without altering files",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soluna-msix-pe-"));
    const file = path.join(root, "sample.exe");
    const script = path.resolve("scripts", "validate-msix-pe.ps1");
    const image = Buffer.alloc(512);
    image.writeUInt16LE(0x5a4d, 0);
    image.writeUInt32LE(64, 60);
    image.writeUInt32LE(0x4550, 64);
    image.writeUInt16LE(0x8664, 68);
    image.writeUInt16LE(240, 84);
    image.writeUInt16LE(0x20b, 88);
    image.writeUInt32LE(16, 196);
    function run() {
      fs.writeFileSync(file, image);
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-PackageDirectory",
          root,
          "-RepairKnownSunshineCertificate",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.deepEqual(fs.readFileSync(file), image);
      return result;
    }
    try {
      assert.equal(run().status, 0, "Unsigned PE must remain acceptable");
      for (const [offset, size] of [
        [4096, 8],
        [504, 16],
        [0, 8],
        [408, 0],
        [409, 8],
      ]) {
        image.writeUInt32LE(offset, 232);
        image.writeUInt32LE(size, 236);
        const result = run();
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Invalid PE certificate directory/);
      }
      image.writeUInt32LE(0, 232);
      image.writeUInt32LE(0, 236);
      image.writeUInt16LE(0x014c, 68);
      assert.match(run().stderr, /requires x64 PE/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "MSIX packaging rejects invalid Store inputs before building or changing output",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soluna-msix-"));
    const output = path.join(root, "output");
    const script = path.resolve("scripts", "build-msix.ps1");
    const identity = [
      "-IdentityName",
      "Example.SolunaRemote",
      "-Publisher",
      "CN=00000000-0000-0000-0000-000000000001",
      "-PublisherDisplayName",
      "Example",
    ];
    function run(args) {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-OutputDirectory",
          output,
          ...args,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      return result.stderr;
    }
    try {
      assert.match(
        run(["-Preview", "-Version", "1.2.3.4"]),
        /last part set to 0/,
      );
      assert.match(
        run([...identity, "-Version", "65536.0.0.0"]),
        /between 0 and 65535/,
      );
      assert.match(
        run([...identity, "-Version", "0.4.0.0"]),
        /major version must be greater than 0/,
      );
      assert.match(
        run([
          "-IdentityName",
          "SolunaRemote.Preview",
          "-Publisher",
          "CN=SolunaRemote Preview",
          "-PublisherDisplayName",
          "Preview",
        ]),
        /Preview identity cannot be used/,
      );
      assert.match(run([]), /mandatory parameters|mandatory parameter/);
      assert.equal(fs.existsSync(output), false);
      fs.mkdirSync(output);
      const marker = path.join(output, "keep.txt");
      fs.writeFileSync(marker, "user-owned output");
      assert.match(run(["-Preview"]), /Output directory already exists/);
      assert.equal(fs.readFileSync(marker, "utf8"), "user-owned output");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
