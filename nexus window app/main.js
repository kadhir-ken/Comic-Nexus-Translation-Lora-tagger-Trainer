const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let launcherWindow;
let appWindow;
let serverProcess;

function createLauncherWindow() {
    launcherWindow = new BrowserWindow({
        width: 600,
        height: 500,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        title: 'Nexus Launcher'
    });

    launcherWindow.loadFile('index.html');
}

function startNodeServer() {
    if (serverProcess) {
        launcherWindow.webContents.send('server-log', 'Server is already running.');
        return;
    }

    const serverPath = path.resolve(__dirname, '..', 'comic-viewer', 'server.js');
    launcherWindow.webContents.send('server-log', `Starting node ${serverPath}...`);
    
    serverProcess = spawn('node', [serverPath], {
        cwd: path.dirname(serverPath)
    });

    serverProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) launcherWindow.webContents.send('server-log', msg);
        
        // If the server says it's running, open the app window
        if (msg.includes('Node Server running at') || msg.includes('http://localhost:3001')) {
            launcherWindow.webContents.send('server-status', 'running');
            openAppWindow();
        }
    });

    serverProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) launcherWindow.webContents.send('server-error', msg);
    });

    serverProcess.on('close', (code) => {
        launcherWindow.webContents.send('server-log', `Server exited with code ${code}`);
        serverProcess = null;
        launcherWindow.webContents.send('server-status', 'stopped');
        
        if (appWindow && !appWindow.isDestroyed()) {
            appWindow.close();
            appWindow = null;
        }
    });
}

function stopNodeServer() {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

function openAppWindow() {
    if (appWindow && !appWindow.isDestroyed()) {
        appWindow.focus();
        return;
    }

    appWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        autoHideMenuBar: true,
        title: 'Nexus Comic Viewer',
        webPreferences: {
            nodeIntegration: false
        }
    });

    appWindow.loadURL('http://localhost:3001');
    
    appWindow.on('closed', () => {
        appWindow = null;
    });
}

app.whenReady().then(() => {
    createLauncherWindow();
    
    // Automatically start the server on boot
    setTimeout(() => {
        startNodeServer();
    }, 500);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Ensure node server closes when app closes
app.on('before-quit', () => {
    stopNodeServer();
});

// IPC Handlers
ipcMain.on('start-server', () => {
    startNodeServer();
});

ipcMain.on('restart-server', () => {
    launcherWindow.webContents.send('server-log', 'Killing old server...');
    stopNodeServer();
    setTimeout(() => {
        startNodeServer();
    }, 1000); // Wait a second for port to free up
});

ipcMain.on('open-app', () => {
    openAppWindow();
});
