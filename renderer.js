const searchInput = document.querySelector('[data-search]');
const addForm = document.querySelector('[data-add-form]');
const triggerInput = document.querySelector('[data-trigger]');
const collectionSelect = document.querySelector('[data-collection-select]');
const textInput = document.querySelector('[data-text]');
const saveSnippetButton = document.querySelector('[data-save-snippet]');
const tableBody = document.querySelector('[data-snippets-body]');
const emptyState = document.querySelector('[data-empty-state]');
const statusText = document.querySelector('[data-status]');
const importCsvButton = document.querySelector('[data-import-csv]');
const exportCsvButton = document.querySelector('[data-export-csv]');
const themeSelect = document.querySelector('[data-theme-select]');
const navButtons = document.querySelectorAll('[data-nav-target]');
const views = document.querySelectorAll('[data-view]');
const settingInputs = document.querySelectorAll('[data-setting]');
const collectionForm = document.querySelector('[data-collection-form]');
const collectionNameInput = document.querySelector('[data-collection-name]');
const collectionsList = document.querySelector('[data-collections-list]');
const collectionsEmpty = document.querySelector('[data-collections-empty]');
const confirmDialog = document.querySelector('[data-confirm-dialog]');
const confirmTitle = document.querySelector('[data-confirm-title]');
const confirmMessage = document.querySelector('[data-confirm-message]');
const confirmDetail = document.querySelector('[data-confirm-detail]');
const confirmCancel = document.querySelector('[data-confirm-cancel]');
const confirmSecondary = document.querySelector('[data-confirm-secondary]');
const confirmAccept = document.querySelector('[data-confirm-accept]');

let snippets = [];
let collections = [];
let settings = {};
let editingTrigger = '';
let pendingConfirm = null;
let statusTimer = null;
const snippetGroupPages = {};
const collapsedSnippetGroups = {};
const collectionSnippetPages = {};

const DEFAULT_STATUS_MESSAGE = 'Listo para usar.';
const STATUS_VISIBLE_MS = 4500;
const SNIPPETS_PER_PAGE = 10;
const COLLECTION_SNIPPETS_PER_PAGE = 5;
const UNASSIGNED_COLLECTION_ID = '__sin_coleccion__';

function setStatus(message, options = {}) {
  const { temporary = true } = options;

  window.clearTimeout(statusTimer);
  statusText.textContent = message;

  if (!temporary) {
    return;
  }

  statusTimer = window.setTimeout(() => {
    statusText.textContent = DEFAULT_STATUS_MESSAGE;
    statusTimer = null;
  }, STATUS_VISIBLE_MS);
}

function setEditingTrigger(trigger) {
  editingTrigger = trigger;
  saveSnippetButton.textContent = editingTrigger ? 'Guardar cambios' : '+ Nuevo Snippet';
}

function focusSoon(element) {
  window.setTimeout(() => {
    element.focus();
  }, 0);
}

function closeConfirmDialog(value) {
  if (!pendingConfirm) {
    return;
  }

  confirmDialog.hidden = true;
  confirmDetail.hidden = true;
  confirmSecondary.hidden = true;
  pendingConfirm.resolve(value);
  pendingConfirm = null;
}

function showConfirmDialog({
  title,
  message,
  detail = '',
  acceptLabel = 'Eliminar',
  acceptValue = true,
  secondaryLabel = '',
  secondaryValue = false,
  cancelLabel = 'Cancelar',
  cancelValue = false,
}) {
  if (pendingConfirm) {
    closeConfirmDialog(false);
  }

  confirmTitle.textContent = title;
  confirmMessage.textContent = message;
  confirmDetail.textContent = detail;
  confirmDetail.hidden = !detail;
  confirmCancel.textContent = cancelLabel;
  confirmCancel.dataset.confirmValue = String(cancelValue);
  confirmSecondary.textContent = secondaryLabel;
  confirmSecondary.hidden = !secondaryLabel;
  confirmSecondary.dataset.confirmValue = String(secondaryValue);
  confirmAccept.textContent = acceptLabel;
  confirmAccept.dataset.confirmValue = String(acceptValue);
  confirmDialog.hidden = false;
  focusSoon(confirmAccept);

  return new Promise((resolve) => {
    pendingConfirm = {
      resolve,
      acceptValue,
      cancelValue,
      secondaryValue,
    };
  });
}

