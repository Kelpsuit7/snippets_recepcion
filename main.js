const electron = require('electron');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { keyboard, Key } = require('@nut-tree-fork/nut-js');
const fs = require('fs');
const path = require('path');

const { app, BrowserWindow, clipboard, screen } = electron;
const ipcMain = electron.ipcMain || app.ipcMain;

const MAX_BUFFER_LENGTH = 20;
const SUGGESTION_WIDTH = 116;
const SUGGESTION_HEIGHT = 34;
const DEFAULT_SETTINGS = {
  expansionEnabled: true,
  showSuggestion: true,
  restoreFocusAfterTab: true,
};

keyboard.config.autoDelayMs = 0;

let mainWindow = null;
let suggestionWindow = null;
let snippets = [];
let collections = [];
let settings = { ...DEFAULT_SETTINGS };
let keyboardBuffer = '';
let isExpandingSnippet = false;
let listenerStarted = false;
let snippetsPath = '';
let collectionsPath = '';
let settingsPath = '';

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

function showSnippetSuggestion(snippet) {
  if (!settings.showSuggestion) {
    hideSnippetSuggestion();
    return;
  }

  if (!suggestionWindow || suggestionWindow.isDestroyed()) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  const x = Math.min(
    Math.max(cursor.x + 18, workArea.x),
    workArea.x + workArea.width - SUGGESTION_WIDTH
  );
  const y = Math.min(
    Math.max(cursor.y - SUGGESTION_HEIGHT - 46, workArea.y),
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
  return {
    expansionEnabled: typeof value.expansionEnabled === 'boolean'
      ? value.expansionEnabled
      : DEFAULT_SETTINGS.expansionEnabled,
    showSuggestion: typeof value.showSuggestion === 'boolean'
      ? value.showSuggestion
      : DEFAULT_SETTINGS.showSuggestion,
    restoreFocusAfterTab: typeof value.restoreFocusAfterTab === 'boolean'
      ? value.restoreFocusAfterTab
      : DEFAULT_SETTINGS.restoreFocusAfterTab,
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

async function pressShiftTab() {
  await keyboard.pressKey(Key.LeftShift, Key.Tab);
  await keyboard.releaseKey(Key.LeftShift, Key.Tab);
  await delay(4);
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
    // uiohook-napi escucha eventos globales, pero no cancela TAB. En campos
    // donde TAB mueve el foco, Shift+TAB vuelve al campo anterior antes de borrar.
    await delay(6);

    if (settings.restoreFocusAfterTab) {
      await pressShiftTab();
    }

    // Despues se borra solo el trigger escrito.
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
    // Sin coincidencia no se simula nada: TAB queda como comportamiento normal.
    hideSnippetSuggestion();
    return;
  }

  void expandSnippet(matchingSnippet);
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
        'No se pudo iniciar el listener global. En macOS revisa Accesibilidad y Monitoreo de entrada; en Windows revisa permisos de la app.'
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
    collectionId: String(snippet.collectionId || '').trim(),
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

  if (index >= 0) {
    collections[index] = collection;
    saveCollectionsToDisk();
    notifyCollectionChange();
  }

  return collections;
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
  return settings;
});

ipcMain.handle('snippets:create', (_event, payload) => {
  const snippet = normalizeSnippet(payload);

  if (!snippet.trigger || !snippet.text) {
    throw new Error('El trigger y el texto son obligatorios.');
  }

  if (snippet.trigger.length > MAX_BUFFER_LENGTH) {
    throw new Error(`El trigger no puede superar ${MAX_BUFFER_LENGTH} caracteres.`);
  }

  const existingIndex = snippets.findIndex((item) => (
    normalizeForMatch(item.trigger) === normalizeForMatch(snippet.trigger)
  ));

  if (existingIndex >= 0) {
    snippets[existingIndex] = snippet;
  } else {
    snippets.push(snippet);
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

app.whenReady().then(() => {
  loadSettingsFromDisk();
  loadCollectionsFromDisk();
  loadSnippetsFromDisk();
  createWindow();
  createSuggestionWindow();
  startGlobalKeyboardListener();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  if (listenerStarted) {
    uIOhook.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
