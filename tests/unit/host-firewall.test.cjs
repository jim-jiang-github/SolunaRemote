const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test(
  "firewall first-run creates all four scoped rules; invalid paths and foreign rules fail before mutations",
  {
    skip: process.platform !== "win32",
  },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lan-firewall-"));
    const host = path.join(directory, "sunshine.exe");
    const app = path.join(directory, "SolunaRemote.exe");
    const helper = path.resolve("app", "host-firewall.ps1");
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    await Promise.all([fs.writeFile(host, ""), fs.writeFile(app, "")]);
    function run(mode, appPath = app) {
      const script = `
$mode = ${quote(mode)}
function Get-NetFirewallRule {
 param($Name, $ErrorAction)
 if ($mode -eq 'foreign' -and $Name -eq 'SolunaRemote-Access-UDP') {
  [pscustomobject]@{ Program = 'C:\\foreign\\other.exe' }
 }
}
function Get-NetFirewallApplicationFilter {
 param([Parameter(ValueFromPipeline)]$Rule)
 process { $Rule }
}
function New-NetFirewallRule {
 param($Name, $DisplayName, $Direction, $Action, $Protocol, $LocalPort, $Program, $RemoteAddress, $Profile)
 [Console]::WriteLine((@{name=$Name;protocol=$Protocol;ports=@($LocalPort);program=$Program;address=$RemoteAddress} | ConvertTo-Json -Compress))
}
& ${quote(helper)} -Executable ${quote(host)} -AppExecutable ${quote(appPath)} -Address '172.22.96.1'
`;
      return spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 },
      );
    }
    try {
      const first = run("new");
      assert.equal(first.status, 0, first.stderr);
      const rules = first.stdout.trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(
        rules.map((rule) => rule.name),
        [
          "SolunaRemote-Integrated-TCP",
          "SolunaRemote-Integrated-UDP",
          "SolunaRemote-Access-TCP",
          "SolunaRemote-Access-UDP",
        ],
      );
      assert.ok(rules.every((rule) => rule.address === "172.22.96.1"));
      assert.deepEqual(rules[2].ports, [47991]);
      assert.deepEqual(rules[3].ports, [5353]);
      assert.equal(rules[2].program, app);
      const invalid = run("new", path.join(directory, "missing.exe"));
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout.trim(), "");
      assert.match(invalid.stderr, /Invalid SolunaRemote executable/);
      const foreign = run("foreign");
      assert.equal(foreign.status, 1);
      assert.equal(foreign.stdout.trim(), "");
      assert.match(foreign.stderr, /another installation/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
