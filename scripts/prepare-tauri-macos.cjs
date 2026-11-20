const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const prepared = path.join(root, "host", "bin-macos");
const resources = path.join(root, "src-tauri", "resources");
const sourceApp = path.join(prepared, "Sunshine.app");
const releasePath = path.join(prepared, "release.json");
const nativeSource = path.join(root, "native");
const nativeBuild = path.join(nativeSource, "build-macos");
const nativeResources = path.join(resources, "native");

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function verifySignature(app) {
  run("codesign", ["--verify", "--deep", "--strict", app]);
}

function hashFile(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.alloc(65536);
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, length));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function copyFileIfAbsent(source, destination) {
  const contents = fs.readFileSync(source);
  if (fs.existsSync(destination)) {
    if (!fs.readFileSync(destination).equals(contents))
      throw new Error(
        `Refusing to overwrite existing resource: ${destination}`,
      );
    return;
  }
  fs.copyFileSync(source, destination);
}

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error("macOS resource preparation requires an arm64 or x64 Mac.");
if (!fs.existsSync(sourceApp) || !fs.existsSync(releasePath))
  throw new Error(
    "Run npm run prepare:host:macos before preparing Tauri resources.",
  );

const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
if (release.architecture !== process.arch)
  throw new Error("Prepared Sunshine does not match this Mac's architecture.");
verifySignature(sourceApp);

run("cmake", [
  "-S",
  nativeSource,
  "-B",
  nativeBuild,
  "-DCMAKE_BUILD_TYPE=Release",
]);
run("cmake", ["--build", nativeBuild, "--config", "Release", "--parallel"]);
const nativeExecutable = [
  path.join(nativeBuild, "soluna-stream"),
  path.join(nativeBuild, "Release", "soluna-stream"),
].find((candidate) => fs.existsSync(candidate));
if (!nativeExecutable)
  throw new Error("The macOS soluna-stream build produced no executable.");
fs.mkdirSync(nativeResources, { recursive: true });
const nativeDestination = path.join(nativeResources, "soluna-stream");
const nativeTemporary = `${nativeDestination}.${process.pid}.tmp`;
try {
  fs.copyFileSync(nativeExecutable, nativeTemporary);
  fs.renameSync(nativeTemporary, nativeDestination);
} finally {
  if (fs.existsSync(nativeTemporary)) fs.rmSync(nativeTemporary);
}

const host = path.join(resources, "host");
const targetArchive = path.join(host, "Sunshine.app.zip");
const targetManifest = path.join(host, "Sunshine.app.zip.json");
fs.mkdirSync(host, { recursive: true });
if (fs.existsSync(targetArchive) !== fs.existsSync(targetManifest))
  throw new Error(
    "Sunshine archive resources are incomplete; inspect them before replacing.",
  );

let temporary;
try {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "solunaremote-sunshine-"));
  const extracted = path.join(temporary, "extracted");
  fs.mkdirSync(extracted);

  if (fs.existsSync(targetArchive)) {
    const manifest = JSON.parse(fs.readFileSync(targetManifest, "utf8"));
    if (
      manifest.version !== release.version ||
      manifest.architecture !== release.architecture ||
      hashFile(targetArchive) !== manifest.sha256
    )
      throw new Error(
        "A different or damaged Sunshine archive already exists; inspect it before replacing.",
      );
    run("ditto", ["-x", "-k", targetArchive, extracted]);
  } else {
    const archive = path.join(temporary, "Sunshine.app.zip");
    run("ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      sourceApp,
      archive,
    ]);
    run("ditto", ["-x", "-k", archive, extracted]);
    const appArchiveManifest = {
      version: release.version,
      architecture: release.architecture,
      sha256: hashFile(archive),
    };
    fs.copyFileSync(archive, targetArchive, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(
      targetManifest,
      `${JSON.stringify(appArchiveManifest, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  verifySignature(path.join(extracted, "Sunshine.app"));
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}

copyFileIfAbsent(releasePath, path.join(host, "release.json"));
copyFileIfAbsent(
  path.join(prepared, "THIRD-PARTY-NOTICES.txt"),
  path.join(host, "THIRD-PARTY-NOTICES.txt"),
);
const sourceLicense = path.join(prepared, "licenses", "Sunshine-LICENSE");
const targetLicenseDir = path.join(host, "licenses");
fs.mkdirSync(targetLicenseDir, { recursive: true });
copyFileIfAbsent(
  sourceLicense,
  path.join(targetLicenseDir, "Sunshine-LICENSE"),
);

console.log(`Prepared signed Sunshine ${release.version} in Tauri resources.`);
