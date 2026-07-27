const electron = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  csvEscape,
  findBestMatchingSnippet,
  normalizeActivationMode,
  normalizeForMatch,
  parseCsv,
  resolveShiftActivation,
} = require('./lib/snippet-core');

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  screen,
  Tray,
} = electron;
const ipcMain = electron.ipcMain || app.ipcMain;

if (process.env.VETSNIPPETS_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.VETSNIPPETS_USER_DATA));
}

const MAX_BUFFER_LENGTH = 20;
const SUGGESTION_WIDTH = 136;
const SUGGESTION_HEIGHT = 34;
const CARET_OFFSET_Y = 6;
const APPROXIMATE_CHARACTER_WIDTH = 8;
const AUTOMATIC_EXPANSION_DELAY_MS = 300;
const BACKSPACE_STEP_DELAY_MS = 8;
const DOUBLE_SHIFT_WINDOW_MS = 450;
const DEFAULT_SETTINGS = {
  expansionEnabled: true,
  showSuggestion: true,
  activationMode: 'shift',
  theme: 'mint',
};
const VALID_THEMES = new Set(['mint', 'rose', 'sky', 'lavender', 'peach']);
const KEYBOARD_TRANSLATION_TIMEOUT_MS = 120;
const CARET_LOOKUP_TIMEOUT_MS = 1500;
const MAX_DIAGNOSTIC_LOG_BYTES = 1024 * 1024;

const WINDOWS_KEYBOARD_TRANSLATOR_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class KeyboardLayoutNative {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

  [DllImport("user32.dll")]
  public static extern IntPtr GetKeyboardLayout(uint idThread);

  [DllImport("user32.dll")]
  public static extern uint MapVirtualKeyEx(uint uCode, uint uMapType, IntPtr dwhkl);

  [DllImport("user32.dll")]
  public static extern short GetKeyState(int nVirtKey);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ToUnicodeEx(
    uint wVirtKey,
    uint wScanCode,
    byte[] lpKeyState,
    StringBuilder pwszBuff,
    int cchBuff,
    uint wFlags,
    IntPtr dwhkl
  );
}
"@

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $requestId = ''

  try {
    $parts = $line.Split('|')
    $requestId = $parts[0]
    $scanCode = [uint32]::Parse($parts[1])
    $shift = $parts[2] -eq '1'
    $control = $parts[3] -eq '1'
    $alt = $parts[4] -eq '1'
    $foregroundWindow = [KeyboardLayoutNative]::GetForegroundWindow()
    $threadId = [KeyboardLayoutNative]::GetWindowThreadProcessId(
      $foregroundWindow,
      [IntPtr]::Zero
    )
    $layout = [KeyboardLayoutNative]::GetKeyboardLayout($threadId)
    $virtualKey = [KeyboardLayoutNative]::MapVirtualKeyEx($scanCode, 3, $layout)
    $keyboardState = [byte[]]::new(256)

    if ($shift) {
      $keyboardState[0x10] = 0x80
    }
    if ($control) {
      $keyboardState[0x11] = 0x80
    }
    if ($alt) {
      $keyboardState[0x12] = 0x80
    }
    if (([KeyboardLayoutNative]::GetKeyState(0x14) -band 1) -ne 0) {
      $keyboardState[0x14] = 1
    }

    $buffer = [Text.StringBuilder]::new(8)
    $length = [KeyboardLayoutNative]::ToUnicodeEx(
      $virtualKey,
      $scanCode,
      $keyboardState,
      $buffer,
      $buffer.Capacity,
      0,
      $layout
    )
    $text = if ($length -gt 0) { $buffer.ToString(0, $length) } else { '' }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    [Console]::Out.WriteLine("$requestId|$encoded")
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine("$requestId|")
    [Console]::Out.Flush()
  }
}
`;

const WINDOWS_CARET_POSITION_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CaretNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public int flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }

  [DllImport("user32.dll")]
  public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

  [DllImport("user32.dll")]
  public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

  [DllImport("kernel32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

  [DllImport("user32.dll")]
  public static extern IntPtr GetFocus();

  [DllImport("user32.dll")]
  public static extern bool GetCaretPos(ref POINT point);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("oleacc.dll")]
  public static extern int AccessibleObjectFromWindow(
    IntPtr hWnd,
    uint objectId,
    ref Guid interfaceId,
    [MarshalAs(UnmanagedType.Interface)] out object accessibleObject
  );
}
"@

[void][CaretNative]::SetProcessDPIAware()
$foregroundWindow = [CaretNative]::GetForegroundWindow()
$foregroundBounds = New-Object CaretNative+RECT
$hasForegroundBounds = (
  $foregroundWindow -ne [IntPtr]::Zero -and
  [CaretNative]::GetWindowRect($foregroundWindow, [ref]$foregroundBounds)
)
$focusedTextBounds = $null

try {
  Add-Type -AssemblyName UIAutomationClient
  $focusedTextElement = [System.Windows.Automation.AutomationElement]::FocusedElement

  if (
    $null -ne $focusedTextElement -and
    $focusedTextElement.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit
  ) {
    $candidateBounds = $focusedTextElement.Current.BoundingRectangle
    if ($candidateBounds.Width -gt 0 -and $candidateBounds.Height -gt 0) {
      $focusedTextBounds = $candidateBounds
    }
  }
} catch {
  $focusedTextBounds = $null
}

function Test-CaretPoint([double]$x, [double]$y) {
  if (
    $null -ne $focusedTextBounds -and
    (
      $x -lt $focusedTextBounds.Left -or
      $x -gt $focusedTextBounds.Right -or
      $y -lt $focusedTextBounds.Top -or
      $y -gt $focusedTextBounds.Bottom
    )
  ) {
    return $false
  }

  if (-not $hasForegroundBounds) {
    return $x -ge 0 -and $y -ge 0
  }

  return (
    $x -ge $foregroundBounds.Left -and
    $x -le $foregroundBounds.Right -and
    $y -ge $foregroundBounds.Top -and
    $y -le $foregroundBounds.Bottom
  )
}

$info = New-Object CaretNative+GUITHREADINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'CaretNative+GUITHREADINFO')

if ([CaretNative]::GetGUIThreadInfo(0, [ref]$info)) {
  $point = New-Object CaretNative+POINT
  $point.X = $info.rcCaret.Left
  $point.Y = $info.rcCaret.Top

  if (
    $info.hwndCaret -ne [IntPtr]::Zero -and
    [CaretNative]::ClientToScreen($info.hwndCaret, [ref]$point) -and
    (Test-CaretPoint $point.X $point.Y)
  ) {
    "$($point.X),$($point.Y)"
    exit
  }
}

$foregroundThread = [CaretNative]::GetWindowThreadProcessId($foregroundWindow, [IntPtr]::Zero)
$currentThread = [CaretNative]::GetCurrentThreadId()

if ($foregroundThread -ne 0 -and [CaretNative]::AttachThreadInput($currentThread, $foregroundThread, $true)) {
  try {
    $focusWindow = [CaretNative]::GetFocus()
    $point = New-Object CaretNative+POINT

    $hasCaretPoint = [CaretNative]::GetCaretPos([ref]$point) -and ($point.X -ne 0 -or $point.Y -ne 0)

    if (
      $focusWindow -ne [IntPtr]::Zero -and
      $hasCaretPoint -and
      [CaretNative]::ClientToScreen($focusWindow, [ref]$point) -and
      (Test-CaretPoint $point.X $point.Y)
    ) {
      "$($point.X),$($point.Y)"
      exit
    }
  } finally {
    [void][CaretNative]::AttachThreadInput($currentThread, $foregroundThread, $false)
  }
}

try {
  $accessibleId = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'
  $accessibleObject = $null
  $caretObjectId = [uint32]0xFFFFFFF8
  $accessibleResult = [CaretNative]::AccessibleObjectFromWindow(
    $foregroundWindow,
    $caretObjectId,
    [ref]$accessibleId,
    [ref]$accessibleObject
  )

  if ($accessibleResult -eq 0 -and $null -ne $accessibleObject) {
    $left = 0
    $top = 0
    $width = 0
    $height = 0
    $accessibleObject.accLocation([ref]$left, [ref]$top, [ref]$width, [ref]$height, 0)
    $caretX = $left + [Math]::Max($width, 1)
    $hasCaretDimensions = $width -ge 0 -and $width -le 20 -and $height -ge 5 -and $height -le 120

    if ($hasCaretDimensions -and (Test-CaretPoint $caretX $top)) {
      "$caretX,$top"
      exit
    }
  }
} catch {
  # MSAA no esta disponible en todas las aplicaciones.
}

try {
  Add-Type -AssemblyName UIAutomationClient
  $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  $textPattern2 = $null

  if ($null -ne $focusedElement -and $focusedElement.TryGetCurrentPattern([System.Windows.Automation.TextPattern2]::Pattern, [ref]$textPattern2)) {
    $isActive = $false
    $caretRange = $textPattern2.GetCaretRange([ref]$isActive)
    $rectangles = $caretRange.GetBoundingRectangles()
    $useRightEdge = $false

    if ($rectangles.Length -lt 4) {
      $expandedRange = $caretRange.Clone()
      $moved = $expandedRange.MoveEndpointByUnit(
        [System.Windows.Automation.TextPatternRangeEndpoint]::Start,
        [System.Windows.Automation.TextUnit]::Character,
        -1
      )
      $rectangles = $expandedRange.GetBoundingRectangles()
      $useRightEdge = $moved -ne 0
    }

    if ($rectangles.Length -ge 4) {
      $lastRectangle = $rectangles.Length - 4
      $caretX = [Math]::Round(
        $rectangles[$lastRectangle] +
        $(if ($useRightEdge) { $rectangles[$lastRectangle + 2] } else { 0 })
      )
      $caretY = [Math]::Round($rectangles[$lastRectangle + 1])
      if (Test-CaretPoint $caretX $caretY) {
        "$caretX,$caretY"
        exit
      }
    }
  }
} catch {
  # TextPattern2 no esta disponible en todas las versiones o controles.
}

try {
  Add-Type -AssemblyName UIAutomationClient
  $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
  $textPattern = $null

  if ($null -ne $focusedElement -and $focusedElement.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
    $selection = $textPattern.GetSelection()

    if ($selection.Count -gt 0) {
      $caretRange = $selection[0].Clone()
      [void]$caretRange.MoveEndpointByUnit(
        [System.Windows.Automation.TextPatternRangeEndpoint]::Start,
        [System.Windows.Automation.TextUnit]::Character,
        -1
      )
      $rectangles = $caretRange.GetBoundingRectangles()

      if ($rectangles.Length -ge 4) {
        $lastRectangle = $rectangles.Length - 4
        $caretX = [Math]::Round($rectangles[$lastRectangle] + $rectangles[$lastRectangle + 2])
        $caretY = [Math]::Round($rectangles[$lastRectangle + 1])
        if (Test-CaretPoint $caretX $caretY) {
          "$caretX,$caretY"
          exit
        }
      }
    }
  }

} catch {
  # Algunas aplicaciones no exponen un patron de texto mediante UI Automation.
}

try {
  $valuePattern = $null

  if (
    $null -ne $focusedTextElement -and
    $null -ne $focusedTextBounds -and
    $focusedTextElement.TryGetCurrentPattern(
      [System.Windows.Automation.ValuePattern]::Pattern,
      [ref]$valuePattern
    )
  ) {
    $value = [string]$valuePattern.Current.Value
    $logicalLines = $value -split "\r?\n"
    $lastLine = if ($logicalLines.Count -gt 0) {
      $logicalLines[$logicalLines.Count - 1]
    } else {
      ''
    }
    $horizontalPadding = 7
    $verticalPadding = 7
    $characterWidth = 8
    $lineHeight = 20
    $usableWidth = [Math]::Max($focusedTextBounds.Width - ($horizontalPadding * 2), $characterWidth)
    $charactersPerLine = [Math]::Max([Math]::Floor($usableWidth / $characterWidth), 1)
    $wrappedLine = [Math]::Floor($lastLine.Length / $charactersPerLine)
    $lineStart = $wrappedLine * $charactersPerLine
    $column = $lastLine.Length - $lineStart
    $caretX = [Math]::Round(
      $focusedTextBounds.Left +
      $horizontalPadding +
      [Math]::Min($column * $characterWidth, $usableWidth)
    )
    $caretY = [Math]::Round(
      [Math]::Min(
        $focusedTextBounds.Top + $verticalPadding + ($wrappedLine * $lineHeight),
        $focusedTextBounds.Bottom - $verticalPadding
      )
    )

    if (Test-CaretPoint $caretX $caretY) {
      "$caretX,$caretY"
      exit
    }
  }
} catch {
  # Respaldo limitado al contenido y limites del editor enfocado.
}
`;