function escapeNewlines(value) {
  return value.replace(/\n/g, '\\n');
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function applyAppearance() {
  document.body.dataset.theme = settings.theme || 'mint';
  themeSelect.value = settings.theme || 'mint';
}

function getFilteredSnippets() {
  const query = normalizeSearchText(searchInput.value);

  if (!query) {
    return snippets;
  }

  const matchingCollectionIds = new Set(
    collections
      .filter((collection) => normalizeSearchText(collection.name).includes(query))
      .map((collection) => collection.id)
  );
  const matchesUnassignedCollection = normalizeSearchText('Sin coleccion').includes(query);

  return snippets.filter((snippet) => (
    matchingCollectionIds.has(snippet.collectionId)
    || (!snippet.collectionId && matchesUnassignedCollection)
    || normalizeSearchText(snippet.trigger).includes(query)
    || normalizeSearchText(snippet.text).includes(query)
  ));
}

function getCollectionName(collectionId) {
  if (!collectionId) {
    return 'Sin coleccion';
  }

  const collection = collections.find((item) => item.id === collectionId);
  return collection ? collection.name : 'Sin coleccion';
}

function renderCollectionSelect() {
  collectionSelect.innerHTML = '<option value="">Sin coleccion</option>';

  collections.forEach((collection) => {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.name;
    collectionSelect.append(option);
  });
}

/*
function renderSnippetsFlat() {
  const filteredSnippets = getFilteredSnippets();
  const pageCount = Math.max(1, Math.ceil(filteredSnippets.length / SNIPPETS_PER_PAGE));
  snippetsPage = Math.min(Math.max(snippetsPage, 1), pageCount);
  const pageStart = (snippetsPage - 1) * SNIPPETS_PER_PAGE;
  const visibleSnippets = filteredSnippets.slice(pageStart, pageStart + SNIPPETS_PER_PAGE);

  tableBody.innerHTML = '';
  emptyState.hidden = filteredSnippets.length > 0;
  snippetsPagination.hidden = filteredSnippets.length <= SNIPPETS_PER_PAGE;
  snippetsPrevButton.disabled = snippetsPage <= 1;
  snippetsNextButton.disabled = snippetsPage >= pageCount;
  snippetsPageStatus.textContent = filteredSnippets.length > 0
    ? `Pagina ${snippetsPage} de ${pageCount} (${filteredSnippets.length} snippets)`
    : '';

  visibleSnippets.forEach((snippet) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span class="trigger"></span></td>
      <td class="collection-cell"></td>
      <td class="replacement"></td>
      <td>
        <div class="actions">
          <button class="icon-button active" type="button" title="Editar" aria-label="Editar">E</button>
          <button class="icon-button danger" type="button" title="Eliminar" aria-label="Eliminar">X</button>
        </div>
      </td>
    `;

    row.querySelector('.trigger').textContent = snippet.trigger;
    row.querySelector('.collection-cell').textContent = getCollectionName(snippet.collectionId);
    row.querySelector('.replacement').textContent = escapeNewlines(snippet.text);

    const [editButton, deleteButton] = row.querySelectorAll('button');

    editButton.addEventListener('click', () => {
      setEditingTrigger(snippet.trigger);
      triggerInput.value = snippet.trigger;
      collectionSelect.value = snippet.collectionId || '';
      textInput.value = snippet.text;
      triggerInput.focus();
      setStatus('Snippet cargado para editar.');
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        title: 'Eliminar snippet',
        message: `¿Eliminar el snippet "${snippet.trigger}"? Esta accion no se puede deshacer.`,
      });

      if (!confirmed) {
        return;
      }

      snippets = await window.snippetsApi.delete(snippet.trigger);
      if (editingTrigger === snippet.trigger) {
        addForm.reset();
        setEditingTrigger('');
      }
      renderSnippets();
      focusSoon(triggerInput);
      setStatus(`Snippet ${snippet.trigger} eliminado.`);
    });

    tableBody.append(row);
  });
}

*/
function getOrderedSnippetGroups(filteredSnippets) {
  const groupsById = new Map();
  const orderedGroups = collections.map((collection) => {
    const group = {
      id: collection.id,
      name: collection.name,
      snippets: [],
    };

    groupsById.set(collection.id, group);
    return group;
  });
  const unassignedGroup = {
    id: UNASSIGNED_COLLECTION_ID,
    name: 'Sin coleccion',
    snippets: [],
  };

  filteredSnippets.forEach((snippet) => {
    const group = groupsById.get(snippet.collectionId) || unassignedGroup;
    group.snippets.push(snippet);
  });

  return orderedGroups
    .filter((group) => group.snippets.length > 0)
    .concat(unassignedGroup.snippets.length > 0 ? [unassignedGroup] : []);
}

function renderSnippetDataRow(snippet) {
  const row = document.createElement('tr');
  row.innerHTML = `
    <td><span class="trigger"></span></td>
    <td class="collection-cell"></td>
    <td class="replacement"></td>
    <td>
      <div class="actions">
        <button class="icon-button active" type="button" title="Editar" aria-label="Editar">E</button>
        <button class="icon-button danger" type="button" title="Eliminar" aria-label="Eliminar">X</button>
      </div>
    </td>
  `;

  row.querySelector('.trigger').textContent = snippet.trigger;
  row.querySelector('.collection-cell').textContent = getCollectionName(snippet.collectionId);
  row.querySelector('.replacement').textContent = escapeNewlines(snippet.text);

  const [editButton, deleteButton] = row.querySelectorAll('button');

  editButton.addEventListener('click', () => {
    setEditingTrigger(snippet.trigger);
    triggerInput.value = snippet.trigger;
    collectionSelect.value = snippet.collectionId || '';
    textInput.value = snippet.text;
    triggerInput.focus();
    setStatus('Snippet cargado para editar.');
  });

  deleteButton.addEventListener('click', async () => {
    const confirmed = await showConfirmDialog({
      title: 'Eliminar snippet',
      message: `Eliminar el snippet "${snippet.trigger}"? Esta accion no se puede deshacer.`,
    });

    if (!confirmed) {
      return;
    }

    snippets = await window.snippetsApi.delete(snippet.trigger);
    if (editingTrigger === snippet.trigger) {
      addForm.reset();
      setEditingTrigger('');
    }
    renderSnippets();
    focusSoon(triggerInput);
    setStatus(`Snippet ${snippet.trigger} eliminado.`);
  });

  return row;
}

function renderSnippets() {
  const filteredSnippets = getFilteredSnippets();
  const snippetGroups = getOrderedSnippetGroups(filteredSnippets);
  const snippetGroupIds = new Set(snippetGroups.map((group) => group.id));

  tableBody.innerHTML = '';
  emptyState.hidden = filteredSnippets.length > 0;

  Object.keys(snippetGroupPages).forEach((groupId) => {
    if (!snippetGroupIds.has(groupId)) {
      delete snippetGroupPages[groupId];
    }
  });

  Object.keys(collapsedSnippetGroups).forEach((groupId) => {
    if (!snippetGroupIds.has(groupId)) {
      delete collapsedSnippetGroups[groupId];
    }
  });

  snippetGroups.forEach((group) => {
    const isCollapsed = Boolean(collapsedSnippetGroups[group.id]);
    const pageCount = Math.max(1, Math.ceil(group.snippets.length / SNIPPETS_PER_PAGE));
    snippetGroupPages[group.id] = Math.min(
      Math.max(snippetGroupPages[group.id] || 1, 1),
      pageCount
    );

    const groupPage = snippetGroupPages[group.id];
    const pageStart = (groupPage - 1) * SNIPPETS_PER_PAGE;
    const visibleSnippets = group.snippets.slice(pageStart, pageStart + SNIPPETS_PER_PAGE);
    const groupRow = document.createElement('tr');
    groupRow.className = 'snippet-group-row';
    groupRow.innerHTML = `
      <td colspan="4">
        <button class="snippet-group-toggle" type="button" aria-expanded="${!isCollapsed}">
          <span class="snippet-group-arrow" aria-hidden="true"></span>
          <span class="snippet-group-name"></span>
          <span class="snippet-group-count"></span>
        </button>
      </td>
    `;

    groupRow.querySelector('.snippet-group-name').textContent = group.name;
    groupRow.querySelector('.snippet-group-count').textContent = `${group.snippets.length} snippets`;
    groupRow.querySelector('.snippet-group-toggle').addEventListener('click', () => {
      collapsedSnippetGroups[group.id] = !isCollapsed;
      renderSnippets();
    });
    tableBody.append(groupRow);

    if (isCollapsed) {
      return;
    }

    visibleSnippets.forEach((snippet) => {
      tableBody.append(renderSnippetDataRow(snippet));
    });

    if (group.snippets.length > SNIPPETS_PER_PAGE) {
      const paginationRow = document.createElement('tr');
      paginationRow.className = 'snippet-group-pagination-row';
      paginationRow.innerHTML = `
        <td colspan="4">
          <div class="pagination snippet-group-pagination">
            <button class="secondary-button snippet-group-prev" type="button">Anterior</button>
            <p class="page-status"></p>
            <button class="secondary-button snippet-group-next" type="button">Siguiente</button>
          </div>
        </td>
      `;
      const prevButton = paginationRow.querySelector('.snippet-group-prev');
      const nextButton = paginationRow.querySelector('.snippet-group-next');

      prevButton.disabled = groupPage <= 1;
      nextButton.disabled = groupPage >= pageCount;
      paginationRow.querySelector('.page-status').textContent = `Pagina ${groupPage} de ${pageCount}`;
      prevButton.addEventListener('click', () => {
        snippetGroupPages[group.id] -= 1;
        renderSnippets();
      });
      nextButton.addEventListener('click', () => {
        snippetGroupPages[group.id] += 1;
        renderSnippets();
      });
      tableBody.append(paginationRow);
    }
  });
}

function renderCollections() {
  collectionsList.innerHTML = '';
  collectionsEmpty.hidden = collections.length > 0;
  const collectionIds = new Set(collections.map((collection) => collection.id));

  Object.keys(collectionSnippetPages).forEach((collectionId) => {
    if (!collectionIds.has(collectionId)) {
      delete collectionSnippetPages[collectionId];
    }
  });

  collections.forEach((collection) => {
    const item = document.createElement('div');
    item.className = 'collection-card';
    item.innerHTML = `
      <div class="collection-header">
        <div class="collection-editor">
          <input class="field collection-name" type="text" aria-label="Nombre de coleccion">
          <p class="setting-copy"></p>
        </div>
        <div class="collection-actions">
          <label class="toggle" aria-label="Activar coleccion">
            <input class="collection-enabled" type="checkbox">
            <span class="toggle-track"></span>
          </label>
          <button class="secondary-button save-collection" type="button" hidden>Guardar</button>
          <button class="secondary-button danger-button delete-collection" type="button">Eliminar</button>
        </div>
      </div>
      <div class="snippet-list"></div>
      <div class="pagination collection-snippet-pagination" hidden>
        <button class="secondary-button collection-snippets-prev" type="button">Anterior</button>
        <p class="page-status collection-snippets-page-status"></p>
        <button class="secondary-button collection-snippets-next" type="button">Siguiente</button>
      </div>
    `;

    const collectionSnippets = snippets.filter((snippet) => snippet.collectionId === collection.id);
    const collectionSnippetPageCount = Math.max(
      1,
      Math.ceil(collectionSnippets.length / COLLECTION_SNIPPETS_PER_PAGE)
    );
    collectionSnippetPages[collection.id] = Math.min(
      Math.max(collectionSnippetPages[collection.id] || 1, 1),
      collectionSnippetPageCount
    );
    const collectionSnippetPage = collectionSnippetPages[collection.id];
    const collectionSnippetStart = (collectionSnippetPage - 1) * COLLECTION_SNIPPETS_PER_PAGE;
    const visibleCollectionSnippets = collectionSnippets.slice(
      collectionSnippetStart,
      collectionSnippetStart + COLLECTION_SNIPPETS_PER_PAGE
    );
    const nameInput = item.querySelector('.collection-name');
    const saveButton = item.querySelector('.save-collection');
    const deleteButton = item.querySelector('.delete-collection');
    const toggle = item.querySelector('.collection-enabled');
    const snippetPagination = item.querySelector('.collection-snippet-pagination');
    const snippetPrevButton = item.querySelector('.collection-snippets-prev');
    const snippetNextButton = item.querySelector('.collection-snippets-next');
    const snippetPageStatus = item.querySelector('.collection-snippets-page-status');

    nameInput.value = collection.name;
    saveButton.hidden = true;
    item.querySelector('.setting-copy').textContent = collection.enabled === false
      ? 'Coleccion desactivada'
      : 'Coleccion activa';

    nameInput.addEventListener('input', () => {
      saveButton.hidden = nameInput.value !== collection.name ? false : true;
    });

    toggle.checked = collection.enabled !== false;
    toggle.addEventListener('change', async () => {
      collections = await window.snippetsApi.updateCollection({
        ...collection,
        name: nameInput.value,
        enabled: toggle.checked,
      });
      renderCollectionSelect();
      renderCollections();
      renderSnippets();
      focusSoon(collectionNameInput);
      setStatus('Coleccion actualizada.');
    });

    saveButton.addEventListener('click', async () => {
      try {
        collections = await window.snippetsApi.updateCollection({
          ...collection,
          name: nameInput.value,
          enabled: toggle.checked,
        });
        renderCollectionSelect();
        renderCollections();
        renderSnippets();
        focusSoon(collectionNameInput);
        setStatus('Coleccion guardada.');
      } catch (error) {
        setStatus(error.message);
      }
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        title: 'Eliminar coleccion',
        message: `¿Eliminar la coleccion "${collection.name}"? Sus snippets quedaran sin coleccion. Esta accion no se puede deshacer.`,
      });

      if (!confirmed) {
        focusSoon(collectionNameInput);
        return;
      }

      const result = await window.snippetsApi.deleteCollection({
        collectionId: collection.id,
      });

      collections = result.collections;
      snippets = result.snippets;
      renderCollectionSelect();
      renderSnippets();
      renderCollections();
      focusSoon(collectionNameInput);
      setStatus(`Coleccion eliminada. ${result.affectedCount} snippets quedaron sin coleccion.`);
    });

    const snippetList = item.querySelector('.snippet-list');

    if (collectionSnippets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'snippet-empty';
      empty.textContent = 'No hay snippets en esta coleccion.';
      snippetList.append(empty);
    } else {
      visibleCollectionSnippets.forEach((snippet) => {
        const snippetItem = document.createElement('div');
        snippetItem.className = 'snippet-item';
        snippetItem.innerHTML = `
          <span class="trigger"></span>
          <span class="replacement"></span>
        `;
        snippetItem.querySelector('.trigger').textContent = snippet.trigger;
        snippetItem.querySelector('.replacement').textContent = escapeNewlines(snippet.text);
        snippetList.append(snippetItem);
      });
    }

    snippetPagination.hidden = collectionSnippets.length <= COLLECTION_SNIPPETS_PER_PAGE;
    snippetPrevButton.disabled = collectionSnippetPage <= 1;
    snippetNextButton.disabled = collectionSnippetPage >= collectionSnippetPageCount;
    snippetPageStatus.textContent = collectionSnippets.length > 0
      ? `Pagina ${collectionSnippetPage} de ${collectionSnippetPageCount} (${collectionSnippets.length} snippets)`
      : '';

    snippetPrevButton.addEventListener('click', () => {
      collectionSnippetPages[collection.id] -= 1;
      renderCollections();
    });

    snippetNextButton.addEventListener('click', () => {
      collectionSnippetPages[collection.id] += 1;
      renderCollections();
    });

    collectionsList.append(item);
  });
}

