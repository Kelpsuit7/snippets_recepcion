const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');

const ROOT = path.resolve(__dirname, '..');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TRIGGER = 'vetedge';
const REPLACEMENT = 'VETSNIPPETS_EDGE_OK';

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runPowerShell(script) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  ).trim();
}

function getEdgeWindow() {
  const output = runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EdgeSmokeWindowAudit {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  public static string Find() {
    IntPtr found = IntPtr.Zero;
    uint processId = 0;
    EnumWindows((window, data) => {
      var title = new StringBuilder(512);
      GetWindowText(window, title, title.Capacity);
      if (IsWindowVisible(window) && title.ToString().StartsWith("VetSnippets Edge Smoke")) {
        found = window;
        GetWindowThreadProcessId(window, out processId);
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found.ToInt64().ToString() + "|" + processId.ToString();
  }
}
"@
[EdgeSmokeWindowAudit]::Find()
`);
  const [handle, processId] = output.split('|').map((value) => Number.parseInt(value, 10));

  return handle && processId ? { handle, processId } : null;
}

function focusWindow(windowHandle) {
  runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class EdgeSmokeWindowNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
"@
$window = [IntPtr]${windowHandle}
[void][EdgeSmokeWindowNative]::ShowWindowAsync($window, 9)
[void][EdgeSmokeWindowNative]::SetForegroundWindow($window)
`);
}

function focusEdgeInput(windowHandle) {
  runPowerShell(`
Add-Type -AssemblyName UIAutomationClient
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${windowHandle})
$editCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit
)
$focusableCondition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
  $true
)
$condition = New-Object System.Windows.Automation.AndCondition(
  $editCondition,
  $focusableCondition
)
$input = $root.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  $condition
)
if ($null -eq $input) {
  throw 'No se encontro el textarea de prueba.'
}
$input.SetFocus()
`);
}

function readWindowTitle(windowHandle) {
  return runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EdgeSmokeWindowTitle {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
}
"@
$title = [Text.StringBuilder]::new(512)
[void][EdgeSmokeWindowTitle]::GetWindowText([IntPtr]${windowHandle}, $title, $title.Capacity)
$title.ToString()
`);
}

function stopProcessTree(processId) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(processId), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (error) {
    // The process may already have exited.
  }
}

function stopEdgeProfile(userDataPath) {
  const escapedPath = userDataPath.replace(/'/g, "''");

  try {
    runPowerShell(`
$profilePath = '${escapedPath}'
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like "*$profilePath*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`);
  } catch (error) {
    // Cleanup continues with retries below.
  }
}

async function removeDirectoryWithRetries(directoryPath) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directoryPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await delay(300);
    }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Esta prueba de integracion solo funciona en Windows.');
  }
  if (!fs.existsSync(EDGE_PATH)) {
    throw new Error(`Microsoft Edge no esta disponible en ${EDGE_PATH}.`);
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vetsnippets-edge-'));
  const appUserData = path.join(temporaryRoot, 'app-data');
  const edgeUserData = path.join(temporaryRoot, 'edge-data');
  const targetPath = path.join(temporaryRoot, 'target.html');
  const electronPath = path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  );
  let electronProcess = null;
  let edgeProcess = null;
  let edgeWindowProcessId = null;
  let edgeWindowHandle = null;
  const electronEnvironment = { ...process.env };

  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  Object.assign(electronEnvironment, {
    VETSNIPPETS_ALLOW_MULTIPLE: '1',
    VETSNIPPETS_DISABLE_STARTUP: '1',
    VETSNIPPETS_USER_DATA: appUserData,
  });

  fs.mkdirSync(appUserData, { recursive: true });
  fs.writeFileSync(
    path.join(appUserData, 'snippets.json'),
    JSON.stringify([
      {
        trigger: TRIGGER,
        text: REPLACEMENT,
        label: TRIGGER,
        collectionId: '',
      },
    ]),
    'utf8'
  );
  fs.writeFileSync(path.join(appUserData, 'collections.json'), '[]', 'utf8');
  fs.writeFileSync(
    path.join(appUserData, 'settings.json'),
    JSON.stringify({
      expansionEnabled: true,
      showSuggestion: true,
      activationMode: 'shift',
      theme: 'mint',
    }),
    'utf8'
  );
  fs.writeFileSync(
    targetPath,
    `<!doctype html>
<meta charset="utf-8">
<title>VetSnippets Edge Smoke</title>
<textarea id="target" autofocus></textarea>
<script>
  const target = document.getElementById('target');
  target.addEventListener('input', () => {
    document.title = target.value
      ? 'VetSnippets Edge Smoke: ' + target.value
      : 'VetSnippets Edge Smoke';
  });
  target.focus();
</script>`,
    'utf8'
  );

  try {
    electronProcess = spawn(electronPath, ['.', '--background'], {
      cwd: ROOT,
      env: electronEnvironment,
      stdio: 'ignore',
      windowsHide: true,
    });
    await delay(3500);
    assert.equal(
      electronProcess.exitCode,
      null,
      `La instancia aislada de Electron termino con codigo ${electronProcess.exitCode}.`
    );

    edgeProcess = spawn(
      EDGE_PATH,
      [
        `--user-data-dir=${edgeUserData}`,
        '--disable-background-mode',
        '--disable-extensions',
        '--force-renderer-accessibility',
        '--no-default-browser-check',
        '--no-first-run',
        `--app=${pathToFileURL(targetPath).href}`,
      ],
      {
        stdio: 'ignore',
        windowsHide: false,
      }
    );
    await delay(3500);

    const edgeWindow = getEdgeWindow();
    assert.ok(edgeWindow, 'No se encontro la ventana de prueba de Edge.');
    edgeWindowProcessId = edgeWindow.processId;
    edgeWindowHandle = edgeWindow.handle;
    focusWindow(edgeWindowHandle);
    await delay(500);
    focusEdgeInput(edgeWindowHandle);
    await delay(300);

    keyboard.config.autoDelayMs = 35;
    await keyboard.type(TRIGGER);
    await keyboard.pressKey(Key.LeftShift);
    await keyboard.releaseKey(Key.LeftShift);
    await delay(1400);

    const title = readWindowTitle(edgeWindowHandle);
    const diagnostics = fs.readFileSync(
      path.join(appUserData, 'diagnostics.log'),
      'utf8'
    );
    if (!title.includes(REPLACEMENT)) {
      process.stderr.write(diagnostics);
    }
    assert.match(title, new RegExp(REPLACEMENT));
    assert.match(
      diagnostics,
      /"event":"caret-lookup-result","found":true/
    );
    process.stdout.write('Expansion real en Microsoft Edge: OK\n');
  } finally {
    if (edgeWindowProcessId) {
      stopProcessTree(edgeWindowProcessId);
    }
    if (edgeProcess?.pid && edgeProcess.pid !== edgeWindowProcessId) {
      stopProcessTree(edgeProcess.pid);
    }
    stopEdgeProfile(edgeUserData);
    if (electronProcess?.pid) {
      stopProcessTree(electronProcess.pid);
    }
    await removeDirectoryWithRetries(temporaryRoot);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