keyboard.config.autoDelayMs = 0;

let mainWindow = null;
let suggestionWindow = null;
let tray = null;
let isQuitting = false;
let snippets = [];
let collections = [];
let settings = { ...DEFAULT_SETTINGS };
let keyboardBuffer = '';
let isExpandingSnippet = false;
let listenerStarted = false;
const activeShiftKeys = new Set();
let shiftChordUsed = false;
let lastCleanShiftReleaseAt = 0;
let devReloadTimer = null;
let snippetsPath = '';
let collectionsPath = '';
let settingsPath = '';
let diagnosticsPath = '';
let pendingCsvImport = null;
let automaticExpansionTimer = null;
let rendererCaretPosition = null;
let suggestionUpdateTimer = null;
let keyboardTranslatorProcess = null;
let keyboardTranslatorOutput = '';
let keyboardTranslationRequestId = 0;
let inputEventQueue = Promise.resolve();
const pendingKeyboardTranslations = new Map();
let caretTrackerProcess = null;
let caretTrackerOutput = '';
let caretLookupRequestId = 0;
let hasLoggedCaretLookupResult = false;
const pendingCaretLookups = new Map();

function getDiagnosticsPath() {
  if (!diagnosticsPath) {
    diagnosticsPath = path.join(app.getPath('userData'), 'diagnostics.log');
  }

  return diagnosticsPath;
}

function normalizeDiagnosticDetails(details) {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => {
      if (value instanceof Error) {
        return [key, {
          name: value.name,
          message: value.message,
          stack: value.stack,
        }];
      }

      return [key, value];
    })
  );
}