function showView(viewName) {
  views.forEach((view) => {
    view.hidden = view.dataset.view !== viewName;
  });

  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.navTarget === viewName);
  });
}

function renderSettings() {
  settingInputs.forEach((input) => {
    input.checked = Boolean(settings[input.dataset.setting]);
  });
  applyAppearance();
}

async function loadSnippets() {
  snippets = await window.snippetsApi.list();
  renderSnippets();
  renderCollections();
}

async function loadCollections() {
  collections = await window.snippetsApi.listCollections();
  renderCollectionSelect();
  renderSnippets();
  renderCollections();
}

async function loadSettings() {
  settings = await window.snippetsApi.getSettings();
  renderSettings();
}

async function refreshAfterImport(result) {
  snippets = await window.snippetsApi.list();
  collections = await window.snippetsApi.listCollections();
  renderCollectionSelect();
  renderSnippets();
  renderCollections();
  const collectionMessage = result.collectionName ? ` Coleccion: ${result.collectionName}.` : '';
  setStatus(`CSV importado: ${result.importedCount} snippets, ${result.skippedCount} filas omitidas.${collectionMessage}`);
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const snippet = {
    trigger: triggerInput.value,
    collectionId: collectionSelect.value,
    text: textInput.value,
    originalTrigger: editingTrigger,
  };

  try {
    snippets = await window.snippetsApi.create(snippet);
    addForm.reset();
    setEditingTrigger('');
    renderSnippets();
    focusSoon(triggerInput);
    setStatus(`Snippet ${snippet.trigger.trim()} guardado.`);
  } catch (error) {
    setStatus(error.message);
  }
});

collectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    collections = await window.snippetsApi.createCollection({
      name: collectionNameInput.value,
    });
    collectionForm.reset();
    renderCollectionSelect();
    renderCollections();
    renderSnippets();
    focusSoon(collectionNameInput);
    setStatus('Coleccion guardada.');
  } catch (error) {
    setStatus(error.message);
  }
});

searchInput.addEventListener('input', () => {
  renderSnippets();
});

importCsvButton.addEventListener('click', async () => {
  try {
    const result = await window.snippetsApi.importCsv();

    if (result.canceled) {
      setStatus('Importacion cancelada.');
      return;
    }

    if (result.needsConflictDecision) {
      const conflictList = result.conflicts.map((trigger) => `- ${trigger}`).join('\n');
      const decision = await showConfirmDialog({
        title: 'Abreviaturas repetidas',
        message: `¿Deseas reescribir los snippets existentes, omitirlos o cancelar la importacion?`,
        detail: conflictList,
        acceptLabel: 'Reescribir',
        acceptValue: 'overwrite',
        secondaryLabel: 'Omitir',
        secondaryValue: 'skip',
        cancelLabel: 'Cancelar',
        cancelValue: 'cancel',
      });

      if (decision === 'cancel') {
        await window.snippetsApi.importCsv({ conflictStrategy: 'cancel' });
        setStatus('Importacion cancelada.');
        return;
      }

      const resolvedResult = await window.snippetsApi.importCsv({ conflictStrategy: decision });
      await refreshAfterImport(resolvedResult);
      return;
    }

    await refreshAfterImport(result);
  } catch (error) {
    setStatus(error.message);
  }
});

