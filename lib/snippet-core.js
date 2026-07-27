const VALID_ACTIVATION_MODES = new Set(['shift', 'double-shift', 'automatic']);

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();
}

function normalizeActivationMode(value, fallback = 'shift') {
  return VALID_ACTIVATION_MODES.has(value) ? value : fallback;
}

function findBestMatchingSnippet(buffer, snippets, isEnabled = () => true) {
  const normalizedBuffer = normalizeForMatch(buffer);

  return snippets
    .filter((snippet) => (
      isEnabled(snippet)
      && normalizedBuffer.endsWith(normalizeForMatch(snippet.trigger))
    ))
    .sort((left, right) => right.trigger.length - left.trigger.length)[0] || null;
}

function resolveShiftActivation({
  mode,
  chordUsed,
  lastReleaseAt,
  now,
  doubleShiftWindowMs,
}) {
  if (chordUsed || !['shift', 'double-shift'].includes(mode)) {
    return { activate: false, nextReleaseAt: 0 };
  }

  if (mode === 'shift') {
    return { activate: true, nextReleaseAt: 0 };
  }

  const isSecondRelease = (
    lastReleaseAt > 0
    && now - lastReleaseAt <= doubleShiftWindowMs
  );

  return {
    activate: isSecondRelease,
    nextReleaseAt: isSecondRelease ? 0 : now,
  };
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

module.exports = {
  VALID_ACTIVATION_MODES,
  csvEscape,
  detectCsvDelimiter,
  findBestMatchingSnippet,
  normalizeActivationMode,
  normalizeForMatch,
  parseCsv,
  resolveShiftActivation,
};