function writeDiagnostic(event, details = {}) {
  try {
    const filePath = getDiagnosticsPath();
    const backupPath = `${filePath}.1`;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (
      fs.existsSync(filePath)
      && fs.statSync(filePath).size >= MAX_DIAGNOSTIC_LOG_BYTES
    ) {
      fs.rmSync(backupPath, { force: true });
      fs.renameSync(filePath, backupPath);
    }

    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...normalizeDiagnosticDetails(details),
      })}\n`,
      'utf8'
    );
  } catch (error) {
    console.error('No se pudo escribir el diagnostico:', error);
  }
}

function keyCode(names, fallback) {
  const candidates = Array.isArray(names) ? names : [names];

  for (const name of candidates) {
    if (UiohookKey[name] !== undefined) {
      return UiohookKey[name];
    }
  }

  return fallback;
}

const KEY = {
  Escape: keyCode('Escape', 1),
  Digit1: keyCode(['Digit1', 'Key1', 'Num1', 'One'], 2),
  Digit2: keyCode(['Digit2', 'Key2', 'Num2', 'Two'], 3),
  Digit3: keyCode(['Digit3', 'Key3', 'Num3', 'Three'], 4),
  Digit4: keyCode(['Digit4', 'Key4', 'Num4', 'Four'], 5),
  Digit5: keyCode(['Digit5', 'Key5', 'Num5', 'Five'], 6),
  Digit6: keyCode(['Digit6', 'Key6', 'Num6', 'Six'], 7),
  Digit7: keyCode(['Digit7', 'Key7', 'Num7', 'Seven'], 8),
  Digit8: keyCode(['Digit8', 'Key8', 'Num8', 'Eight'], 9),
  Digit9: keyCode(['Digit9', 'Key9', 'Num9', 'Nine'], 10),
  Digit0: keyCode(['Digit0', 'Key0', 'Num0', 'Zero'], 11),
  Minus: keyCode('Minus', 12),
  Equal: keyCode(['Equal', 'Equals'], 13),
  Backspace: keyCode('Backspace', 14),
  ShiftLeft: keyCode(['Shift', 'ShiftLeft', 'LeftShift'], 42),
  ShiftRight: keyCode(['ShiftRight', 'RightShift'], 54),
  BracketLeft: keyCode(['BracketLeft', 'OpenBracket'], 26),
  BracketRight: keyCode(['BracketRight', 'CloseBracket'], 27),
  Enter: keyCode('Enter', 28),
  Semicolon: keyCode('Semicolon', 39),
  Quote: keyCode('Quote', 40),
  Backquote: keyCode(['Backquote', 'Grave'], 41),
  Backslash: keyCode('Backslash', 43),
  Comma: keyCode('Comma', 51),
  Period: keyCode('Period', 52),
  Slash: keyCode('Slash', 53),
  Space: keyCode('Space', 57),
  PageUp: keyCode('PageUp', 3657),
  PageDown: keyCode('PageDown', 3665),
  End: keyCode('End', 3663),
  Home: keyCode('Home', 3655),
  Insert: keyCode('Insert', 3666),
  Delete: keyCode('Delete', 3667),
  ArrowLeft: keyCode('ArrowLeft', 57419),
  ArrowUp: keyCode('ArrowUp', 57416),
  ArrowRight: keyCode('ArrowRight', 57421),
  ArrowDown: keyCode('ArrowDown', 57424),
};
const CONTEXT_RESET_KEYS = new Set([
  KEY.PageUp,
  KEY.PageDown,
  KEY.End,
  KEY.Home,
  KEY.Insert,
  KEY.Delete,
  KEY.ArrowLeft,
  KEY.ArrowUp,
  KEY.ArrowRight,
  KEY.ArrowDown,
]);

function stopKeyboardTranslator() {
  if (keyboardTranslatorProcess) {
    keyboardTranslatorProcess.kill();
    keyboardTranslatorProcess = null;
  }

  pendingKeyboardTranslations.forEach(({ resolve, timer, event }) => {
    clearTimeout(timer);
    resolve(fallbackKeycodeToCharacter(event));
  });
  pendingKeyboardTranslations.clear();
  keyboardTranslatorOutput = '';
}

function handleKeyboardTranslatorOutput(chunk) {
  keyboardTranslatorOutput += chunk.toString('utf8');
  const lines = keyboardTranslatorOutput.split(/\r?\n/);
  keyboardTranslatorOutput = lines.pop() || '';

  lines.forEach((line) => {
    const separatorIndex = line.indexOf('|');

    if (separatorIndex < 0) {
      return;
    }

    const requestId = line.slice(0, separatorIndex);
    const pending = pendingKeyboardTranslations.get(requestId);

    if (!pending) {
      return;
    }

    pendingKeyboardTranslations.delete(requestId);
    clearTimeout(pending.timer);

    try {
      const encodedCharacter = line.slice(separatorIndex + 1);
      pending.resolve(Buffer.from(encodedCharacter, 'base64').toString('utf8'));
    } catch (error) {
      pending.resolve(fallbackKeycodeToCharacter(pending.event));
    }
  });
}

function startKeyboardTranslator() {
  if (process.platform !== 'win32' || keyboardTranslatorProcess) {
    return;
  }

  try {
    const translator = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_KEYBOARD_TRANSLATOR_SCRIPT,
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    );

    keyboardTranslatorProcess = translator;
    writeDiagnostic('keyboard-translator-started');
    translator.stdout.on('data', handleKeyboardTranslatorOutput);
    translator.on('error', (error) => {
      console.error('No se pudo iniciar el traductor de teclado:', error);
      writeDiagnostic('keyboard-translator-error', { error });
      stopKeyboardTranslator();
    });
    translator.on('exit', (code, signal) => {
      if (keyboardTranslatorProcess === translator) {
        writeDiagnostic('keyboard-translator-exit', { code, signal });
        stopKeyboardTranslator();
      }
    });
  } catch (error) {
    console.error('No se pudo iniciar el traductor de teclado:', error);
    writeDiagnostic('keyboard-translator-error', { error });
    stopKeyboardTranslator();
  }
}

function translateKeyEvent(event) {
  if (
    process.platform !== 'win32'
    || !keyboardTranslatorProcess
    || !keyboardTranslatorProcess.stdin.writable
  ) {
    return Promise.resolve(fallbackKeycodeToCharacter(event));
  }

  keyboardTranslationRequestId += 1;
  const requestId = String(keyboardTranslationRequestId);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingKeyboardTranslations.delete(requestId);
      resolve(fallbackKeycodeToCharacter(event));
    }, KEYBOARD_TRANSLATION_TIMEOUT_MS);

    pendingKeyboardTranslations.set(requestId, { resolve, timer, event });

    keyboardTranslatorProcess.stdin.write([
      requestId,
      event.keycode,
      event.shiftKey ? 1 : 0,
      event.ctrlKey ? 1 : 0,
      event.altKey ? 1 : 0,
    ].join('|') + '\n', (error) => {
      if (!error) {
        return;
      }

      const pending = pendingKeyboardTranslations.get(requestId);
      if (pending) {
        pendingKeyboardTranslations.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(fallbackKeycodeToCharacter(event));
      }
    });
  });
}

function enqueueInputEvent(handler, event) {
  inputEventQueue = inputEventQueue
    .then(() => handler(event))
    .catch((error) => {
      console.error('No se pudo procesar una entrada global:', error);
    });
}

function buildWindowsCaretTrackerScript() {
  const lookupMarker = '[void][CaretNative]::SetProcessDPIAware()';
  const markerIndex = WINDOWS_CARET_POSITION_SCRIPT.indexOf(lookupMarker);

  if (markerIndex < 0) {
    throw new Error('No se encontro el bloque de consulta del cursor.');
  }

  const nativeDefinition = WINDOWS_CARET_POSITION_SCRIPT.slice(0, markerIndex);
  const lookupScript = WINDOWS_CARET_POSITION_SCRIPT
    .slice(markerIndex)
    .replace(/\bexit\b/g, 'return');

  return `${nativeDefinition}
