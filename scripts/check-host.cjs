const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..", "host", "bin");
const release = JSON.parse(
  fs.readFileSync(path.join(root, "release.json"), "utf8"),
);
if (
  release.version !== "v2026.914.233613" ||
  release.sha256 !==
    "233008e46f4c0e501a586cbfd6c4fd4a4c0d414a0b5fc7f13c070eb92ec3824b"
)
  throw new Error(
    "Missing or incompatible bundled Sunshine release; run npm run prepare:host.",
  );
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lan-host-version-"));
try {
  const version = execFileSync(
    path.join(root, "sunshine.exe"),
    [path.join(temporary, "sunshine.conf"), "--version"],
    {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (!version.includes("2026.914.233613"))
    throw new Error("Bundled host version mismatch.");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
console.log("Integrated Sunshine host bundle verified.");
