const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const mode = process.argv[2];
const { version } = require(path.join(root, "package.json"));
if (process.platform !== "darwin")
  throw new Error("macOS Tauri commands can only run on a Mac.");
if (!["dev", "build"].includes(mode))
  throw new Error("Usage: node scripts/tauri-macos.cjs <dev|build>");

execFileSync(
  process.execPath,
  [path.join(__dirname, "prepare-tauri-macos.cjs")],
  {
    cwd: root,
    stdio: "inherit",
  },
);

const args = ["tauri", mode, "--config", "tauri.macos.conf.json"];
if (mode === "build") args.push("--bundles", "app");
execFileSync("npx", ["--no-install", ...args], {
  cwd: path.join(root, "src-tauri"),
  stdio: "inherit",
});

if (mode === "build") {
  const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
  const app = path.join(bundleDir, "macos", "SolunaRemote.app");
  if (!fs.existsSync(app))
    throw new Error("Tauri did not produce the SolunaRemote.app bundle.");

  const dmgDir = path.join(bundleDir, "dmg");
  const dmg = path.join(dmgDir, `SolunaRemote_${version}_${process.arch}.dmg`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "solunaremote-dmg-"));
  try {
    execFileSync("ditto", [app, path.join(staging, "SolunaRemote.app")], {
      stdio: "inherit",
    });
    fs.symlinkSync("/Applications", path.join(staging, "Applications"), "dir");
    fs.mkdirSync(dmgDir, { recursive: true });
    execFileSync(
      "hdiutil",
      [
        "create",
        "-volname",
        "SolunaRemote",
        "-srcfolder",
        staging,
        "-ov",
        "-format",
        "UDZO",
        dmg,
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  console.log(`Created macOS disk image: ${dmg}`);
}