while (($requestId = [Console]::In.ReadLine()) -ne $null) {
  try {
    $point = & {
${lookupScript}
    } | Select-Object -First 1
    [Console]::Out.WriteLine("$requestId|$point")
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine("$requestId|")
    [Console]::Out.Flush()
  }
}`;
}

function stopCaretTracker() {
  if (caretTrackerProcess) {
    caretTrackerProcess.kill();
    caretTrackerProcess = null;
  }

  pendingCaretLookups.forEach(({ resolve, timer }) => {
    clearTimeout(timer);
    resolve(null);
  });
  pendingCaretLookups.clear();
  caretTrackerOutput = '';
}

function handleCaretTrackerOutput(chunk) {
  caretTrackerOutput += chunk.toString('utf8');
  const lines = caretTrackerOutput.split(/\r?\n/);
  caretTrackerOutput = lines.pop() || '';

  lines.forEach((line) => {
    const separatorIndex = line.indexOf('|');

    if (separatorIndex < 0) {
      return;
    }

    const requestId = line.slice(0, separatorIndex);
    const pending = pendingCaretLookups.get(requestId);

    if (!pending) {
      return;
    }

    pendingCaretLookups.delete(requestId);
    clearTimeout(pending.timer);
    const [x, y] = line
      .slice(separatorIndex + 1)
      .split(',')
      .map((value) => Number.parseInt(value, 10));
    const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;

    if (!hasLoggedCaretLookupResult) {
      hasLoggedCaretLookupResult = true;
      writeDiagnostic('caret-lookup-result', { found: Boolean(point) });
    }

    pending.resolve(point);
  });
}

function startCaretTracker() {
  if (process.platform !== 'win32' || caretTrackerProcess) {
    return;
  }

  try {
    const tracker = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildWindowsCaretTrackerScript(),
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    );

    caretTrackerProcess = tracker;
    writeDiagnostic('caret-tracker-started');
    tracker.stdout.on('data', handleCaretTrackerOutput);
    tracker.on('error', (error) => {
      console.error('No se pudo iniciar el detector de cursor:', error);
      writeDiagnostic('caret-tracker-error', { error });
      stopCaretTracker();
    });
    tracker.on('exit', (code, signal) => {
      if (caretTrackerProcess === tracker) {
        writeDiagnostic('caret-tracker-exit', { code, signal });
        stopCaretTracker();
      }
    });
  } catch (error) {
    console.error('No se pudo iniciar el detector de cursor:', error);
    writeDiagnostic('caret-tracker-error', { error });
    stopCaretTracker();
  }
}

function requestTextCaretScreenPoint() {
  if (
    process.platform !== 'win32'
    || !caretTrackerProcess
    || !caretTrackerProcess.stdin.writable
  ) {
    return Promise.resolve(null);
  }

  caretLookupRequestId += 1;
  const requestId = String(caretLookupRequestId);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCaretLookups.delete(requestId);
      if (!hasLoggedCaretLookupResult) {
        hasLoggedCaretLookupResult = true;
        writeDiagnostic('caret-lookup-result', {
          found: false,
          reason: 'timeout',
        });
      }
      resolve(null);
    }, CARET_LOOKUP_TIMEOUT_MS);

    pendingCaretLookups.set(requestId, { resolve, timer });
    caretTrackerProcess.stdin.write(`${requestId}\n`, (error) => {
      if (!error) {
        return;
      }

      const pending = pendingCaretLookups.get(requestId);
      if (pending) {
        pendingCaretLookups.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
    });
  });
}

function showMainWindow() {
  if (!app.isReady()) {
    app.once('ready', showMainWindow);
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true });
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ show = true } = {}) {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    show,
    width: 1040,
    height: 720,
    minWidth: 780,
    minHeight: 560,
    icon: path.join(__dirname, '2.ico'),
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(path.join(__dirname, process.platform === 'darwin' ? '2.icns' : '2.ico'));
  tray.setToolTip('VetSnippets - Snippets activos');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Abrir VetSnippets',
      click: showMainWindow,
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
}

function createSuggestionWindow() {
  suggestionWindow = new BrowserWindow({
    width: SUGGESTION_WIDTH,
    height: SUGGESTION_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'tooltip-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  suggestionWindow.setIgnoreMouseEvents(true);
  suggestionWindow.setAlwaysOnTop(true, 'screen-saver');
  suggestionWindow.loadFile('snippet-tooltip.html');
}

function isDevelopmentRun() {
  return !app.isPackaged;
}

function reloadRendererWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }

  if (suggestionWindow && !suggestionWindow.isDestroyed()) {
    suggestionWindow.loadFile('snippet-tooltip.html');
  }
}

function scheduleRendererReload() {
  clearTimeout(devReloadTimer);
  devReloadTimer = setTimeout(() => {
    reloadRendererWindows();
  }, 150);
}

function startDevelopmentReload() {
  if (!isDevelopmentRun()) {
    return;
  }

  [
    'index.html',
    'renderer.js',
    'preload.js',
    'snippet-tooltip.html',
    'snippet-tooltip.js',
    'tooltip-preload.js',
  ].forEach((fileName) => {
    fs.watchFile(
      path.join(__dirname, fileName),
      { interval: 300 },
      (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs) {
          scheduleRendererReload();
        }
      }
    );
  });
}

function enableOpenAtLogin() {
  if (process.env.VETSNIPPETS_DISABLE_STARTUP === '1') {
    return;
  }

  if (!['darwin', 'win32'].includes(process.platform)) {
    return;
  }

  try {
    if (process.platform === 'win32' && !app.isPackaged) {
      const startupCommand = `"${process.execPath}" "${app.getAppPath()}" --background`;
      execFileSync(
        'reg.exe',
        [
          'add',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          '/v',
          'VetSnippets',
          '/t',
          'REG_SZ',
          '/d',
          startupCommand,
          '/f',
        ],
        { windowsHide: true }
      );
      writeDiagnostic('startup-registration-updated', {
        platform: process.platform,
        packaged: false,
        background: true,
      });
      return;
    }

    if (!app.isPackaged) {
      return;
    }

    const loginSettings = process.platform === 'win32'
      ? {
        openAtLogin: true,
        path: process.execPath,
        args: ['--background'],
        enabled: true,
        name: 'VetSnippets',
      }
      : { openAtLogin: true };

    app.setLoginItemSettings(loginSettings);
    writeDiagnostic('startup-registration-updated', {
      platform: process.platform,
      packaged: true,
      background: process.platform === 'win32',
    });
    const currentSettings = app.getLoginItemSettings({
      path: loginSettings.path,
      args: loginSettings.args,
    });

    if (!currentSettings.openAtLogin) {
      console.error('Windows no confirmo el inicio automatico de VetSnippets.');
    }
  } catch (error) {
    console.error('No se pudo activar el inicio automatico:', error);
    writeDiagnostic('startup-registration-error', { error });
  }
}

function trimBuffer() {
  if (keyboardBuffer.length > MAX_BUFFER_LENGTH) {
    keyboardBuffer = keyboardBuffer.slice(-MAX_BUFFER_LENGTH);
  }
}

function appendToBuffer(value) {
  keyboardBuffer += value;
  trimBuffer();
}

function removeLastBufferCharacter() {
  keyboardBuffer = keyboardBuffer.slice(0, -1);
}

function findMatchingSnippet() {
  return findBestMatchingSnippet(
    keyboardBuffer,
    snippets,
    isSnippetCollectionEnabled
  );
}

function isSnippetCollectionEnabled(snippet) {
  if (!snippet.collectionId) {
    return true;
  }

  const collection = collections.find((item) => item.id === snippet.collectionId);
  return !collection || collection.enabled !== false;
}

function createCollectionId(name) {
  const baseId = normalizeForMatch(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || `coleccion-${Date.now()}`;
  let id = baseId;
  let suffix = 2;

  while (collections.some((collection) => collection.id === id)) {
    id = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function normalizeCollection(collection) {
  const name = String(collection.name || '').trim();

  return {
    id: String(collection.id || createCollectionId(name)).trim(),
    name,
    enabled: collection.enabled !== false,
  };
}

function hideSnippetSuggestion() {
  if (suggestionWindow && !suggestionWindow.isDestroyed()) {
    suggestionWindow.hide();
  }
}

async function getSnippetSuggestionAnchor() {
  if (
    rendererCaretPosition
    && mainWindow
    && !mainWindow.isDestroyed()
    && mainWindow.isFocused()
    && Date.now() - rendererCaretPosition.updatedAt < 2000
  ) {
    const contentBounds = mainWindow.getContentBounds();

    return {
      x: Math.round(contentBounds.x + rendererCaretPosition.x),
      y: Math.round(contentBounds.y + rendererCaretPosition.y),
    };
  }

  const systemCaretPosition = await requestTextCaretScreenPoint();

  if (systemCaretPosition) {
    return screen.screenToDipPoint(systemCaretPosition);
  }

  return null;
}

async function showSnippetSuggestion(snippet) {
  if (!settings.showSuggestion || settings.activationMode === 'automatic') {
    hideSnippetSuggestion();
    return;
  }

  if (!suggestionWindow || suggestionWindow.isDestroyed()) {
    return;
  }

  const anchor = await getSnippetSuggestionAnchor();

  if (!anchor || findMatchingSnippet() !== snippet) {
    hideSnippetSuggestion();
    return;
  }

  const display = screen.getDisplayNearestPoint(anchor);
  const workArea = display.workArea;
  const wordCenterX = anchor.x - Math.min(
    snippet.trigger.length * APPROXIMATE_CHARACTER_WIDTH,
    SUGGESTION_WIDTH
  ) / 2;
  const x = Math.min(
    Math.max(Math.round(wordCenterX - SUGGESTION_WIDTH / 2), workArea.x),
    workArea.x + workArea.width - SUGGESTION_WIDTH
  );
  const y = Math.min(
    Math.max(anchor.y - SUGGESTION_HEIGHT - CARET_OFFSET_Y, workArea.y),
    workArea.y + workArea.height - SUGGESTION_HEIGHT
  );

  suggestionWindow.setBounds({
    x,
    y,
    width: SUGGESTION_WIDTH,
    height: SUGGESTION_HEIGHT,
  });

  suggestionWindow.hide();
  suggestionWindow.webContents.send('snippet:detected', {
    trigger: snippet.trigger,
    activationMode: settings.activationMode,
    theme: settings.theme,
  });
}

async function updateSnippetSuggestion() {
  const matchingSnippet = findMatchingSnippet();

  if (!matchingSnippet) {
    hideSnippetSuggestion();
    return null;
  }

  await showSnippetSuggestion(matchingSnippet);
  return matchingSnippet;
}

function clearAutomaticExpansionTimer() {
  clearTimeout(automaticExpansionTimer);
  automaticExpansionTimer = null;
}

function scheduleAutomaticExpansion(snippet) {
  clearAutomaticExpansionTimer();

  if (settings.activationMode !== 'automatic' || !snippet) {
    return;
  }

  automaticExpansionTimer = setTimeout(() => {
    automaticExpansionTimer = null;

    if (!isExpandingSnippet && findMatchingSnippet() === snippet) {
      runSnippetExpansion(snippet);
    }
  }, AUTOMATIC_EXPANSION_DELAY_MS);
}

function scheduleSnippetSuggestionUpdate() {
  clearTimeout(suggestionUpdateTimer);
  suggestionUpdateTimer = setTimeout(() => {
    suggestionUpdateTimer = null;
    void updateSnippetSuggestion();
  }, 75);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildSnippetsCsv() {
  const rows = [['coleccion', 'abreviatura', 'texto html', 'etiqueta']];

  snippets.forEach((snippet) => {
    const label = Object.prototype.hasOwnProperty.call(snippet, 'label')
      ? snippet.label
      : snippet.trigger;

    rows.push([
      getCollectionNameById(snippet.collectionId),
      snippet.trigger,
      snippet.text,
      label,
    ]);
  });

  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

function normalizeHeader(value) {
  return normalizeForMatch(value).replace(/[^a-z0-9]+/g, '');
}

function getColumnIndex(headers, names, fallback) {
  const normalizedNames = names.map(normalizeHeader);
  const index = headers.findIndex((header) => normalizedNames.includes(normalizeHeader(header)));
  return index >= 0 ? index : fallback;
}

function hasKnownCsvHeader(row) {
  const headers = row.map(normalizeHeader);
  return headers.some((header) => [
    'trigger',
    'abreviatura',
    'atajo',
    'texto',
    'text',
    'reemplazo',
    'collection',
    'coleccion',
    'label',
    'etiqueta',
    'nombre',
  ].includes(header));
}

function isMacResourceForkCsv(source) {
  return source.includes('This resource fork intentionally left blank')
    || source.includes('com.apple.metadata:kMDItemWhereFroms');
}

function getCollectionNameById(collectionId) {
  if (!collectionId) {
    return 'Sin coleccion';
  }

  const collection = collections.find((item) => item.id === collectionId);
  return collection ? collection.name : 'Sin coleccion';
}

function getOrCreateCollectionId(value) {
  const name = String(value || '').trim();

  if (!name) {
    return '';
  }

  const existing = collections.find((item) => (
    item.id === name || normalizeForMatch(item.name) === normalizeForMatch(name)
  ));

  if (existing) {
    return existing.id;
  }

  const collection = normalizeCollection({ name });
  collections.push(collection);
  return collection.id;
}

function getCsvCollectionNameFromFilePath(filePath) {
  return path.basename(filePath, path.extname(filePath)).trim();
}

function readSnippetsFromCsv(source, options = {}) {
  if (isMacResourceForkCsv(String(source || ''))) {
    throw new Error('Seleccionaste el archivo auxiliar de macOS (._). Importa el CSV real, por ejemplo Correos.csv.');
  }

  const rows = parseCsv(source);

  if (rows.length === 0) {
    throw new Error('El CSV no contiene snippets.');
  }

  const firstRow = rows[0];
  const hasHeader = hasKnownCsvHeader(firstRow);
  const headers = hasHeader ? firstRow : ['trigger', 'text', 'label'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const triggerIndex = getColumnIndex(headers, ['trigger', 'abreviatura', 'atajo'], 0);
  const textIndex = getColumnIndex(headers, ['text', 'texto', 'texto html', 'textohtml', 'reemplazo', 'texto de reemplazo'], 1);
  const labelIndex = hasHeader
    ? getColumnIndex(headers, ['label', 'etiqueta', 'nombre'], -1)
    : 2;
  const collectionIndex = hasHeader
    ? getColumnIndex(headers, ['collection', 'coleccion', 'collectionId', 'collection id'], -1)
    : -1;
  const importCollectionName = String(options.collectionName || '').trim();
  const parsedSnippets = [];
  let skippedCount = 0;

  dataRows.forEach((row) => {
    const rowCollectionName = collectionIndex >= 0
      ? String(row[collectionIndex] || '').trim()
      : importCollectionName;
    const snippet = normalizeSnippet({
      trigger: row[triggerIndex],
      text: row[textIndex],
      label: labelIndex >= 0 ? row[labelIndex] : row[triggerIndex],
      collectionId: '',
    });

    if (!snippet.trigger || !snippet.text || snippet.trigger.length > MAX_BUFFER_LENGTH) {
      skippedCount += 1;
      return;
    }

    parsedSnippets.push({
      trigger: snippet.trigger,
      text: snippet.text,
      label: snippet.label,
      collectionName: rowCollectionName,
    });
  });

  if (parsedSnippets.length === 0) {
    throw new Error('No se encontro ningun snippet valido en el CSV.');
  }

  return {
    snippets: parsedSnippets,
    skippedCount,
    collectionName: collectionIndex >= 0 ? '' : importCollectionName,
  };
}

function getImportConflicts(importedSnippets) {
  const conflicts = [];
  const seenTriggers = new Set();

  importedSnippets.forEach((snippet) => {
    const normalizedTrigger = normalizeForMatch(snippet.trigger);

    if (
      seenTriggers.has(normalizedTrigger)
      || !snippets.some((item) => normalizeForMatch(item.trigger) === normalizedTrigger)
    ) {
      return;
    }

    seenTriggers.add(normalizedTrigger);
    conflicts.push(snippet.trigger);
  });

  return conflicts;
}

function applyImportedSnippets(importedSnippets, options = {}) {
  const conflictStrategy = options.conflictStrategy || 'overwrite';
  let importedCount = 0;
  let skippedConflictCount = 0;

  importedSnippets.forEach((snippet) => {
    const existingIndex = snippets.findIndex((item) => (
      normalizeForMatch(item.trigger) === normalizeForMatch(snippet.trigger)
    ));

    if (existingIndex >= 0 && conflictStrategy === 'skip') {
      skippedConflictCount += 1;
      return;
    }

    const storedSnippet = {
      trigger: snippet.trigger,
      text: snippet.text,
      label: snippet.label,
      collectionId: getOrCreateCollectionId(snippet.collectionName),
    };

    if (existingIndex >= 0) {
      snippets[existingIndex] = storedSnippet;
    } else {
      snippets.push(storedSnippet);
    }

    importedCount += 1;
  });

  saveCollectionsToDisk();
  saveSnippetsToDisk();
  notifyCollectionChange();
  notifySnippetChange();

  return {
    importedCount,
    skippedConflictCount,
  };
}

function importSnippetsFromCsv(source, options = {}) {
  const parsedImport = readSnippetsFromCsv(source, options);
  const conflicts = getImportConflicts(parsedImport.snippets);

  if (conflicts.length > 0 && !options.conflictStrategy) {
    return {
      needsConflictDecision: true,
      conflicts,
      importedCount: 0,
      skippedCount: parsedImport.skippedCount,
      totalCount: snippets.length,
      collectionName: parsedImport.collectionName,
    };
  }

  const importResult = applyImportedSnippets(parsedImport.snippets, {
    conflictStrategy: options.conflictStrategy,
  });

  return {
    importedCount: importResult.importedCount,
    skippedCount: parsedImport.skippedCount + importResult.skippedConflictCount,
    totalCount: snippets.length,
    collectionName: parsedImport.collectionName,
  };
}

function getSnippetsPath() {
  if (!snippetsPath) {
    snippetsPath = path.join(app.getPath('userData'), 'snippets.json');
  }

  return snippetsPath;
}

function getCollectionsPath() {
  if (!collectionsPath) {
    collectionsPath = path.join(app.getPath('userData'), 'collections.json');
  }

  return collectionsPath;
}

function getSettingsPath() {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
  }

  return settingsPath;
}

function isValidStoredSnippet(value) {
  return (
    value
    && typeof value.trigger === 'string'
    && typeof value.text === 'string'
    && value.trigger.trim().length > 0
  );
}

function isValidStoredCollection(value) {
  return (
    value
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && value.name.trim().length > 0
  );
}

function normalizeStoredSettings(value) {
  const storedValue = value && typeof value === 'object' ? value : {};

  return {
    expansionEnabled: typeof storedValue.expansionEnabled === 'boolean'
      ? storedValue.expansionEnabled
      : DEFAULT_SETTINGS.expansionEnabled,
    showSuggestion: typeof storedValue.showSuggestion === 'boolean'
      ? storedValue.showSuggestion
      : DEFAULT_SETTINGS.showSuggestion,
    activationMode: normalizeActivationMode(
      storedValue.activationMode,
      DEFAULT_SETTINGS.activationMode
    ),
    theme: VALID_THEMES.has(storedValue.theme)
      ? storedValue.theme
      : DEFAULT_SETTINGS.theme,
  };
}

function loadSnippetsFromDisk() {
  const filePath = getSnippetsPath();

  if (!fs.existsSync(filePath)) {
    snippets = [];
    return;
  }

  try {
    const file = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(file);
    snippets = Array.isArray(parsed) ? parsed.filter(isValidStoredSnippet) : [];
  } catch (error) {
    console.error('No se pudieron cargar los snippets guardados:', error);
    snippets = [];
  }
}

function loadCollectionsFromDisk() {
  const filePath = getCollectionsPath();

  if (!fs.existsSync(filePath)) {
    collections = [];
    return;
  }

  try {
    const file = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(file);
    collections = Array.isArray(parsed)
      ? parsed.filter(isValidStoredCollection).map(normalizeCollection)
      : [];
  } catch (error) {
    console.error('No se pudieron cargar las colecciones:', error);
    collections = [];
  }
}

function loadSettingsFromDisk() {
  const filePath = getSettingsPath();

  if (!fs.existsSync(filePath)) {
    settings = { ...DEFAULT_SETTINGS };
    return;
  }

  try {
    const file = fs.readFileSync(filePath, 'utf8');
    settings = normalizeStoredSettings(JSON.parse(file));
  } catch (error) {
    console.error('No se pudieron cargar los ajustes:', error);
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSnippetsToDisk() {
  const filePath = getSnippetsPath();
  const tempPath = `${filePath}.tmp`;
  const payload = JSON.stringify(snippets, null, 2);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function saveCollectionsToDisk() {
  const filePath = getCollectionsPath();
  const tempPath = `${filePath}.tmp`;
  const payload = JSON.stringify(collections, null, 2);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function saveSettingsToDisk() {
  const filePath = getSettingsPath();
  const tempPath = `${filePath}.tmp`;
  const payload = JSON.stringify(settings, null, 2);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function fallbackKeycodeToCharacter(event) {
  const key = event.keycode;
  const shift = Boolean(event.shiftKey);

  const letterMap = new Map([
    [keyCode('A', 30), 'a'],
    [keyCode('B', 48), 'b'],
    [keyCode('C', 46), 'c'],
    [keyCode('D', 32), 'd'],
    [keyCode('E', 18), 'e'],
    [keyCode('F', 33), 'f'],
    [keyCode('G', 34), 'g'],
    [keyCode('H', 35), 'h'],
    [keyCode('I', 23), 'i'],
    [keyCode('J', 36), 'j'],
    [keyCode('K', 37), 'k'],
    [keyCode('L', 38), 'l'],
    [keyCode('M', 50), 'm'],
    [keyCode('N', 49), 'n'],
    [keyCode('O', 24), 'o'],
    [keyCode('P', 25), 'p'],
    [keyCode('Q', 16), 'q'],
    [keyCode('R', 19), 'r'],
    [keyCode('S', 31), 's'],
    [keyCode('T', 20), 't'],
    [keyCode('U', 22), 'u'],
    [keyCode('V', 47), 'v'],
    [keyCode('W', 17), 'w'],
    [keyCode('X', 45), 'x'],
    [keyCode('Y', 21), 'y'],
    [keyCode('Z', 44), 'z'],
  ]);

  if (letterMap.has(key)) {
    const character = letterMap.get(key);
    return shift ? character.toUpperCase() : character;
  }

  const digitMap = new Map([
    [KEY.Digit0, shift ? ')' : '0'],
    [KEY.Digit1, shift ? '!' : '1'],
    [KEY.Digit2, shift ? '@' : '2'],
    [KEY.Digit3, shift ? '#' : '3'],
    [KEY.Digit4, shift ? '$' : '4'],
    [KEY.Digit5, shift ? '%' : '5'],
    [KEY.Digit6, shift ? '^' : '6'],
    [KEY.Digit7, shift ? '&' : '7'],
    [KEY.Digit8, shift ? '*' : '8'],
    [KEY.Digit9, shift ? '(' : '9'],
  ]);

  if (digitMap.has(key)) {
    return digitMap.get(key);
  }

  const punctuationMap = new Map([
    [KEY.Space, ' '],
    [KEY.Slash, shift ? '?' : '/'],
    [KEY.Backslash, shift ? '|' : '\\'],
    [KEY.Comma, shift ? '<' : ','],
    [KEY.Period, shift ? '>' : '.'],
    [KEY.Semicolon, shift ? ':' : ';'],
    [KEY.Quote, shift ? '"' : "'"],
    [KEY.BracketLeft, shift ? '{' : '['],
    [KEY.BracketRight, shift ? '}' : ']'],
    [KEY.Minus, shift ? '_' : '-'],
    [KEY.Equal, shift ? '+' : '='],
    [KEY.Backquote, shift ? '~' : '`'],
  ]);

  return punctuationMap.get(key) || '';
}