exportCsvButton.addEventListener('click', async () => {
  try {
    const result = await window.snippetsApi.exportCsv();

    if (result.canceled) {
      setStatus('Exportacion cancelada.');
      return;
    }

    setStatus(`CSV exportado: ${result.exportedCount} snippets.`);
  } catch (error) {
    setStatus(error.message);
  }
});

themeSelect.addEventListener('change', async () => {
  settings = await window.snippetsApi.updateSettings({
    theme: themeSelect.value,
  });
  renderSettings();
  setStatus('Tema guardado.');
});

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    showView(button.dataset.navTarget);
  });
});

settingInputs.forEach((input) => {
  input.addEventListener('change', async () => {
    const key = input.dataset.setting;

    settings = await window.snippetsApi.updateSettings({
      [key]: input.checked,
    });

    renderSettings();
    setStatus('Ajustes guardados.');
  });
});

confirmCancel.addEventListener('click', () => {
  closeConfirmDialog(pendingConfirm ? pendingConfirm.cancelValue : false);
});

confirmSecondary.addEventListener('click', () => {
  closeConfirmDialog(pendingConfirm ? pendingConfirm.secondaryValue : false);
});

confirmAccept.addEventListener('click', () => {
  closeConfirmDialog(pendingConfirm ? pendingConfirm.acceptValue : true);
});

confirmDialog.addEventListener('click', (event) => {
  if (event.target === confirmDialog) {
    closeConfirmDialog(pendingConfirm ? pendingConfirm.cancelValue : false);
  }
});

document.addEventListener('keydown', (event) => {
  if (!pendingConfirm) {
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    closeConfirmDialog(pendingConfirm.acceptValue);
  }

  if (event.key === 'Escape') {
    closeConfirmDialog(pendingConfirm.cancelValue);
  }
});

window.snippetsApi.onChanged((nextSnippets) => {
  snippets = nextSnippets;
  renderSnippets();
  renderCollections();
});

window.snippetsApi.onCollectionsChanged((nextCollections) => {
  collections = nextCollections;
  renderCollectionSelect();
  renderSnippets();
  renderCollections();
});

window.snippetsApi.onListenerError((message) => {
  setStatus(message);
});

loadSnippets();
loadCollections();
loadSettings();
