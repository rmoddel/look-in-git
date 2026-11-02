const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lookInGitDesktop', Object.freeze({
  version: process.versions.electron,
  chooseDirectory: () => ipcRenderer.invoke('look-in-git:select-directory'),
}));
