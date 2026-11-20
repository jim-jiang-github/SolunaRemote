const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const bundle = path.resolve("vm-ssh-setup");
const script = path.join(bundle, "Enable-VmSsh.ps1");
const publicKey = path.join(bundle, "solunaremote-vm-v2.pub");
const prepareBundle = path.join(bundle, "Prepare-Host.ps1");
const windowsOnly = { skip: process.platform !== "win32" };
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

test("VM SSH bundle contains all setup resources and no private key", () => {
  const files = [
    "Enable-VmSsh.ps1",
    "PREPARE-HOST.bat",
    "Prepare-Host.ps1",
    "README.txt",
    "START.bat",
    "Start-Setup.ps1",
    "settings.json",
    "solunaremote-vm-v2.pub",
    "vm-deploy.pub",
  ];
  const actual = fs.readdirSync(bundle).sort();
  assert.deepEqual(
    actual.filter((file) => !file.endsWith(".pub")),
    files.filter((file) => !file.endsWith(".pub")).sort(),
  );
  for (const required of files) assert.ok(actual.includes(required));
  for (const file of actual) {
    if (file.endsWith(".pub"))
      assert.match(
        fs.readFileSync(path.join(bundle, file), "utf8"),
        /^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]+)?\s*$/,
      );
    assert.doesNotMatch(
      fs.readFileSync(path.join(bundle, file), "utf8"),
      /-----BEGIN [^\r\n]*PRIVATE KEY-----/,
    );
  }
});

function powershell(command) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.ifError(result.error);
  return result;
}

function preview(address, key = publicKey) {
  return powershell(
    `$ErrorActionPreference = 'Stop'; & ${quote(script)} -AllowedRemoteAddress ${quote(address)} -PublicKeyPath ${quote(key)} -WhatIf`,
  );
}

