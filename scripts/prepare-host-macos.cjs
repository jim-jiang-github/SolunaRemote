const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const version = "v2026.914.233613";
const releases = {
  arm64: "795f03a389c5726f9a7b15f501dc1ddf204b442cae565859ac83aae027a9e07c",
  x64: "764b11674babac0cd838c2883359207a481c462f355ccbfd1ec91f6d44672101",
};
const architecture = { arm64: "arm64", x64: "x86_64" };
const root = path.resolve(__dirname, "..");
const host = path.join(root, "host");
const destination = path.join(host, "bin-macos");

if (process.platform !== "darwin" || !releases[process.arch])
  throw new Error("macOS Sunshine preparation requires an arm64 or x64 Mac.");
if (fs.existsSync(destination))
  throw new Error(
    "host/bin-macos already exists; inspect it before replacing.",
  );

const temporary = fs.mkdtempSync(path.join(host, ".sunshine-macos-"));
const archive = path.join(temporary, "sunshine.dmg");
const mount = path.join(temporary, "mount");
const output = path.join(temporary, "output");
let mounted = false;
try {
  const asset = `Sunshine-macOS-${architecture[process.arch]}.dmg`;
  execFileSync("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    archive,
    `https://github.com/SunshineStream/Sunshine/releases/download/${version}/${asset}`,
  ]);
  const hash = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  if (hash !== releases[process.arch])
    throw new Error("Official Sunshine release SHA256 mismatch.");
  fs.mkdirSync(mount);
  execFileSync("hdiutil", [
    "attach",
    archive,
    "-mountpoint",
    mount,
    "-readonly",
    "-nobrowse",
    "-quiet",
  ]);
  mounted = true;
  const app = path.join(mount, "Sunshine.app");
  if (!fs.statSync(path.join(app, "Contents", "MacOS", "Sunshine")).isFile())
    throw new Error("Official Sunshine app layout is incompatible.");
  fs.mkdirSync(output);
  execFileSync("ditto", [app, path.join(output, "Sunshine.app")]);
  execFileSync("codesign", [
    "--verify",
    "--deep",
    "--strict",
    path.join(output, "Sunshine.app"),
  ]);
  fs.mkdirSync(path.join(output, "licenses"));
  execFileSync("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    path.join(output, "licenses", "Sunshine-LICENSE"),
    `https://raw.githubusercontent.com/SunshineStream/Sunshine/${version}/LICENSE`,
  ]);
  fs.copyFileSync(
    path.join(host, "THIRD-PARTY-NOTICES.txt"),
    path.join(output, "THIRD-PARTY-NOTICES.txt"),
  );
  fs.writeFileSync(
    path.join(output, "release.json"),
    JSON.stringify(
      { version, architecture: process.arch, sha256: hash, asset },
      null,
      2,
    ) + "\n",
  );
  fs.renameSync(output, destination);
  console.log(`Prepared official macOS Sunshine ${version} (${process.arch}).`);
} finally {
  if (mounted) execFileSync("hdiutil", ["detach", mount, "-quiet"]);
  fs.rmSync(temporary, { recursive: true, force: true });
}
