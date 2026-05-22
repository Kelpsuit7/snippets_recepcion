const searchInput = document.querySelector('[data-search]');
const addForm = document.querySelector('[data-add-form]');
const triggerInput = document.querySelector('[data-trigger]');
const collectionSelect = document.querySelector('[data-collection-select]');
const textInput = document.querySelector('[data-text]');
const tableBody = document.querySelector('[data-snippets-body]');
const emptyState = document.querySelector('[data-empty-state]');
const statusText = document.querySelector('[data-status]');
const navButtons = document.querySelectorAll('[data-nav-target]');
const views = document.querySelectorAll('[data-view]');
const settingInputs = document.querySelectorAll('[data-setting]');
const collectionForm = document.querySelector('[data-collection-form]');
const collectionNameInput = document.querySelector('[data-collection-name]');
const collectionsList = document.querySelector('[data-collections-list]');
const collectionsEmpty = document.querySelector('[data-collections-empty]');

let snippets = [];
let collections = [];
let settings = {};

function setStatus(message) {
  statusText.textContent = message;
}

function escapeNewlines(value) {
  return value.replace(/\n/g, '\\n');
}

function getFilteredSnippets() {
  const query = searchInput.value.trim().toLowerCase();

  if (!query) {
    return snippets;
  }

  return snippets.filter((snippet) => (
    snippet.trigger.toLowerCase().includes(query)
    || snippet.text.toLowerCase().includes(query)
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

function renderSnippets() {
  const filteredSnippets = getFilteredSnippets();

  tableBody.innerHTML = '';
  emptyState.hidden = filteredSnippets.length > 0;

  filteredSnippets.forEach((snippet) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><span class="trigger"></span></td>
      <td class="collection-cell"></td>
      <td class="replacement"></td>
      <td>
        <div class="actions">
          <button class="icon-button active" type="button" title="Editar" aria-label="Editar">E</button>
          <button class="icon-button" type="button" title="Eliminar" aria-label="Eliminar">X</button>
        </div>
      </td>
    `;

    row.querySelector('.trigger').textContent = snippet.trigger;
    row.querySelector('.collection-cell').textContent = getCollectionName(snippet.collectionId);
    row.querySelector('.replacement').textContent = escapeNewlines(snippet.text);

    const [editButton, deleteButton] = row.querySelectorAll('button');

    editButton.addEventListener('click', () => {
      triggerInput.value = snippet.trigger;
      collectionSelect.value = snippet.collectionId || '';
      textInput.value = snippet.text;
      triggerInput.focus();
      setStatus('Snippet cargado para editar.');
    });

    deleteButton.addEventListener('click', async () => {
      const confirmed = window.confirm('¿Está seguro de que desea eliminar este Snippet?');

      if (!confirmed) {
        return;
      }

      snippets = await window.snippetsApi.delete(snippet.trigger);
      renderSnippets();
      setStatus(`Snippet ${snippet.trigger} eliminado.`);
    });

    tableBody.append(row);
  });
}

function renderCollections() {
  collectionsList.innerHTML = '';
  collectionsEmpty.hidden = collections.length > 0;

  collections.forEach((collection) => {
    const item = document.createElement('div');
    item.className = 'collection-card';
    item.innerHTML = `
      <div class="collection-header">
        <div>
          <p class="setting-title"></p>
          <p class="setting-copy"></p>
        </div>
        <label class="toggle" aria-label="Activar coleccion">
          <input type="checkbox">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="snippet-list"></div>
    `;

    const collectionSnippets = snippets.filter((snippet) => snippet.collectionId === collection.id);
    item.querySelector('.setting-title').textContent = collection.name;
    item.querySelector('.setting-copy').textContent = collection.enabled === false
      ? 'Coleccion desactivada'
      : 'Coleccion activa';

    const toggle = item.querySelector('input');
    toggle.checked = collection.enabled !== false;
    toggle.addEventListener('change', async () => {
      collections = await window.snippetsApi.updateCollection({
        ...collection,
        enabled: toggle.checked,
      });
      renderCollections();
      setStatus('Coleccion actualizada.');
    });

    const snippetList = item.querySelector('.snippet-list');

    if (collectionSnippets.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'snippet-empty';
      empty.textContent = 'No hay snippets en esta coleccion.';
      snippetList.append(empty);
    } else {
      collectionSnippets.forEach((snippet) => {
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

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const snippet = {
    trigger: triggerInput.value,
    collectionId: collectionSelect.value,
    text: textInput.value,
  };

  try {
    snippets = await window.snippetsApi.create(snippet);
    addForm.reset();
    renderSnippets();
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
    setStatus('Coleccion guardada.');
  } catch (error) {
    setStatus(error.message);
  }
});

searchInput.addEventListener('input', renderSnippets);

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