async function selectPreviousCharacters(times) {
  await keyboard.pressKey(Key.LeftShift);

  try {
    await delay(BACKSPACE_STEP_DELAY_MS);

    for (let index = 0; index < times; index += 1) {
      await keyboard.pressKey(Key.Left);
      await keyboard.releaseKey(Key.Left);
      await delay(BACKSPACE_STEP_DELAY_MS);
    }
  } finally {
    await keyboard.releaseKey(Key.LeftShift);
  }
}

function captureClipboard() {
  const formats = clipboard.availableFormats();

  if (formats.length === 0) {
    return null;
  }

  const data = {};
  const text = clipboard.readText();
  const html = clipboard.readHTML();
  const rtf = clipboard.readRTF();
  const image = clipboard.readImage();
  const bookmark = ['darwin', 'win32'].includes(process.platform)
    ? clipboard.readBookmark()
    : null;

  if (text || formats.some((format) => /text|unicode/i.test(format))) {
    data.text = text;
  }
  if (html) {
    data.html = html;
  }
  if (rtf) {
    data.rtf = rtf;
  }
  if (!image.isEmpty()) {
    data.image = image;
  }
  if (bookmark?.url) {
    data.text = bookmark.url;
    data.bookmark = bookmark.title;
  }

  return Object.keys(data).length > 0 ? data : null;
}

