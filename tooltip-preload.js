const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tooltipApi', {
  onDetected: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('snippet:detected', listener);

    return () => {
      ipcRenderer.removeListener('snippet:detected', listener);
    };
  },
});
