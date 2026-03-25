const path = require('path');
const { BrowserWindow } = require('electron');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
    },
    fullscreenable: true,
    show: false,
  });

  win.loadFile(path.join(__dirname, '..', '..', 'index.html'));
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });
  return win;
}

module.exports = {
  createMainWindow,
};
