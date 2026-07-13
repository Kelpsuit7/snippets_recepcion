const searchInput = document.querySelector('[data-search]');
const addForm = document.querySelector('[data-add-form]');
const triggerInput = document.querySelector('[data-trigger]');
const collectionSelect = document.querySelector('[data-collection-select]');
const textInput = document.querySelector('[data-text]');
const saveSnippetButton = document.querySelector('[data-save-snippet]');
const cancelEditButton = document.querySelector('[data-cancel-edit]');
const tableBody = document.querySelector('[data-snippets-body]');
const emptyState = document.querySelector('[data-empty-state]');
const statusText = document.querySelector('[data-status]');
const resultsSummary = document.querySelector('[data-results-summary]');
const viewTitle = document.querySelector('[data-view-title]');
const viewSubtitle = document.querySelector('[data-view-subtitle]');
const importCsvButton = document.querySelector('[data-import-csv]');
const exportCsvButton = document.querySelector('[data-export-csv]');
const deleteAllSnippetsButton = document.querySelector('[data-delete-all-snippets]');
const themeSelect = document.querySelector('[data-theme-select]');
const navButtons = document.querySelectorAll('[data-nav-target]');
const views = document.querySelectorAll('[data-view]');
const settingInputs = document.querySelectorAll('[data-setting]');
const collectionForm = document.querySelector('[data-collection-form]');
const collectionNameInput = document.querySelector('[data-collection-name]');
const createCollectionButton = collectionForm.querySelector('button[type="submit"]');
const collectionsList = document.querySelector('[data-collections-list]');
const collectionsEmpty = document.querySelector('[data-collections-empty]');
const confirmDialog = document.querySelector('[data-confirm-dialog]');
const confirmTitle = document.querySelector('[data-confirm-title]');
const confirmMessage = document.querySelector('[data-confirm-message]');
const confirmDetail = document.querySelector('[data-confirm-detail]');
const confirmCancel = document.querySelector('[data-confirm-cancel]');
const confirmSecondary = document.querySelector('[data-confirm-secondary]');
const confirmAccept = document.querySelector('[data-confirm-accept]');
const confirmVerification = document.querySelector('[data-confirm-verification]');
const confirmVerificationText = document.querySelector('[data-confirm-verification-text]');
const confirmVerificationInput = document.querySelector('[data-confirm-verification-input]');

let snippets = [];
let collections = [];
let settings = {};
let editingTrigger = '';
let pendingConfirm = null;
let statusTimer = null;
const snippetGroupPages = {};
const collapsedSnippetGroups = {};
const collectionSnippetPages = {};

const STATUS_VISIBLE_MS = 4500;
const SNIPPETS_PER_PAGE = 10;
const COLLECTION_SNIPPETS_PER_PAGE = 5;
const UNASSIGNED_COLLECTION_ID = '__sin_coleccion__';
const VIEW_METADATA = {
  snippets: {
    title: 'Gestor de snippets',
    subtitle: 'Administra abreviaturas, reemplazos y expansiones rápidas.',
  },
  collections: {
    title: 'Colecciones',
    subtitle: 'Organiza tus snippets y controla qué grupos están activos.',
  },
  settings: {
    title: 'Ajustes',
    subtitle: 'Personaliza el funcionamiento, los respaldos y la apariencia.',
  },
};

function setStatus(message, options = {}) {
  const { temporary = true, tone = 'info' } = options;

  window.clearTimeout(statusTimer);

  if (!message) {
    statusText.textContent = '';
    statusText.hidden = true;
    statusText.dataset.tone = 'info';
    statusTimer = null;
    return;
  }

  statusText.textContent = message;
  statusText.hidden = false;
  statusText.dataset.tone = tone;

  if (!temporary) {
    return;
  }

  statusTimer = window.setTimeout(() => {
    setStatus('');
  }, STATUS_VISIBLE_MS);
}

