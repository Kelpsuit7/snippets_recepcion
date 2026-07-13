const electron = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  screen,
} = electron;
const ipcMain = electron.ipcMain || app.ipcMain;

const MAX_BUFFER_LENGTH = 20;
const SUGGESTION_WIDTH = 116;
const SUGGESTION_HEIGHT = 34;
const CARET_OFFSET_Y = 12;
const DEFAULT_SETTINGS = {
  expansionEnabled: true,
  showSuggestion: true,
  theme: 'mint',
};
const VALID_THEMES = new Set(['mint', 'rose', 'sky', 'lavender', 'peach']);

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
}
"@

$info = New-Object CaretNative+GUITHREADINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]'CaretNative+GUITHREADINFO')

if ([CaretNative]::GetGUIThreadInfo(0, [ref]$info) -and $info.hwndCaret -ne [IntPtr]::Zero) {
  $point = New-Object CaretNative+POINT
  $point.X = $info.rcCaret.Left
  $point.Y = $info.rcCaret.Top
  [void][CaretNative]::ClientToScreen($info.hwndCaret, [ref]$point)
  "$($point.X),$($point.Y)"
}
`;

keyboard.config.autoDelayMs = 0;

let mainWindow = null;
let suggestionWindow = null;
let snippets = [];
let collections = [];
let settings = { ...DEFAULT_SETTINGS };
let keyboardBuffer = '';
let isExpandingSnippet = false;
let isForwardingTab = false;
let listenerStarted = false;
let tabShortcutRegistered = false;
let devReloadTimer = null;
let snippetsPath = '';
let collectionsPath = '';
let settingsPath = '';
let pendingCsvImport = null;

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
  Tab: keyCode('Tab', 15),
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
};

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
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
    },
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');
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
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform)) {
    return;
  }

  try {
    const loginSettings = {
      openAtLogin: true,
    };

    if (process.platform === 'win32') {
      loginSettings.path = process.execPath;
    }

    app.setLoginItemSettings(loginSettings);
  } catch (error) {
    console.error('No se pudo activar el inicio automatico:', error);
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

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function findMatchingSnippet() {
  const normalizedBuffer = normalizeForMatch(keyboardBuffer);

  return snippets.find((snippet) => (
    isSnippetCollectionEnabled(snippet)
    && normalizedBuffer.endsWith(normalizeForMatch(snippet.trigger))
  ));
}

function isSnippetCollectionEnabled(snippet) {
  if (!snippet.collectionId) {
    return true;
  }

  const collection = collections.find((item) => item.id === snippet.collectionId);
  return !collection || collection.enabled !== false;
}

function createCollectionId(name) {
  return normalizeForMatch(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || `coleccion-${Date.now()}`;
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

function getTextCaretScreenPoint() {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_CARET_POSITION_SCRIPT,
      ],
      {
        encoding: 'utf8',
        timeout: 500,
        windowsHide: true,
      }
    ).trim();

    const [x, y] = output.split(',').map((value) => Number.parseInt(value, 10));

    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  } catch (error) {
    return null;
  }

  return null;
}

function getSnippetSuggestionAnchor() {
  return getTextCaretScreenPoint() || screen.getCursorScreenPoint();
}

function showSnippetSuggestion(snippet) {
  if (!settings.showSuggestion) {
    hideSnippetSuggestion();
    return;
  }

  if (!suggestionWindow || suggestionWindow.isDestroyed()) {
    return;
  }

  const anchor = getSnippetSuggestionAnchor();
  const display = screen.getDisplayNearestPoint(anchor);
  const workArea = display.workArea;
  const x = Math.min(
    Math.max(anchor.x - Math.round(SUGGESTION_WIDTH / 2), workArea.x),
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

  suggestionWindow.webContents.send('snippet:detected', {
    trigger: snippet.trigger,
  });
  suggestionWindow.showInactive();
}

function updateSnippetSuggestion() {
  const matchingSnippet = findMatchingSnippet();

  if (!matchingSnippet) {
    hideSnippetSuggestion();
    return;
  }

  showSnippetSuggestion(matchingSnippet);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function detectCsvDelimiter(line) {
  let commaCount = 0;
  let semicolonCount = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && nextCharacter === '"') {
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && character === ',') {
      commaCount += 1;
    }

    if (!inQuotes && character === ';') {
      semicolonCount += 1;
    }
  }

  return semicolonCount > commaCount ? ';' : ',';
}

function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const delimiter = detectCsvDelimiter(source.split(/\r?\n/, 1)[0] || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && character === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && (character === '\n' || character === '\r')) {
      if (character === '\r' && nextCharacter === '\n') {
        index += 1;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += character;
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((item) => item.some((cell) => String(cell || '').trim()));
}

function csvEscape(value) {
  const text = String(value || '');
  return `"${text.replace(/"/g, '""')}"`;
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