function restoreClipboard(snapshot, injectedText) {
  if (clipboard.readText() !== injectedText) {
    return;
  }

  if (snapshot) {
    clipboard.write(snapshot);
  } else {
    clipboard.clear();
  }
}

async function pasteClipboardText(text) {
  const previousClipboard = captureClipboard();
  clipboard.writeText(text);

  try {
    if (process.platform === 'darwin') {
      await keyboard.pressKey(Key.LeftCmd, Key.V);
      await keyboard.releaseKey(Key.LeftCmd, Key.V);
    } else {
      await keyboard.pressKey(Key.LeftControl, Key.V);
      await keyboard.releaseKey(Key.LeftControl, Key.V);
    }
  } finally {
    await delay(100);
    restoreClipboard(previousClipboard, text);
  }
}

async function expandSnippet(snippet) {
  isExpandingSnippet = true;
  clearAutomaticExpansionTimer();
  hideSnippetSuggestion();

  try {
    // La expansion comienza despues de liberar la tecla de activacion.
    await delay(BACKSPACE_STEP_DELAY_MS);
    await selectPreviousCharacters(snippet.trigger.length);
    await delay(BACKSPACE_STEP_DELAY_MS);

    // Pegar sobre la seleccion reemplaza toda la abreviatura de una sola vez.
    await pasteClipboardText(snippet.text);

    keyboardBuffer = '';
    writeDiagnostic('expansion-succeeded', {
      triggerLength: snippet.trigger.length,
      activationMode: settings.activationMode,
    });
  } finally {
    setTimeout(() => {
      isExpandingSnippet = false;
    }, 20);
  }
}

