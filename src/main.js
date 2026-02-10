const { app, BrowserWindow } = require('electron');
const path = require('path');

const { initDatabase } = require('./services/database');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // DevTools disabled - uncomment below line for debugging if needed
  // win.webContents.openDevTools();
}

app.whenReady().then(() => {
  console.log("App is ready, creating window...");
  initDatabase();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});