function setEditingTrigger(trigger) {
  editingTrigger = trigger;
  saveSnippetButton.textContent = editingTrigger ? 'Guardar cambios' : 'Crear snippet';
  cancelEditButton.hidden = !editingTrigger;
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
  confirmVerification.hidden = true;
  confirmVerificationInput.value = '';
  confirmAccept.disabled = false;
  const { resolve, previousFocus } = pendingConfirm;
  pendingConfirm = null;
  resolve(value);

  if (previousFocus && previousFocus.isConnected) {
    focusSoon(previousFocus);
  }
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
  requiredText = '',
}) {
  if (pendingConfirm) {
    closeConfirmDialog(false);
  }

  const previousFocus = document.activeElement;

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
  confirmVerificationText.textContent = requiredText;
  confirmVerificationInput.value = '';
  confirmVerification.hidden = !requiredText;
  confirmAccept.disabled = Boolean(requiredText);
  confirmDialog.hidden = false;
  focusSoon(requiredText ? confirmVerificationInput : confirmAccept);

  return new Promise((resolve) => {
    pendingConfirm = {
      resolve,
      acceptValue,
      cancelValue,
      secondaryValue,
      requiredText,
      previousFocus,
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
  const matchesUnassignedCollection = normalizeSearchText('Sin colección').includes(query);

  return snippets.filter((snippet) => (
    matchingCollectionIds.has(snippet.collectionId)
    || (!snippet.collectionId && matchesUnassignedCollection)
    || normalizeSearchText(snippet.trigger).includes(query)
    || normalizeSearchText(snippet.text).includes(query)
  ));
}

function getCollectionName(collectionId) {
  if (!collectionId) {
    return 'Sin colección';
  }

  const collection = collections.find((item) => item.id === collectionId);
  return collection ? collection.name : 'Sin colección';
}

function renderCollectionSelect() {
  collectionSelect.innerHTML = '<option value="">Sin colección</option>';

  collections.forEach((collection) => {
    const option = document.createElement('option');
    option.value = collection.id;
    option.textContent = collection.name;
    collectionSelect.append(option);
  });
}

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
    name: 'Sin colección',
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
        <button class="secondary-button row-action-button" type="button">Editar</button>
        <button class="secondary-button danger-button row-action-button" type="button">Eliminar</button>
      </div>
    </td>
  `;

  row.querySelector('.trigger').textContent = snippet.trigger;
  row.querySelector('.collection-cell').textContent = getCollectionName(snippet.collectionId);
  row.querySelector('.replacement').textContent = escapeNewlines(snippet.text);

  const [editButton, deleteButton] = row.querySelectorAll('button');
  editButton.setAttribute('aria-label', `Editar snippet ${snippet.trigger}`);
  deleteButton.setAttribute('aria-label', `Eliminar snippet ${snippet.trigger}`);

  editButton.addEventListener('click', () => {
    setEditingTrigger(snippet.trigger);
    triggerInput.value = snippet.trigger;
    collectionSelect.value = snippet.collectionId || '';
    textInput.value = snippet.text;
    addForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    focusSoon(triggerInput);
    setStatus('Snippet cargado para editar.');
  });

  deleteButton.addEventListener('click', async () => {
    const confirmed = await showConfirmDialog({
      title: 'Eliminar snippet',
      message: `¿Eliminar el snippet "${snippet.trigger}"? Esta acción no se puede deshacer.`,
    });

    if (!confirmed) {
      return;
    }

    try {
      snippets = await window.snippetsApi.delete(snippet.trigger);
      if (editingTrigger === snippet.trigger) {
        addForm.reset();
        setEditingTrigger('');
      }
      renderSnippets();
      focusSoon(triggerInput);
      setStatus(`Snippet ${snippet.trigger} eliminado.`);
    } catch (error) {
      setStatus(error.message, { tone: 'error' });
    }
  });

  return row;
}

function renderSnippets() {
  const filteredSnippets = getFilteredSnippets();
  const snippetGroups = getOrderedSnippetGroups(filteredSnippets);
  const snippetGroupIds = new Set(snippetGroups.map((group) => group.id));

  tableBody.innerHTML = '';
  emptyState.hidden = filteredSnippets.length > 0;
  const hasSearch = Boolean(searchInput.value.trim());
  emptyState.textContent = hasSearch
    ? 'No hay resultados para esta búsqueda.'
    : 'No hay snippets para mostrar.';
  resultsSummary.textContent = hasSearch
    ? `${filteredSnippets.length} de ${snippets.length} snippets`
    : `${snippets.length} snippets en total`;

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
    if (!Object.prototype.hasOwnProperty.call(collapsedSnippetGroups, group.id)) {
      collapsedSnippetGroups[group.id] = true;
    }

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
          <span class="snippet-group-arrow" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M4.75 3.5 4.75 12.5 14.5 8Z" fill="currentColor"></path>
            </svg>
          </span>
          <span class="snippet-group-name"></span>
          <span class="snippet-group-count"></span>
        </button>
      </td>
    `;

    const groupToggle = groupRow.querySelector('.snippet-group-toggle');
    groupRow.querySelector('.snippet-group-name').textContent = group.name;
    groupRow.querySelector('.snippet-group-count').textContent = `${group.snippets.length} snippets`;
    groupToggle.setAttribute('aria-label', `${isCollapsed ? 'Expandir' : 'Contraer'} colección ${group.name}`);
    groupToggle.addEventListener('click', () => {
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
      paginationRow.querySelector('.page-status').textContent = `Página ${groupPage} de ${pageCount}`;
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
    const statusCopy = item.querySelector('.setting-copy');
    const snippetPagination = item.querySelector('.collection-snippet-pagination');
    const snippetPrevButton = item.querySelector('.collection-snippets-prev');
    const snippetNextButton = item.querySelector('.collection-snippets-next');
    const snippetPageStatus = item.querySelector('.collection-snippets-page-status');

    nameInput.value = collection.name;
    nameInput.setAttribute('aria-label', `Nombre de la colección ${collection.name}`);
    toggle.setAttribute('aria-label', `${collection.enabled === false ? 'Activar' : 'Desactivar'} colección ${collection.name}`);
    deleteButton.setAttribute('aria-label', `Eliminar colección ${collection.name}`);
    saveButton.hidden = true;
    statusCopy.textContent = collection.enabled === false
      ? 'Colección desactivada'
      : 'Colección activa';

    nameInput.addEventListener('input', () => {
      const isDirty = nameInput.value !== collection.name;
      const hasValidName = Boolean(nameInput.value.trim());
      saveButton.hidden = !isDirty;
      saveButton.disabled = !hasValidName;
      toggle.disabled = isDirty;
      statusCopy.textContent = isDirty
        ? (hasValidName ? 'Cambios sin guardar' : 'El nombre no puede estar vacío')
        : (collection.enabled === false ? 'Colección desactivada' : 'Colección activa');
    });

    toggle.checked = collection.enabled !== false;
    toggle.addEventListener('change', async () => {
      try {
        collections = await window.snippetsApi.updateCollection({
          ...collection,
          enabled: toggle.checked,
        });
        renderCollectionSelect();
        renderCollections();
        renderSnippets();
        setStatus('Colección actualizada.');
      } catch (error) {
        toggle.checked = !toggle.checked;
        setStatus(error.message, { tone: 'error' });
      }
    });

    saveButton.addEventListener('click', async () => {
      try {
        collections = await window.snippetsApi.updateCollection({
          ...collection,
          name: nameInput.value.trim(),
          enabled: toggle.checked,
        });
        renderCollectionSelect();
        renderCollections();
        renderSnippets();
        setStatus('Colección guardada.');
      } catch (error) {
        setStatus(error.message, { tone: 'error' });
      }
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        title: 'Eliminar colección',
        message: `¿Eliminar la colección "${collection.name}"? Sus snippets quedarán sin colección. Esta acción no se puede deshacer.`,
      });

      if (!confirmed) {
        focusSoon(collectionNameInput);
        return;
      }

      try {
        const result = await window.snippetsApi.deleteCollection({
          collectionId: collection.id,
        });

        collections = result.collections;
        snippets = result.snippets;
        renderCollectionSelect();
        renderSnippets();
        renderCollections();
        setStatus(`Colección eliminada. ${result.affectedCount} snippets quedaron sin colección.`);
      } catch (error) {
        setStatus(error.message, { tone: 'error' });
      }
    });

    const snippetList = item.querySelector('.snippet-list');

    if (collectionSnippets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'snippet-empty';
      empty.textContent = 'No hay snippets en esta colección.';
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
      ? `Página ${collectionSnippetPage} de ${collectionSnippetPageCount} (${collectionSnippets.length} snippets)`
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
  const viewMetadata = VIEW_METADATA[viewName] || VIEW_METADATA.snippets;

  views.forEach((view) => {
    view.hidden = view.dataset.view !== viewName;
  });

  navButtons.forEach((button) => {
    const isActive = button.dataset.navTarget === viewName;
    button.classList.toggle('active', isActive);
    if (isActive) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });

  viewTitle.textContent = viewMetadata.title;
  viewSubtitle.textContent = viewMetadata.subtitle;
}

function renderSettings() {
  settingInputs.forEach((input) => {
    input.checked = Boolean(settings[input.dataset.setting]);
  });
  applyAppearance();
}

async function initializeApp() {
  document.body.setAttribute('aria-busy', 'true');
  setStatus('Cargando información...', { temporary: false });

  try {
    [snippets, collections, settings] = await Promise.all([
      window.snippetsApi.list(),
      window.snippetsApi.listCollections(),
      window.snippetsApi.getSettings(),
    ]);
    renderCollectionSelect();
    renderSettings();
    renderSnippets();
    renderCollections();
    showView('snippets');
    setStatus('');
  } catch (error) {
    setStatus(`No se pudo cargar la información: ${error.message}`, {
      temporary: false,
      tone: 'error',
    });
  } finally {
    document.body.removeAttribute('aria-busy');
  }
}

async function refreshAfterImport(result) {
  snippets = await window.snippetsApi.list();
  collections = await window.snippetsApi.listCollections();
  renderCollectionSelect();
  renderSnippets();
  renderCollections();
  const collectionMessage = result.collectionName ? ` Colección: ${result.collectionName}.` : '';
  setStatus(`CSV importado: ${result.importedCount} snippets, ${result.skippedCount} filas omitidas.${collectionMessage}`);
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveSnippetButton.disabled = true;

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
    setStatus(error.message, { tone: 'error' });
  } finally {
    saveSnippetButton.disabled = false;
  }
});

cancelEditButton.addEventListener('click', () => {
  addForm.reset();
  setEditingTrigger('');
  focusSoon(triggerInput);
  setStatus('Edición cancelada.');
});

collectionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createCollectionButton.disabled = true;

  try {
    collections = await window.snippetsApi.createCollection({
      name: collectionNameInput.value,
    });
    collectionForm.reset();
    renderCollectionSelect();
    renderCollections();
    renderSnippets();
    focusSoon(collectionNameInput);
    setStatus('Colección guardada.');
  } catch (error) {
    setStatus(error.message, { tone: 'error' });
  } finally {
    createCollectionButton.disabled = false;
  }
});

