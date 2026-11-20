const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "third-party", "Sunshine");
const host = path.join(root, "host");
const destination = path.join(host, "bin-macos-local");
const build = path.join(host, "build-macos-local");
const { version } = require(path.join(root, "package.json"));

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
  throw new Error("macOS Sunshine preparation requires an arm64 or x64 Mac.");
if (fs.existsSync(destination))
  throw new Error(
    "The local macOS Sunshine output already exists; inspect it before replacing.",
  );
for (const file of [
  "CMakeLists.txt",
  "third-party/TPCircularBuffer/TPCircularBuffer.c",
  "third-party/build-deps/package-lock.cmake",
  "third-party/Simple-Web-Server/CMakeLists.txt",
  "third-party/libdisplaydevice/CMakeLists.txt",
  "third-party/libvirtualhid/CMakeLists.txt",
  "third-party/lizardbyte-common/CMakeLists.txt",
  "third-party/moonlight-common-c/enet/CMakeLists.txt",
]) {
  if (!fs.existsSync(path.join(source, file)))
    throw new Error(`Missing Sunshine source or submodule: ${file}`);
}

const marker = path.join(build, ".solunaremote-build.json");
const buildIdentity = { source, architecture: process.arch };
if (fs.existsSync(build)) {
  if (
    !fs.existsSync(marker) ||
    fs.readFileSync(marker, "utf8") !== JSON.stringify(buildIdentity)
  )
    throw new Error("The macOS build directory is not managed by this script.");
} else {
  fs.mkdirSync(build);
  fs.writeFileSync(marker, JSON.stringify(buildIdentity), { flag: "wx" });
}

const temporary = fs.mkdtempSync(path.join(host, ".sunshine-local-"));
try {
  const env = { ...process.env, BRANCH: "local", BUILD_VERSION: version };
  run(
    "cmake",
    [
      "-S",
      source,
      "-B",
      build,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_DOCS=OFF",
      "-DBUILD_TESTS=OFF",
      "-DSUNSHINE_ENABLE_TRAY=OFF",
      "-DSUNSHINE_BUILD_EMBEDDED=OFF",
    ],
    { env },
  );
  run("cmake", ["--build", build, "--config", "Release", "--parallel", "4"]);
  const output = path.join(temporary, "output");
  run("cmake", [
    "--install",
    build,
    "--config",
    "Release",
    "--component",
    "Runtime",
    "--prefix",
    output,
  ]);
  const app = path.join(output, "Sunshine.app");
  for (const asset of ["apps.json", "steam.png", "desktop-alt.png"])
    fs.rmSync(path.join(app, "Contents", "Resources", "assets", asset), {
      force: true,
    });
  const plist = path.join(app, "Contents", "Info.plist");
  run("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :CFBundleIdentifier local.solunaremote.sunshine",
    plist,
  ]);
  const entitlements = path.join(temporary, "entitlements.plist");
  fs.writeFileSync(
    entitlements,
    fs
      .readFileSync(
        path.join(source, "src_assets", "macos", "entitlements.plist"),
        "utf8",
      )
      .replace(/\r\n/g, "\n"),
  );
  run("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--entitlements",
    entitlements,
    app,
  ]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const result = spawnSync("codesign", ["-dv", "--verbose=4", app], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const cdhash = result.stderr.match(/^CDHash=([0-9a-f]{40})$/m)?.[1];
  if (result.status !== 0 || !cdhash)
    throw new Error("Cannot determine the locally built Sunshine code hash.");
  fs.mkdirSync(path.join(output, "licenses"));
  fs.copyFileSync(
    path.join(source, "LICENSE"),
    path.join(output, "licenses", "Sunshine-LICENSE"),
  );
  fs.copyFileSync(
    path.join(host, "THIRD-PARTY-NOTICES.txt"),
    path.join(output, "THIRD-PARTY-NOTICES.txt"),
  );
  fs.writeFileSync(
    path.join(output, "release.json"),
    `${JSON.stringify({ version: `v${version}-local-${cdhash}`, architecture: process.arch, cdhash }, null, 2)}\n`,
    { flag: "wx" },
  );
  fs.renameSync(output, destination);
  console.log(`Prepared locally built Sunshine (${process.arch}).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
