const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { expect } = require("@playwright/test");
const { version } = require("../package.json");
const { launchTauri } = require("./tauri-launch.cjs");

async function main() {
  const msix = process.argv.includes("--msix");
  const directory = path.resolve(
    process.argv[2] ||
      path.join(
        "release",
        `SolunaRemote-${version}-windows-x64-portable`,
        "SolunaRemote.exe",
      ),
  );
  const resources = path.join(path.dirname(directory), "resources");
  for (const library of [
    "libssl-3-x64.dll",
    "libcrypto-3-x64.dll",
    "vcruntime140.dll",
  ])
    assert.ok(
      fs.existsSync(path.join(path.dirname(directory), library)),
      `Portable application library missing: ${library}`,
    );
  for (const resource of [
    path.join("native", "soluna-stream.exe"),
    path.join("host", "sunshine.exe"),
    ...(msix ? [] : [path.join("host-tools", "host-firewall.ps1")]),
  ])
    assert.ok(
      fs.existsSync(path.join(resources, resource)),
      `Portable resource missing: ${resource}`,
    );
  for (const resource of ["node.exe", "app", "node_modules"])
    assert.ok(
      !fs.existsSync(path.join(resources, resource)),
      `Node.js runtime resource must not be packaged: ${resource}`,
    );
  if (msix) {
    assert.ok(
      fs.existsSync(path.join(path.dirname(directory), "AppxManifest.xml")),
      "MSIX manifest missing",
    );
    for (const resource of [
      "host-tools",
      path.join("host", "scripts"),
      path.join("host", "tools"),
    ])
      assert.ok(
        !fs.existsSync(path.join(resources, resource)),
        `Unneeded administration tools or host state must not be packaged: ${resource}`,
      );
    assert.deepEqual(
      fs.readdirSync(path.join(resources, "host", "config")),
      [".keep"],
      "MSIX needs an empty host config directory, never user configuration",
    );
  }
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "solunaremote-portable-"),
  );
  let application;
  try {
    application = await launchTauri(directory, profile);
    const { page } = application;
    await expect(page.getByRole("heading", { name: "远程协助" })).toBeVisible();
    await expect(page).toHaveTitle("SolunaRemote");
    await expect(page.getByText("我的设备", { exact: true })).toHaveCount(0);
    await expect(
      page.locator(".sidebar").getByRole("button", { name: "全部设备" }),
    ).toHaveCount(0);
    await expect(page.locator("#host-password-form")).toBeVisible();
    await expect(page.locator('[data-action="open-host-allow"]')).toHaveCount(
      0,
    );
    await expect(page.locator("#share-address")).toHaveCount(0);
    await expect(page.locator("#host-client-address")).toHaveCount(0);
    await expect(page.locator("#connect-form")).toBeVisible();
    await expect(page.locator("#partner-code")).toHaveAttribute(
      "pattern",
      "[0-9]{9}",
    );
    await page.locator("#partner-code").fill("000000001");
    await page.locator("#partner-password").fill("test-password");
    await page.locator('#connect-form button[type="submit"]').click();
    await expect(page.locator("#connect-error")).toHaveText(
      "设备码校验失败，请检查输入。",
    );
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "开始协助" })
      .click();
    await expect(page.locator("#partner-code")).toBeFocused();
    const state = await page.evaluate(() => window.lan.call("state"));
    assert.equal(state.version, version);
    assert.equal(state.engines.nativeAvailable, true);
    assert.equal(state.host.available, true);
    assert.equal(state.host.firewallManagedByPackage, msix);
    if (msix) {
      const error = await page.evaluate(async () => {
        try {
          await window.lan.call("hostFirewallStatus");
          return null;
        } catch (error) {
          return error.message;
        }
      });
      assert.match(error, /MSIX/);
    }
    assert.equal(state.local.addresses, undefined);
    assert.equal(state.host.access.address, undefined);
    assert.equal(state.host.access.addresses, undefined);
    assert.equal(state.host.allowedAddress, undefined);
    await page.locator('[data-route="settings"]').click();
    await expect(page.locator("#settings-form")).toBeVisible();
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "开始协助" })
      .click();
    await expect(page.getByRole("heading", { name: "远程协助" })).toBeVisible();
    await expect(page.locator("#connect-form")).toBeVisible();
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: path.join(
        "test-results",
        msix ? "msix-tauri-desktop.png" : "portable-tauri-desktop.png",
      ),
    });
    console.log(
      `${msix ? "Unpacked MSIX" : "Portable"} Tauri Release ${version}: resources, startup, backend and navigation OK.`,
    );
  } finally {
    await application?.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