searchInput.addEventListener('input', () => {
  renderSnippets();
});

importCsvButton.addEventListener('click', async () => {
  importCsvButton.disabled = true;

  try {
    const result = await window.snippetsApi.importCsv();

    if (result.canceled) {
      setStatus('Importación cancelada.');
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
        setStatus('Importación cancelada.');
        return;
      }

      const resolvedResult = await window.snippetsApi.importCsv({ conflictStrategy: decision });
      await refreshAfterImport(resolvedResult);
      return;
    }

    await refreshAfterImport(result);
  } catch (error) {
    setStatus(error.message, { tone: 'error' });
  } finally {
    importCsvButton.disabled = false;
  }
});

exportCsvButton.addEventListener('click', async () => {
  exportCsvButton.disabled = true;

  try {
    const result = await window.snippetsApi.exportCsv();

    if (result.canceled) {
      setStatus('Exportación cancelada.');
      return;
    }

    setStatus(`CSV exportado: ${result.exportedCount} snippets.`);
  } catch (error) {
    setStatus(error.message, { tone: 'error' });
  } finally {
    exportCsvButton.disabled = false;
  }
});

deleteAllSnippetsButton.addEventListener('click', async () => {
  if (snippets.length === 0 && collections.length === 0) {
    setStatus('No hay snippets ni colecciones para eliminar.');
    return;
  }

  const confirmed = await showConfirmDialog({
    title: 'Eliminar la base de datos',
    message: `Esta acción eliminará permanentemente ${snippets.length} snippets y ${collections.length} colecciones. No se puede deshacer.`,
    acceptLabel: 'Aceptar',
    requiredText: 'Eliminar',
  });

  if (!confirmed) {
    setStatus('Eliminación cancelada.');
    return;
  }

  deleteAllSnippetsButton.disabled = true;

  try {
    const result = await window.snippetsApi.deleteAll('Eliminar');
    snippets = result.snippets;
    collections = result.collections;
    setEditingTrigger('');
    addForm.reset();
    renderCollectionSelect();
    renderSnippets();
    renderCollections();
    setStatus(`${result.deletedCount} snippets y ${result.deletedCollectionCount} colecciones eliminados.`);
  } catch (error) {
    setStatus(error.message, { tone: 'error' });
  } finally {
    deleteAllSnippetsButton.disabled = false;
  }
});

