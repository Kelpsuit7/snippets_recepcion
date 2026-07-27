const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippetsApi', {
  list: () => ipcRenderer.invoke('snippets:list'),
  create: (snippet) => ipcRenderer.invoke('snippets:create', snippet),
  delete: (trigger) => ipcRenderer.invoke('snippets:delete', trigger),
  deleteAll: (confirmationText) => ipcRenderer.invoke('snippets:delete-all', confirmationText),
  importCsv: (payload) => ipcRenderer.invoke('snippets:import-csv', payload),
  exportCsv: () => ipcRenderer.invoke('snippets:export-csv'),
  listCollections: () => ipcRenderer.invoke('collections:list'),
  createCollection: (collection) => ipcRenderer.invoke('collections:create', collection),
  updateCollection: (collection) => ipcRenderer.invoke('collections:update', collection),
  deleteCollection: (payload) => ipcRenderer.invoke('collections:delete', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  exportDiagnostics: () => ipcRenderer.invoke('diagnostics:export'),
  updateCaretPosition: (position) => ipcRenderer.send('caret:update', position),
  onChanged: (callback) => {
    const listener = (_event, snippets) => callback(snippets);
    ipcRenderer.on('snippets:changed', listener);

    return () => {
      ipcRenderer.removeListener('snippets:changed', listener);
    };
  },
  onCollectionsChanged: (callback) => {
    const listener = (_event, collections) => callback(collections);
    ipcRenderer.on('collections:changed', listener);

    return () => {
      ipcRenderer.removeListener('collections:changed', listener);
    };
  },
  onListenerError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('snippets:listener-error', listener);

    return () => {
      ipcRenderer.removeListener('snippets:listener-error', listener);
    };
  },
});
