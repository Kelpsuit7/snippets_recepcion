const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snippetsApi', {
  list: () => ipcRenderer.invoke('snippets:list'),
  create: (snippet) => ipcRenderer.invoke('snippets:create', snippet),
  delete: (trigger) => ipcRenderer.invoke('snippets:delete', trigger),
  listCollections: () => ipcRenderer.invoke('collections:list'),
  createCollection: (collection) => ipcRenderer.invoke('collections:create', collection),
  updateCollection: (collection) => ipcRenderer.invoke('collections:update', collection),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
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
