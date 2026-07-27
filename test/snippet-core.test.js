const test = require('node:test');
const assert = require('node:assert/strict');
const {
  csvEscape,
  detectCsvDelimiter,
  findBestMatchingSnippet,
  normalizeActivationMode,
  normalizeForMatch,
  parseCsv,
  resolveShiftActivation,
} = require('../lib/snippet-core');

test('normaliza acentos y mayusculas para coincidencias', () => {
  assert.equal(normalizeForMatch('ÁRBOL Ñ'), 'arbol n');
});

test('conserva modos actuales y aplica el valor predeterminado a valores invalidos', () => {
  assert.equal(normalizeActivationMode('double-shift'), 'double-shift');
  assert.equal(normalizeActivationMode('automatic'), 'automatic');
  assert.equal(normalizeActivationMode('desconocido'), 'shift');
});

test('Shift simple activa con una pulsacion limpia', () => {
  assert.deepEqual(resolveShiftActivation({
    mode: 'shift',
    chordUsed: false,
    lastReleaseAt: 0,
    now: 1000,
    doubleShiftWindowMs: 450,
  }), {
    activate: true,
    nextReleaseAt: 0,
  });
});

test('doble Shift requiere dos pulsaciones dentro de la ventana', () => {
  const first = resolveShiftActivation({
    mode: 'double-shift',
    chordUsed: false,
    lastReleaseAt: 0,
    now: 1000,
    doubleShiftWindowMs: 450,
  });
  const second = resolveShiftActivation({
    mode: 'double-shift',
    chordUsed: false,
    lastReleaseAt: first.nextReleaseAt,
    now: 1300,
    doubleShiftWindowMs: 450,
  });

  assert.deepEqual(first, { activate: false, nextReleaseAt: 1000 });
  assert.deepEqual(second, { activate: true, nextReleaseAt: 0 });
});

test('doble Shift reinicia si se excede la ventana o se usa un acorde', () => {
  assert.deepEqual(resolveShiftActivation({
    mode: 'double-shift',
    chordUsed: false,
    lastReleaseAt: 1000,
    now: 1600,
    doubleShiftWindowMs: 450,
  }), {
    activate: false,
    nextReleaseAt: 1600,
  });
  assert.deepEqual(resolveShiftActivation({
    mode: 'double-shift',
    chordUsed: true,
    lastReleaseAt: 1000,
    now: 1200,
    doubleShiftWindowMs: 450,
  }), {
    activate: false,
    nextReleaseAt: 0,
  });
});

test('elige la coincidencia habilitada mas larga', () => {
  const snippets = [
    { trigger: 'fac', enabled: true },
    { trigger: 'prefac', enabled: true },
    { trigger: 'deshabilitado', enabled: false },
  ];

  assert.equal(
    findBestMatchingSnippet('texto PREFAC', snippets, (snippet) => snippet.enabled),
    snippets[1]
  );
});

test('detecta delimitadores CSV fuera de campos citados', () => {
  assert.equal(detectCsvDelimiter('"a,b";"c"'), ';');
  assert.equal(detectCsvDelimiter('"a;b","c"'), ',');
});

test('parsea CSV con BOM, saltos de linea y comillas escapadas', () => {
  assert.deepEqual(
    parseCsv('\uFEFF"trigger","texto"\r\n"fac","Linea 1\nLinea ""2"""'),
    [
      ['trigger', 'texto'],
      ['fac', 'Linea 1\nLinea "2"'],
    ]
  );
});

test('escapa valores CSV', () => {
  assert.equal(csvEscape('Texto "citado"'), '"Texto ""citado"""');
});