test("VM SSH script parses with Windows PowerShell", windowsOnly, () => {
  for (const file of [
    script,
    path.join(bundle, "Start-Setup.ps1"),
    prepareBundle,
  ]) {
    const result = powershell(
      `$tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(file)}, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test("VM launcher requests elevation and reports UAC failures", () => {
  const launcher = fs.readFileSync(
    path.join(bundle, "Start-Setup.ps1"),
    "utf8",
  );
  const bat = fs.readFileSync(path.join(bundle, "START.bat"), "utf8");
  assert.match(bat, /-File "%~dp0Start-Setup\.ps1"/);
  assert.match(launcher, /-Verb RunAs -Wait -PassThru/);
  assert.match(launcher, /if \(\$process\.ExitCode -ne 0\)/);
  assert.match(launcher, /exit \$result/);
});

test(
  "Host preparation creates a protected key and public-only VM bundle",
  windowsOnly,
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "VM's bundle "));
    const keys = path.join(directory, "keys");
    const staged = path.join(directory, "setup");
    fs.mkdirSync(keys);
    fs.cpSync(bundle, staged, { recursive: true });
    try {
      const oldPublicKey = fs.readFileSync(
        path.join(staged, "solunaremote-vm-v2.pub"),
        "utf8",
      );
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(staged, "Prepare-Host.ps1"),
          "-KeyRoot",
          keys,
          "-NoPassphrase",
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const keyDirectory = path.join(keys, fs.readdirSync(keys)[0]);
      const privateKey = path.join(keyDirectory, "id_ed25519");
      const stagedKey = path.join(staged, "solunaremote-vm-v2.pub");
      assert.ok(fs.existsSync(privateKey));
      assert.equal(
        fs.readFileSync(stagedKey, "utf8"),
        fs.readFileSync(`${privateKey}.pub`, "utf8"),
      );
      assert.equal(
        fs.readFileSync(path.join(keyDirectory, "previous-bundle.pub"), "utf8"),
        oldPublicKey,
      );
      assert.deepEqual(fs.readdirSync(staged).sort(), [
        "Enable-VmSsh.ps1",
        "PREPARE-HOST.bat",
        "Prepare-Host.ps1",
        "README.txt",
        "START.bat",
        "Start-Setup.ps1",
        "settings.json",
        "solunaremote-vm-v2.pub",
        "vm-deploy.pub",
      ]);
      const check = powershell(
        `$acl = Get-Acl -LiteralPath ${quote(keyDirectory)}; if (-not $acl.AreAccessRulesProtected) { throw 'Key directory inherits permissions' }; $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])); if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Unexpected key directory permissions' }; & ${quote(path.join(staged, "Start-Setup.ps1"))} -WhatIf`,
      );
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /172\.22\.96\.1/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Host-key repair sets protected admin ownership and SYSTEM access without changing keys",
  windowsOnly,
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ssh-key-acl-test-"),
    );
    const names = [
      "ssh_host_rsa_key",
      "ssh_host_ecdsa_key",
      "ssh_host_ed25519_key",
      "ssh_host_ed25519_key.pub",
      "unrelated.txt",
    ];
    try {
      for (const name of names)
        fs.writeFileSync(path.join(directory, name), name);
      const result = powershell(`
      $ErrorActionPreference = 'Stop'
      $tokens = $null; $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
      $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Repair-VmSshHostKeyPermissions'
      }, $true)
      Invoke-Expression $definition.Extent.Text
      $global:count = 0
      function Set-Acl {
        param($LiteralPath, $AclObject)
        if ($AclObject.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544') { throw 'Incorrect owner' }
        if (-not $AclObject.AreAccessRulesProtected) { throw 'Inheritance was not disabled' }
        $rules = @($AclObject.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        if ($rules.Count -ne 2) { throw 'Unexpected ACL entries' }
        $sids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)
        if (($sids -join ',') -ne 'S-1-5-18,S-1-5-32-544') { throw 'Unexpected principal' }
        foreach ($rule in $rules) {
          if ($rule.AccessControlType -ne 'Allow' -or
              $rule.FileSystemRights -ne 'FullControl' -or $rule.IsInherited) { throw 'Wrong file permissions' }
        }
        if ((Split-Path $LiteralPath -Leaf) -notin @('ssh_host_rsa_key','ssh_host_ecdsa_key','ssh_host_ed25519_key')) { throw 'Unrelated file changed' }
        $global:count++
      }
      Repair-VmSshHostKeyPermissions -Directory ${quote(directory)}
      Repair-VmSshHostKeyPermissions -Directory ${quote(directory)}
      if ($global:count -ne 6) { throw 'Did not repair each private key on both runs' }
      function Set-Acl { param($LiteralPath, $AclObject) throw 'mock access denied' }
      try { Repair-VmSshHostKeyPermissions -Directory ${quote(directory)}; throw 'Unexpected success' }
      catch { if ($_.Exception.Message -ne 'mock access denied') { throw } }
      Write-Output 'ACL repair and error propagation verified'
    `);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ACL repair and error propagation verified/);
      for (const name of names)
        assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), name);
      const source = fs.readFileSync(script, "utf8");
      const generation = source.indexOf("& $sshKeygen -A");
      const repair = source.indexOf(
        "Repair-VmSshHostKeyPermissions -Directory $sshDirectory",
        generation,
      );
      assert.ok(generation >= 0 && repair > generation);
      assert.ok(repair < source.indexOf("& $sshd -t -f $config", generation));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "SSH startup failure preserves its error and collects service diagnostics",
  windowsOnly,
  () => {
    const result = powershell(`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
    $definition = $ast.Find({ param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-VmSshService'
    }, $true)
    Invoke-Expression $definition.Extent.Text
    function Invoke-VmSshDebug { param($Executable, $Configuration) Write-Output 'Foreground diagnostics requested' }
    function Invoke-VmSshServiceLog { param($Executable, $Configuration) Write-Output 'LocalSystem diagnostics requested' }
    function Start-Service { param($Name) throw 'mock sshd startup failure 1067' }
    function Get-CimInstance { param($ClassName, $Filter)
      [pscustomobject]@{ Name='sshd'; State='Stopped'; StartMode='Auto'; StartName='LocalSystem'; PathName='sshd.exe'; ExitCode=1067; ServiceSpecificExitCode=5 }
    }
    function Get-WinEvent { param($FilterHashtable, $MaxEvents, $ErrorAction)
      if ($FilterHashtable.LogName -eq 'OpenSSH/Admin') { throw 'mock missing event log' }
      [pscustomobject]@{ TimeCreated=(Get-Date); Id=7000; LevelDisplayName='Error'; Message='mock service access denied' }
    }
    try { Start-VmSshService; throw 'Unexpected success' }
    catch {
      if ($_.Exception.Message -ne 'mock sshd startup failure 1067') { throw }
      Write-Output 'Original startup failure preserved'
    }
  `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SSH SERVICE STARTUP DIAGNOSTICS/);
    assert.match(result.stdout, /ExitCode\s*:\s*1067/);
    assert.match(result.stdout, /mock service access denied/);
    assert.match(result.stdout, /mock missing event log/);
    assert.match(result.stdout, /Original startup failure preserved/);
    assert.match(result.stdout, /Foreground diagnostics requested/);
    assert.match(result.stdout, /LocalSystem diagnostics requested/);
  },
);