function keycodeToCharacter(event) {
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

async function pressBackspace(times) {
  for (let index = 0; index < times; index += 1) {
    await keyboard.pressKey(Key.Backspace);
    await keyboard.releaseKey(Key.Backspace);
  }
}

async function pasteClipboardText(text) {
  clipboard.writeText(text);

  if (process.platform === 'darwin') {
    await keyboard.pressKey(Key.LeftCmd, Key.V);
    await keyboard.releaseKey(Key.LeftCmd, Key.V);
    return;
  }

  await keyboard.pressKey(Key.LeftControl, Key.V);
  await keyboard.releaseKey(Key.LeftControl, Key.V);
}

async function expandSnippet(snippet) {
  isExpandingSnippet = true;
  hideSnippetSuggestion();

  try {
    // El atajo global de TAB evita que el foco avance antes de llegar aqui.
    await delay(4);
    await pressBackspace(snippet.trigger.length);

    // El portapapeles conserva acentos, saltos de linea y textos largos.
    await pasteClipboardText(snippet.text);

    keyboardBuffer = '';
  } finally {
    setTimeout(() => {
      isExpandingSnippet = false;
    }, 20);
  }
}

function handleTabKey() {
  const matchingSnippet = findMatchingSnippet();

  if (!matchingSnippet) {
    hideSnippetSuggestion();
    return;
  }

  void expandSnippet(matchingSnippet);
}

async function forwardTabKey() {
  isForwardingTab = true;

  try {
    if (tabShortcutRegistered) {
      globalShortcut.unregister('Tab');
      tabShortcutRegistered = false;
    }

    await keyboard.pressKey(Key.Tab);
    await keyboard.releaseKey(Key.Tab);
  } finally {
    setTimeout(() => {
      isForwardingTab = false;
      updateTabShortcutRegistration();
    }, 20);
  }
}

function handleTabShortcut() {
  if (isExpandingSnippet || isForwardingTab || !settings.expansionEnabled) {
    void forwardTabKey();
    return;
  }

  const matchingSnippet = findMatchingSnippet();

  if (!matchingSnippet) {
    hideSnippetSuggestion();
    void forwardTabKey();
    return;
  }

  void expandSnippet(matchingSnippet);
}

function updateTabShortcutRegistration() {
  if (!settings.expansionEnabled || isForwardingTab) {
    if (tabShortcutRegistered) {
      globalShortcut.unregister('Tab');
      tabShortcutRegistered = false;
    }

    return;
  }

  if (tabShortcutRegistered) {
    return;
  }

  tabShortcutRegistered = globalShortcut.register('Tab', handleTabShortcut);

  if (!tabShortcutRegistered) {
    console.error('No se pudo registrar TAB como atajo global.');
  }
}

function handleKeydown(event) {
  if (isExpandingSnippet) {
    return;
  }

  if (!settings.expansionEnabled) {
    hideSnippetSuggestion();
    keyboardBuffer = '';
    return;
  }

  if (event.keycode === KEY.Tab) {
    if (tabShortcutRegistered || isForwardingTab) {
      return;
    }

    handleTabKey();
    return;
  }

  if (event.keycode === KEY.Backspace) {
    removeLastBufferCharacter();
    updateSnippetSuggestion();
    return;
  }

  if (event.keycode === KEY.Enter || event.keycode === KEY.Escape) {
    keyboardBuffer = '';
    hideSnippetSuggestion();
    return;
  }

  const character = keycodeToCharacter(event);

  if (character) {
    appendToBuffer(character);
    updateSnippetSuggestion();
  }
}

function startGlobalKeyboardListener() {
  if (listenerStarted) {
    return;
  }

  try {
    uIOhook.on('keydown', handleKeydown);
    uIOhook.start();
    listenerStarted = true;
  } catch (error) {
    console.error('No se pudo iniciar el listener global de teclado:', error);

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

ipcMain.handle('settings:update', (_event, payload) => {
  settings = normalizeStoredSettings({
    ...settings,
    ...payload,
  });

  if (!settings.showSuggestion) {
    hideSnippetSuggestion();
  }

  saveSettingsToDisk();
  updateTabShortcutRegistration();
  return settings;
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

app.whenReady().then(() => {
  enableOpenAtLogin();
  loadSettingsFromDisk();
  loadCollectionsFromDisk();
  loadSnippetsFromDisk();
  createWindow();
  createSuggestionWindow();
  startGlobalKeyboardListener();
  updateTabShortcutRegistration();
  startDevelopmentReload();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  [
    'index.html',
    'renderer.js',
    'preload.js',
    'snippet-tooltip.html',
    'tooltip-preload.js',
  ].forEach((fileName) => {
    fs.unwatchFile(path.join(__dirname, fileName));
  });
  clearTimeout(devReloadTimer);
  globalShortcut.unregisterAll();

  if (listenerStarted) {
    uIOhook.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
