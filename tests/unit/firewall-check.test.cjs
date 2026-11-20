const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const script = path.resolve("app", "host-firewall-check.ps1");
const scriptContents = fs.readFileSync(script, "utf8");

function runCheck(scenario) {
  const command = `
    $ErrorActionPreference = 'Stop'
    function Get-NetFirewallRule {
      param($PolicyStore, $Name)
      if ('${scenario}' -eq 'query-error') { throw 'firewall query failed' }
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $suffix = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes('c:\\app\\solunaremote.exe'))) -replace '-', '').Substring(0, 16) } finally { $hash.Dispose() }
      foreach ($name in @("SolunaRemote-Integrated-TCP-$suffix", "SolunaRemote-Integrated-UDP-$suffix", "SolunaRemote-Access-TCP-$suffix", "SolunaRemote-Access-UDP-$suffix")) {
        if ('${scenario}' -eq 'missing' -and $name -like 'SolunaRemote-Integrated-TCP-*') { continue }
        [pscustomobject]@{ Name=$name; Enabled='True'; Direction='Inbound'; Action='Allow'; Profile=$(if ('${scenario}' -eq 'wrong-profile') { 'Private' } else { 'Any' }) }
      }
    }
    function Get-NetFirewallApplicationFilter {
      process {
        $program = if ($_.Name -like '*Integrated*') { 'C:\\host\\sunshine.exe' } else { 'C:\\app\\SolunaRemote.exe' }
        if ('${scenario}' -eq 'old-path' -and $_.Name -like 'SolunaRemote-Integrated-TCP-*') { $program='C:\\old\\sunshine.exe' }
        [pscustomobject]@{ Program=$program }
      }
    }
    function Get-NetFirewallPortFilter {
      process {
        $protocol = if ($_.Name -like '*-TCP-*') { 'TCP' } else { 'UDP' }
        $ports = switch -Wildcard ($_.Name) {
          'SolunaRemote-Integrated-TCP-*' { @('47984','47989','48010') }
          'SolunaRemote-Integrated-UDP-*' { @('47998-48000','48002') }
          'SolunaRemote-Access-TCP-*' { @('47991') }
          'SolunaRemote-Access-UDP-*' { @('5353') }
        }
        if ('${scenario}' -eq 'wrong-port' -and $_.Name -like 'SolunaRemote-Access-TCP-*') { $ports=@('Any') }
        [pscustomobject]@{ Protocol=$protocol; LocalPort=@($ports) }
      }
    }
    function Get-NetFirewallAddressFilter {
      process {
        $ip = if ('${scenario}' -eq 'public') { 'Any' } elseif ('${scenario}' -eq 'different' -and $_.Name -like 'SolunaRemote-Access-TCP-*') { '10.0.0.2' } else { 'LocalSubnet' }
        [pscustomobject]@{ RemoteAddress=@($ip) }
      }
    }
    try {
      & {
      ${scriptContents}
      } -Executable '${scenario === "verbatim" ? "\\\\?\\C:\\host\\sunshine.exe" : "C:\\host\\sunshine.exe"}' -AppExecutable '${scenario === "verbatim" ? "\\\\?\\C:\\app\\SolunaRemote.exe" : "C:\\app\\SolunaRemote.exe"}'
      exit $LASTEXITCODE
    } catch {
      [Console]::Error.WriteLine($_.ToString())
      exit 1
    }
  `;
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      timeout: 30000,
    },
  );
}

test(
  "firewall authorization creates only scoped rules and rejects conflicting rules",
  { skip: process.platform !== "win32" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soluna-firewall-"));
    try {
      const host = path.join(root, "sunshine.exe");
      const app = path.join(root, "SolunaRemote.exe");
      const log = path.join(root, "rules.jsonl");
      fs.writeFileSync(host, "");
      fs.writeFileSync(app, "");
      const script = fs.readFileSync(
        path.resolve("app", "host-firewall.ps1"),
        "utf8",
      );
      const quote = (value) => value.replaceAll("'", "''");
      const run = (conflict) =>
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `
                function Get-NetFirewallRule {
                  param($PolicyStore)
                  if (${conflict ? "$true" : "$false"}) {
                    $hash=[Security.Cryptography.SHA256]::Create()
                    try { $suffix=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFullPath('${quote(app)}').ToLowerInvariant()))) -replace '-', '').Substring(0,16) } finally { $hash.Dispose() }
                    [pscustomobject]@{ Name="SolunaRemote-Integrated-TCP-$suffix"; Direction='Inbound'; Action='Allow'; Profile='Any' }
                  }
                }
                function Get-NetFirewallApplicationFilter { process { [pscustomobject]@{ Program='C:\\other\\sunshine.exe' } } }
                function Get-NetFirewallPortFilter { process { [pscustomobject]@{ Protocol='TCP'; LocalPort=@('47984','47989','48010') } } }
                function New-NetFirewallRule {
                  param($Name,$DisplayName,$Direction,$Action,$Protocol,$LocalPort,$Program,$RemoteAddress,$Profile)
                  @{Name=$Name; Direction=$Direction; Action=$Action; Protocol=$Protocol; LocalPort=@($LocalPort); Program=$Program; RemoteAddress=$RemoteAddress; Profile=$Profile} |
                    ConvertTo-Json -Compress | Add-Content -LiteralPath '${quote(log)}'
                }
                & {
                ${script}
                } -Executable '${quote(host)}' -AppExecutable '${quote(app)}'
                exit $LASTEXITCODE
              `,
          ],
          { encoding: "utf8", timeout: 30000 },
        );
      const valid = run(false);
      assert.equal(valid.status, 0, valid.stderr);
      const rules = fs
        .readFileSync(log, "utf8")
        .trim()
        .split(/\r?\n/)
        .map(JSON.parse);
      assert.equal(rules.length, 4);
      for (const rule of rules) {
        assert.match(
          rule.Name,
          /^SolunaRemote-(Integrated|Access)-(TCP|UDP)-[A-F0-9]{16}$/,
        );
        assert.equal(rule.RemoteAddress, "LocalSubnet");
        assert.equal(rule.Direction, "Inbound");
        assert.equal(rule.Action, "Allow");
        assert.equal(rule.Profile, "Any");
        assert.equal(
          rule.Program,
          rule.Name.includes("Integrated") ? host : app,
        );
      }
      fs.unlinkSync(log);
      const conflicting = run(true);
      assert.notEqual(conflicting.status, 0);
      assert.equal(fs.existsSync(log), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "firewall check requires matching enabled, narrowly scoped current-version rules",
  { skip: process.platform !== "win32" },
  () => {
    for (const scenario of ["valid", "verbatim"]) {
      const valid = runCheck(scenario);
      assert.ifError(valid.error);
      assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    }
    for (const scenario of [
      "missing",
      "old-path",
      "wrong-port",
      "public",
      "different",
      "wrong-profile",
    ]) {
      const invalid = runCheck(scenario);
      assert.ifError(invalid.error);
      assert.equal(invalid.status, 3, scenario);
    }
    assert.notEqual(runCheck("query-error").status, 3);
  },
);