test(
  "SSH foreground diagnostics reject non-loopback listeners",
  windowsOnly,
  () => {
    const result = powershell(`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
    $definition = $ast.Find({ param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-VmSshDebug'
    }, $true)
    Invoke-Expression $definition.Extent.Text
    function Mock-Sshd { $global:LASTEXITCODE = 0; 'listenaddress 0.0.0.0:22222' }
    function Start-Process { throw 'UNSAFE PROCESS STARTED' }
    Invoke-VmSshDebug -Executable Mock-Sshd -Configuration 'unused'
  `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would listen outside/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /UNSAFE PROCESS STARTED/,
    );
  },
);

test(
  "LocalSystem logging restores the service command after failed and successful retries",
  windowsOnly,
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ssh-service-test-"),
    );
    try {
      const result = powershell(`
      $ErrorActionPreference = 'Stop'
      $tokens = $null; $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
      $definition = $ast.Find({ param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-VmSshServiceLog'
      }, $true)
      Invoke-Expression $definition.Extent.Text
      function Get-CimInstance {
        param($ClassName, $Filter)
        [pscustomobject]@{ State='Stopped'; StartName='LocalSystem'; PathName='C:\\Windows\\System32\\OpenSSH\\sshd.exe' }
      }
      function Set-Acl { param($LiteralPath, $AclObject) }
      function Invoke-CimMethod {
        param($InputObject, $MethodName, $Arguments)
        $global:changes += $Arguments.PathName
        [pscustomobject]@{ ReturnValue=0 }
      }
      function Start-Service {
        param($Name)
        if ($global:failStart) { throw 'mock 1067' }
      }
      function Get-Service {
        param($Name)
        if ($global:failStart) { [pscustomobject]@{ Status='Stopped' } }
        else { [pscustomobject]@{ Status='Running' } }
      }
      function Stop-Service { param($Name) $global:stopped = $true }
      foreach ($fail in @($true, $false)) {
        $global:failStart = $fail
        $global:changes = @()
        $global:stopped = $false
        Invoke-VmSshServiceLog -Executable 'C:\\Windows\\System32\\OpenSSH\\sshd.exe' -Configuration ${quote(path.join(directory, "sshd_config"))}
        if ($global:changes.Count -ne 2 -or $global:changes[0] -notlike '* -E *' -or
            $global:changes[1] -ne 'C:\\Windows\\System32\\OpenSSH\\sshd.exe') { throw 'Service command was not restored' }
        if (-not $fail -and -not $global:stopped) { throw 'Diagnostic service was left running' }
      }
      Write-Output 'Service retry restoration verified'
    `);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Service retry restoration verified/);
      assert.match(result.stdout, /Service logging retry failed: mock 1067/);
      assert.match(result.stdout, /Original SSH service command restored/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "SSH foreground diagnostics capture errors and stop only their timed-out child",
  windowsOnly,
  () => {
    const result = powershell(`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
    $definition = $ast.Find({ param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-VmSshDebug'
    }, $true)
    Invoke-Expression $definition.Extent.Text
    function Mock-Sshd { $global:LASTEXITCODE = 0; 'listenaddress 127.0.0.1:22222' }
    function Start-Process {
      param($FilePath, $ArgumentList, $RedirectStandardOutput, $RedirectStandardError, [switch]$NoNewWindow, [switch]$PassThru)
      if ($ArgumentList -notlike '-ddd -e *') { throw 'Debug flags missing' }
      $global:debugDirectory = Split-Path $RedirectStandardError
      Set-Content -LiteralPath $RedirectStandardError -Value 'fatal: mock host-key permission error'
      Set-Content -LiteralPath $RedirectStandardOutput -Value 'mock debug stdout'
      $process = [pscustomobject]@{ Id=987654; HasExited=$global:exits; ExitCode=255 }
      $process | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $this.HasExited }
      $process | Add-Member ScriptMethod Dispose {}
      return $process
    }
    function Stop-Process {
      param($Id, [switch]$Force, $ErrorAction)
      if ($Id -ne 987654) { throw 'Wrong process stopped' }
      Write-Output 'Stopped owned debug child'
    }
    foreach ($exits in @($true, $false)) {
      $global:exits = $exits
      Invoke-VmSshDebug -Executable Mock-Sshd -Configuration 'test config'
      if (Test-Path -LiteralPath $global:debugDirectory) { throw 'Debug files not cleaned up' }
    }
  `);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fatal: mock host-key permission error/);
    assert.match(result.stdout, /Debug process exit code: 255/);
    assert.match(result.stdout, /does NOT prove/);
    assert.match(result.stdout, /Stopped owned debug child/);
  },
);

