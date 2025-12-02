const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const ffmpegPath = require('ffmpeg-static');

// --- CRASH PREVENTION ---
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (mainWindow && !mainWindow.isDestroyed()) {
     mainWindow.webContents.send('log', { 
       type: 'error', 
       message: `System Error: ${error.code === 'EBUSY' ? 'File locked by Antivirus. Please wait 5s and retry.' : error.message}` 
     });
     mainWindow.webContents.send('process-finished', { success: false });
  }
});

// Setup paths
const IS_WIN = process.platform === 'win32';
const BIN_DIR = path.join(app.getPath('userData'), 'bin');
const YT_DLP_FILENAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const YT_DLP_PATH = path.join(BIN_DIR, YT_DLP_FILENAME);

// Download URL
const YT_DLP_URL = IS_WIN 
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 650,
    // FIX: Tells the actual window/taskbar to use your icon
    icon: path.join(__dirname, 'icon.png'), 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f172a', symbolColor: '#ffffff' },
    show: true 
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    initDependencyCheck();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- 1. SEAMLESS SETUP LOGIC ---

async function initDependencyCheck() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  if (fs.existsSync(YT_DLP_PATH)) {
    const stats = fs.statSync(YT_DLP_PATH);
    if (stats.size > 0) {
        mainWindow.webContents.send('setup-status', { status: 'ready', message: 'System Ready' });
        return;
    }
  }

  mainWindow.webContents.send('setup-status', { status: 'downloading', message: 'Initializing Engine (First Run)...' });
  
  downloadFile(YT_DLP_URL, YT_DLP_PATH, (err) => {
    if (err) {
      mainWindow.webContents.send('setup-status', { status: 'error', message: 'Connection Failed.' });
    } else {
      if (!IS_WIN) fs.chmodSync(YT_DLP_PATH, 0o755);
      mainWindow.webContents.send('setup-status', { status: 'ready', message: 'Engine Installed' });
    }
  });
}

function downloadFile(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  const request = https.get(url, (response) => {
    if (response.statusCode === 302 || response.statusCode === 301) {
      downloadFile(response.headers.location, dest, cb);
      return;
    }
    response.pipe(file);
    
    file.on('finish', () => {
        setTimeout(cb, 1000); 
    });
  });
  
  request.on('error', (err) => {
    fs.unlink(dest, () => {});
    if (cb) cb(err);
  });
}

// --- 2. CLIPPING LOGIC ---

function toSeconds(str) {
    const [h, m, s] = str.split(':').map(Number);
    return (h * 3600) + (m * 60) + s;
}

ipcMain.on('start-clip', (event, data) => {
  const { url, startTime, endTime, outputName, quality } = data; 
  const sender = event.sender;

  // 1. Strict Regex
  const timeRegex = /^\d{2}:[0-5]\d:[0-5]\d$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      sender.send('log', { type: 'error', message: 'Invalid format. Use HH:MM:SS' });
      sender.send('process-finished', { success: false });
      return;
  }

  // 2. Logic Check
  if (toSeconds(startTime) >= toSeconds(endTime)) {
      sender.send('log', { type: 'error', message: 'End time must be after Start time' });
      sender.send('process-finished', { success: false });
      return;
  }
  
  const safeName = outputName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const outputPath = path.join(app.getPath('downloads'), `${safeName}.mp4`);
  
  let fixedFfmpegPath = ffmpegPath;
  if (app.isPackaged) {
      fixedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }

  // Build Arguments
  const args = [
    url,
    '--ffmpeg-location', fixedFfmpegPath,
    '--download-sections', `*${startTime}-${endTime}`,
    '-o', outputPath,
    '--force-overwrites',
    '-S', 'ext:mp4:m4a',
    '--remux-video', 'mp4'
  ];

  if (quality && quality !== 'best') {
      args.push('-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}]/b`);
  }

  // --- RETRY WRAPPER ---
  const executeDownload = (retryCount = 0) => {
      try {
          const proc = spawn(YT_DLP_PATH, args);

          proc.stdout.on('data', (d) => {
            const str = d.toString();
            const percent = str.match(/(\d{1,3}\.\d)%/);
            if (percent) sender.send('progress', percent[1]);
            sender.send('terminal-data', str);
          });

          proc.stderr.on('data', (d) => sender.send('terminal-data', d.toString()));

          proc.on('close', (code) => {
            if (code === 0) {
              sender.send('process-finished', { success: true, path: outputPath });
              shell.showItemInFolder(outputPath);
            } else {
              sender.send('process-finished', { success: false });
            }
          });
          
          proc.on('error', (err) => {
              console.error('Spawn Error:', err);
              
              if (err.code === 'EBUSY' && retryCount < 3) {
                  const waitTime = 2000; 
                  sender.send('terminal-data', `\n[System] Engine is locked (Antivirus). Retrying in ${waitTime/1000}s... (Attempt ${retryCount + 1}/3)\n`);
                  setTimeout(() => executeDownload(retryCount + 1), waitTime);
                  return;
              }

              let msg = `Spawn Error: ${err.message}`;
              sender.send('log', { type: 'error', message: msg });
              sender.send('process-finished', { success: false });
          });

      } catch (e) {
          console.error('Try-Catch Error:', e);
          sender.send('log', { type: 'error', message: `Critical Start Error: ${e.message}` });
          sender.send('process-finished', { success: false });
      }
  };

  executeDownload();
});