function runSnippetExpansion(snippet) {
  void expandSnippet(snippet).catch((error) => {
    console.error(`No se pudo expandir el snippet "${snippet.trigger}":`, error);
    resetKeyboardContext();
    writeDiagnostic('expansion-failed', {
      error,
      triggerLength: snippet.trigger.length,
      activationMode: settings.activationMode,
      platform: process.platform,
    });
    const message = `No se pudo expandir "${snippet.trigger}". Revisa los permisos de la aplicación de destino.`;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('snippets:listener-error', message);
    } else if (process.platform === 'win32' && tray) {
      tray.displayBalloon({
        title: 'VetSnippets',
        content: message,
      });
    }
  });
}

function isShiftKey(keycode) {
  return keycode === KEY.ShiftLeft || keycode === KEY.ShiftRight;
}

function resetKeyboardContext() {
  keyboardBuffer = '';
  clearAutomaticExpansionTimer();
  clearTimeout(suggestionUpdateTimer);
  hideSnippetSuggestion();
}

async function handleKeydown(event) {
  if (isExpandingSnippet) {
    return;
  }

  if (!settings.expansionEnabled) {
    clearAutomaticExpansionTimer();
    hideSnippetSuggestion();
    keyboardBuffer = '';
    return;
  }

  if (isShiftKey(event.keycode)) {
    if (activeShiftKeys.size === 0) {
      shiftChordUsed = false;
    }

    activeShiftKeys.add(event.keycode);
    clearAutomaticExpansionTimer();
    return;
  }

  lastCleanShiftReleaseAt = 0;

  if (activeShiftKeys.size > 0) {
    shiftChordUsed = true;
  }

  const isAltGraph = (
    process.platform === 'win32'
    && event.ctrlKey
    && event.altKey
  );

  if (event.metaKey || (!isAltGraph && (event.ctrlKey || event.altKey))) {
    resetKeyboardContext();
    return;
  }

  if (CONTEXT_RESET_KEYS.has(event.keycode)) {
    resetKeyboardContext();
    return;
  }

  if (event.keycode === KEY.Backspace) {
    clearAutomaticExpansionTimer();
    removeLastBufferCharacter();
    scheduleSnippetSuggestionUpdate();
    scheduleAutomaticExpansion(findMatchingSnippet());
    return;
  }

  if (event.keycode === KEY.Enter || event.keycode === KEY.Escape) {
    clearAutomaticExpansionTimer();
    keyboardBuffer = '';
    hideSnippetSuggestion();
    return;
  }

  const character = await translateKeyEvent(event);

  if (character) {
    clearAutomaticExpansionTimer();
    appendToBuffer(character);
    scheduleSnippetSuggestionUpdate();
    scheduleAutomaticExpansion(findMatchingSnippet());
  }
}

function handleKeyup(event) {
  if (!isShiftKey(event.keycode) || !activeShiftKeys.has(event.keycode)) {
    return;
  }

  activeShiftKeys.delete(event.keycode);

  if (activeShiftKeys.size > 0) {
    return;
  }

  const activation = resolveShiftActivation({
    mode: settings.activationMode,
    chordUsed: shiftChordUsed,
    lastReleaseAt: lastCleanShiftReleaseAt,
    now: Date.now(),
    doubleShiftWindowMs: DOUBLE_SHIFT_WINDOW_MS,
  });

  lastCleanShiftReleaseAt = activation.nextReleaseAt;
  shiftChordUsed = false;

  if (activation.activate && !isExpandingSnippet && settings.expansionEnabled) {
    const matchingSnippet = findMatchingSnippet();

    if (matchingSnippet) {
      runSnippetExpansion(matchingSnippet);
    } else {
      hideSnippetSuggestion();
    }
  }
}

function handleMouseClick() {
  if (activeShiftKeys.size > 0) {
    shiftChordUsed = true;
  }

  lastCleanShiftReleaseAt = 0;
  resetKeyboardContext();
}

function handleMouseWheel() {
  if (activeShiftKeys.size > 0) {
    shiftChordUsed = true;
  }

  lastCleanShiftReleaseAt = 0;
  resetKeyboardContext();
}

function startGlobalKeyboardListener() {
  if (listenerStarted) {
    return;
  }

  try {
    uIOhook.on('keydown', (event) => enqueueInputEvent(handleKeydown, event));
    uIOhook.on('keyup', (event) => enqueueInputEvent(handleKeyup, event));
    uIOhook.on('click', (event) => enqueueInputEvent(handleMouseClick, event));
    uIOhook.on('wheel', (event) => enqueueInputEvent(handleMouseWheel, event));
    uIOhook.start();
    listenerStarted = true;
    writeDiagnostic('global-listener-started', {
      platform: process.platform,
    });
  } catch (error) {
    console.error('No se pudo iniciar el listener global de teclado:', error);
    writeDiagnostic('global-listener-error', { error });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        'snippets:listener-error',
        'No se pudieron activar los snippets. Reabre la app o revisa los permisos.'
      );
    }
  }
}

function notifySnippetChange() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snippets:changed', snippets);
  }
}

function notifyCollectionChange() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('collections:changed', collections);
  }
}

function normalizeSnippet(snippet) {
  return {
    trigger: String(snippet.trigger || '').trim(),
    text: String(snippet.text || ''),
    label: String(snippet.label || ''),
    collectionId: String(snippet.collectionId || '').trim(),
    originalTrigger: String(snippet.originalTrigger || '').trim(),
  };
}

ipcMain.handle('snippets:list', () => snippets);

ipcMain.handle('collections:list', () => collections);

ipcMain.handle('collections:create', (_event, payload) => {
  const collection = normalizeCollection(payload);

  if (!collection.name) {
    throw new Error('El nombre de la coleccion es obligatorio.');
  }

  const existingIndex = collections.findIndex((item) => (
    normalizeForMatch(item.name) === normalizeForMatch(collection.name)
  ));

  if (existingIndex >= 0) {
    collections[existingIndex] = {
      ...collections[existingIndex],
      name: collection.name,
    };
  } else {
    collections.push(collection);
  }

  saveCollectionsToDisk();
  notifyCollectionChange();
  return collections;
});

ipcMain.handle('collections:update', (_event, payload) => {
  const collection = normalizeCollection(payload);
  const index = collections.findIndex((item) => item.id === collection.id);

  if (!collection.name) {
    throw new Error('El nombre de la coleccion es obligatorio.');
  }

  const duplicateIndex = collections.findIndex((item) => (
    item.id !== collection.id
    && normalizeForMatch(item.name) === normalizeForMatch(collection.name)
  ));

  if (duplicateIndex >= 0) {
    throw new Error('Ya existe una coleccion con ese nombre.');
  }

  if (index >= 0) {
    collections[index] = collection;
    saveCollectionsToDisk();
    notifyCollectionChange();
  }

  return collections;
});