test(
  "VM SSH bundle BAT runs from another working directory without changes",
  windowsOnly,
  () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "VM's SSH setup "));
    try {
      fs.cpSync(bundle, directory, { recursive: true });
      const result = spawnSync(
        process.env.ComSpec,
        ["/d", "/c", `""${path.join(directory, "START.bat")}" --check"`],
        {
          cwd: os.tmpdir(),
          encoding: "utf8",
          timeout: 30000,
          windowsVerbatimArguments: true,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /172\.22\.96\.1/);
      assert.equal(fs.existsSync(path.join(directory, "setup.log")), false);
      assert.deepEqual(
        fs.readdirSync(directory).sort(),
        fs.readdirSync(bundle).sort(),
      );

      fs.rmSync(path.join(directory, "solunaremote-vm-v2.pub"));
      const failure = powershell(
        `& ${quote(path.join(directory, "Start-Setup.ps1"))} -WhatIf`,
      );
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /Setup files are missing/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "VM SSH preview accepts the configured public key without elevation",
  windowsOnly,
  () => {
    const result = preview("172.22.96.1");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /172\.22\.96\.1/);
  },
);

test(
  "VM SSH rejects broad and invalid firewall sources before making changes",
  windowsOnly,
  () => {
    for (const address of [
      "Any",
      "10.0.0.0/8",
      "0.0.0.0",
      "127.0.0.1",
      "::1",
    ]) {
      const result = preview(address);
      assert.notEqual(result.status, 0, address);
      assert.match(result.stderr, /Specify individual source IPv4 addresses/);
    }
  },
);

test(
  "VM SSH rejects private keys and malformed public keys",
  windowsOnly,
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "solunaremote-ssh-test-"),
    );
    const key = path.join(directory, "invalid.pub");
    try {
      for (const content of [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "ssh-ed25519 AAAA invalid",
        `${fs.readFileSync(publicKey, "utf8").trim()}\nsecond line`,
      ]) {
        fs.writeFileSync(key, content);
        const result = preview("172.22.96.1", key);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /public key|public key encoding/);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