themeSelect.addEventListener('change', async () => {
  const previousTheme = settings.theme || 'mint';

  try {
    settings = await window.snippetsApi.updateSettings({
      theme: themeSelect.value,
    });
    renderSettings();
    setStatus('Tema guardado.');
  } catch (error) {
    themeSelect.value = previousTheme;
    setStatus(error.message, { tone: 'error' });
  }
});

navButtons.forEach((button) => {
  button.addEventListener('click', () => {
    showView(button.dataset.navTarget);
  });
});

settingInputs.forEach((input) => {
  input.addEventListener('change', async () => {
    const key = input.dataset.setting;
    const previousValue = Boolean(settings[key]);
    input.disabled = true;

    try {
      settings = await window.snippetsApi.updateSettings({
        [key]: input.checked,
      });
      renderSettings();
      setStatus('Ajustes guardados.');
    } catch (error) {
      input.checked = previousValue;
      setStatus(error.message, { tone: 'error' });
    } finally {
      input.disabled = false;
    }
  });
});

confirmCancel.addEventListener('click', () => {
  closeConfirmDialog(pendingConfirm ? pendingConfirm.cancelValue : false);
});

confirmSecondary.addEventListener('click', () => {
  closeConfirmDialog(pendingConfirm ? pendingConfirm.secondaryValue : false);
});

confirmAccept.addEventListener('click', () => {
  if (confirmAccept.disabled) {
    return;
  }

  closeConfirmDialog(pendingConfirm ? pendingConfirm.acceptValue : true);
});

confirmVerificationInput.addEventListener('input', () => {
  confirmAccept.disabled = !pendingConfirm
    || confirmVerificationInput.value !== pendingConfirm.requiredText;
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

  if (event.key === 'Tab') {
    const focusableElements = [...confirmDialog.querySelectorAll('button, input')]
      .filter((element) => !element.hidden && !element.disabled && element.offsetParent !== null);
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (focusableElements.length > 0) {
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    if (!confirmAccept.disabled) {
      closeConfirmDialog(pendingConfirm.acceptValue);
    }
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
  setStatus(message, { temporary: false, tone: 'error' });
});

initializeApp();
