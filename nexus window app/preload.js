const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    startServer: () => ipcRenderer.send('start-server'),
    restartServer: () => ipcRenderer.send('restart-server'),
    openApp: () => ipcRenderer.send('open-app'),
    
    onLog: (callback) => ipcRenderer.on('server-log', (event, msg) => callback(msg)),
    onError: (callback) => ipcRenderer.on('server-error', (event, msg) => callback(msg)),
    onServerStatus: (callback) => ipcRenderer.on('server-status', (event, status) => callback(status))
});
