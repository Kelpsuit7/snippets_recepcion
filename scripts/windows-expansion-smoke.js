const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');

const ROOT = path.resolve(__dirname, '..');
const TRIGGER = 'vetsmoke';
const REPLACEMENT = 'VETSNIPPETS_SMOKE_OK';
const USE_DOUBLE_SHIFT = process.argv.includes('--double');

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

function getNotepadProcessIds() {
  const output = runPowerShell(
    "Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }; exit 0"
  );

  return new Set(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10))
  );
}

function getNewNotepadProcessId(previousIds) {
  const currentIds = [...getNotepadProcessIds()];
  return currentIds.find((processId) => !previousIds.has(processId)) || null;
}

function focusWindow(processId) {
  runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SmokeWindowNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
"@
$process = Get-Process -Id ${processId} -ErrorAction Stop
[void][SmokeWindowNative]::ShowWindowAsync($process.MainWindowHandle, 9)
[void][SmokeWindowNative]::SetForegroundWindow($process.MainWindowHandle)
`);
}

function readNotepadText(processId) {
  const encoded = runPowerShell(`
Add-Type -AssemblyName UIAutomationClient
$process = Get-Process -Id ${processId} -ErrorAction Stop
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
$document = $root.FindFirst(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$queue = [System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]]::new()
$queue.Enqueue($root)
$text = ''
while ($queue.Count -gt 0 -and -not $text) {
  $element = $queue.Dequeue()
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
    $text = $pattern.DocumentRange.GetText(-1)
    break
  }
  $child = $walker.GetFirstChild($element)
  while ($null -ne $child) {
    $queue.Enqueue($child)
    $child = $walker.GetNextSibling($child)
  }
}
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
`);

  return Buffer.from(encoded, 'base64').toString('utf8').trim();
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

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Esta prueba de integracion solo funciona en Windows.');
  }

  const temporaryUserData = fs.mkdtempSync(
    path.join(os.tmpdir(), 'vetsnippets-smoke-')
  );
  const previousNotepadIds = getNotepadProcessIds();
  const electronPath = path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  );
  let electronProcess = null;
  let notepadProcessId = null;
  const electronEnvironment = { ...process.env };

  delete electronEnvironment.ELECTRON_RUN_AS_NODE;
  Object.assign(electronEnvironment, {
    VETSNIPPETS_ALLOW_MULTIPLE: '1',
    VETSNIPPETS_DISABLE_STARTUP: '1',
    VETSNIPPETS_USER_DATA: temporaryUserData,
  });

  fs.writeFileSync(
    path.join(temporaryUserData, 'snippets.json'),
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
  fs.writeFileSync(
    path.join(temporaryUserData, 'collections.json'),
    '[]',
    'utf8'
  );
  fs.writeFileSync(
    path.join(temporaryUserData, 'settings.json'),
    JSON.stringify({
      expansionEnabled: true,
      showSuggestion: false,
      activationMode: USE_DOUBLE_SHIFT ? 'double-shift' : 'shift',
      theme: 'mint',
    }),
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

    spawn('notepad.exe', [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    await delay(1800);

    notepadProcessId = getNewNotepadProcessId(previousNotepadIds);
    assert.ok(notepadProcessId, 'No se pudo identificar la nueva instancia de Bloc de notas.');
    focusWindow(notepadProcessId);
    await delay(400);

    keyboard.config.autoDelayMs = 35;
    await keyboard.pressKey(Key.LeftControl, Key.A);
    await keyboard.releaseKey(Key.LeftControl, Key.A);
    await keyboard.pressKey(Key.Backspace);
    await keyboard.releaseKey(Key.Backspace);
    await delay(300);
    await keyboard.type(TRIGGER);
    await keyboard.pressKey(Key.LeftShift);
    await keyboard.releaseKey(Key.LeftShift);
    if (USE_DOUBLE_SHIFT) {
      await delay(120);
      await keyboard.pressKey(Key.LeftShift);
      await keyboard.releaseKey(Key.LeftShift);
    }
    await delay(1200);

    const actualText = readNotepadText(notepadProcessId);
    if (actualText !== REPLACEMENT) {
      const diagnosticsPath = path.join(temporaryUserData, 'diagnostics.log');
      if (fs.existsSync(diagnosticsPath)) {
        process.stderr.write(fs.readFileSync(diagnosticsPath, 'utf8'));
      }
    }
    assert.equal(actualText, REPLACEMENT);
    process.stdout.write(
      `Expansion real en Bloc de notas (${USE_DOUBLE_SHIFT ? 'doble Shift' : 'Shift'}): OK\n`
    );
  } finally {
    if (notepadProcessId) {
      stopProcessTree(notepadProcessId);
    }
    if (electronProcess?.pid) {
      stopProcessTree(electronProcess.pid);
    }
    fs.rmSync(temporaryUserData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