ipcMain.handle('collections:delete', (_event, payload) => {
  const collectionId = String(payload.collectionId || '').trim();
  const index = collections.findIndex((item) => item.id === collectionId);

  if (index < 0) {
    return {
      collections,
      snippets,
      affectedCount: 0,
      deleted: false,
    };
  }

  let affectedCount = 0;

  snippets = snippets.map((snippet) => {
    if (snippet.collectionId !== collectionId) {
      return snippet;
    }

    affectedCount += 1;
    return {
      ...snippet,
      collectionId: '',
    };
  });

  collections.splice(index, 1);
  saveCollectionsToDisk();
  saveSnippetsToDisk();
  notifyCollectionChange();
  notifySnippetChange();

  return {
    collections,
    snippets,
    affectedCount,
    deleted: true,
  };
});

ipcMain.handle('settings:get', () => settings);

ipcMain.on('snippet:rendered', (event) => {
  if (
    suggestionWindow
    && !suggestionWindow.isDestroyed()
    && event.sender === suggestionWindow.webContents
  ) {
    suggestionWindow.showInactive();
  }
});

ipcMain.on('caret:update', (event, position) => {
  if (
    !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !Number.isFinite(position?.x)
    || !Number.isFinite(position?.y)
  ) {
    return;
  }

  rendererCaretPosition = {
    x: position.x,
    y: position.y,
    updatedAt: Date.now(),
  };
});

ipcMain.handle('settings:update', (_event, payload) => {
  settings = normalizeStoredSettings({
    ...settings,
    ...payload,
  });

  if (!settings.showSuggestion) {
    hideSnippetSuggestion();
  }

  clearAutomaticExpansionTimer();
  keyboardBuffer = '';
  activeShiftKeys.clear();
  shiftChordUsed = false;
  lastCleanShiftReleaseAt = 0;

  saveSettingsToDisk();
  writeDiagnostic('settings-updated', {
    activationMode: settings.activationMode,
    expansionEnabled: settings.expansionEnabled,
    showSuggestion: settings.showSuggestion,
    theme: settings.theme,
  });
  return settings;
});

ipcMain.handle('diagnostics:export', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar diagnostico',
    defaultPath: 'VetSnippets-diagnostico.log',
    filters: [
      { name: 'Registro', extensions: ['log', 'txt'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const filePath = getDiagnosticsPath();
  const backupPath = `${filePath}.1`;
  const parts = [backupPath, filePath]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.readFileSync(candidate, 'utf8'));

  fs.writeFileSync(result.filePath, parts.join(''), 'utf8');
  writeDiagnostic('diagnostics-exported');

  return {
    canceled: false,
    filePath: result.filePath,
  };
});

ipcMain.handle('snippets:export-csv', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar snippets',
    defaultPath: 'Snippets.csv',
    filters: [
      { name: 'CSV', extensions: ['csv'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  fs.writeFileSync(result.filePath, buildSnippetsCsv(), 'utf8');

  return {
    canceled: false,
    filePath: result.filePath,
    exportedCount: snippets.length,
  };
});

ipcMain.handle('snippets:import-csv', async (_event, payload = {}) => {
  if (pendingCsvImport && payload.conflictStrategy) {
    if (payload.conflictStrategy === 'cancel') {
      pendingCsvImport = null;
      return { canceled: true };
    }

    const importResult = importSnippetsFromCsv(
      pendingCsvImport.source,
      {
        collectionName: pendingCsvImport.collectionName,
        conflictStrategy: payload.conflictStrategy,
      }
    );
    const filePath = pendingCsvImport.filePath;
    pendingCsvImport = null;

    return {
      canceled: false,
      filePath,
      ...importResult,
    };
  }

  pendingCsvImport = null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar snippets',
    properties: ['openFile'],
    filters: [
      { name: 'CSV', extensions: ['csv'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const filePath = result.filePaths[0];
  const collectionName = getCsvCollectionNameFromFilePath(filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const importResult = importSnippetsFromCsv(
    source,
    { collectionName }
  );

  if (importResult.needsConflictDecision) {
    pendingCsvImport = {
      source,
      filePath,
      collectionName,
    };
  }

  return {
    canceled: false,
    filePath,
    ...importResult,
  };
});

ipcMain.handle('snippets:create', (_event, payload) => {
  const snippet = normalizeSnippet(payload);
  const payloadHasLabel = Object.prototype.hasOwnProperty.call(payload || {}, 'label');

  if (!snippet.trigger || !snippet.text) {
    throw new Error('El trigger y el texto son obligatorios.');
  }

  if (snippet.trigger.length > MAX_BUFFER_LENGTH) {
    throw new Error(`El trigger no puede superar ${MAX_BUFFER_LENGTH} caracteres.`);
  }

  const originalIndex = snippet.originalTrigger
    ? snippets.findIndex((item) => item.trigger === snippet.originalTrigger)
    : -1;
  const originalSnippet = originalIndex >= 0 ? snippets[originalIndex] : null;
  const existingIndex = snippets.findIndex((item) => (
    normalizeForMatch(item.trigger) === normalizeForMatch(snippet.trigger)
  ));
  const storedSnippet = {
    trigger: snippet.trigger,
    text: snippet.text,
    label: payloadHasLabel
      ? snippet.label
      : originalSnippet && Object.prototype.hasOwnProperty.call(originalSnippet, 'label')
        ? originalSnippet.label
        : snippet.trigger,
    collectionId: snippet.collectionId,
  };

  if (originalIndex >= 0) {
    snippets[originalIndex] = storedSnippet;

    if (existingIndex >= 0 && existingIndex !== originalIndex) {
      snippets.splice(existingIndex, 1);
    }
  } else if (existingIndex >= 0) {
    snippets[existingIndex] = storedSnippet;
  } else {
    snippets.push(storedSnippet);
  }

  saveSnippetsToDisk();
  notifySnippetChange();
  return snippets;
});

ipcMain.handle('snippets:delete', (_event, trigger) => {
  const index = snippets.findIndex((snippet) => snippet.trigger === trigger);

  if (index >= 0) {
    snippets.splice(index, 1);
    saveSnippetsToDisk();
  }

  notifySnippetChange();
  return snippets;
});

ipcMain.handle('snippets:delete-all', (_event, confirmationText) => {
  if (confirmationText !== 'Eliminar') {
    throw new Error('Debes escribir Eliminar para confirmar el borrado.');
  }

  const deletedCount = snippets.length;
  const deletedCollectionCount = collections.length;
  snippets = [];
  collections = [];
  keyboardBuffer = '';
  pendingCsvImport = null;
  hideSnippetSuggestion();
  saveSnippetsToDisk();
  saveCollectionsToDisk();
  notifySnippetChange();
  notifyCollectionChange();

  return {
    deletedCount,
    deletedCollectionCount,
    snippets,
    collections,
  };
});

const hasSingleInstanceLock = (
  process.env.VETSNIPPETS_ALLOW_MULTIPLE === '1'
  || app.requestSingleInstanceLock()
);

if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', (_event, commandLine) => {
  if (!commandLine.includes('--background')) {
    showMainWindow();
  }
});

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) {
    return;
  }

  const startInBackground = process.argv.includes('--background');

  writeDiagnostic('app-ready', {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    background: startInBackground,
  });
  enableOpenAtLogin();
  loadSettingsFromDisk();
  loadCollectionsFromDisk();
  loadSnippetsFromDisk();
  if (!startInBackground) {
    createWindow();
  }
  createSuggestionWindow();
  createTray();
  startKeyboardTranslator();
  startCaretTracker();
  startGlobalKeyboardListener();
  startDevelopmentReload();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  [
    'index.html',
    'renderer.js',
    'preload.js',
    'snippet-tooltip.html',
    'snippet-tooltip.js',
    'tooltip-preload.js',
  ].forEach((fileName) => {
    fs.unwatchFile(path.join(__dirname, fileName));
  });
  clearTimeout(devReloadTimer);
  stopKeyboardTranslator();
  stopCaretTracker();

  if (listenerStarted) {
    uIOhook.stop();
  }
});

app.on('window-all-closed', () => {
  // VetSnippets permanece activo en la bandeja hasta elegir "Salir".
});
