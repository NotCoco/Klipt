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
const YT_DLP_DOWNLOAD_PATH = `${YT_DLP_PATH}.download`;
const YT_DLP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Download URL
const YT_DLP_URL = IS_WIN 
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 650,
    icon: path.join(__dirname, 'icon.png'), 
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f172a', symbolColor: '#ffffff' },
    show: true 
  });

  mainWindow.webContents.once('did-finish-load', () => {
    initDependencyCheck();
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- 1. SEAMLESS SETUP LOGIC ---

async function initDependencyCheck() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });

  try {
    const hasEngine = isUsableBinary(YT_DLP_PATH);
    if (!hasEngine) {
      await installYtDlp('Initializing engine...');
    } else if (isYtDlpStale()) {
      mainWindow.webContents.send('setup-status', { status: 'downloading', message: 'Updating engine...' });
      try {
        await installYtDlp('Updating engine...');
      } catch (err) {
        console.warn('Engine update failed; using cached yt-dlp:', err);
        mainWindow.webContents.send('log', {
          type: 'error',
          message: `Engine update failed, using cached yt-dlp: ${err.message}`
        });
      }
    }

    mainWindow.webContents.send('setup-status', { status: 'downloading', message: 'Verifying engine...' });
    await waitForBinaryReady(YT_DLP_PATH);
    mainWindow.webContents.send('setup-status', { status: 'ready', message: 'System Ready' });
  } catch (err) {
    mainWindow.webContents.send('setup-status', { status: 'error', message: `Engine setup failed: ${err.message}` });
  }
}

function isUsableBinary(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 0) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

function isYtDlpStale() {
  try {
    const stats = fs.statSync(YT_DLP_PATH);
    return Date.now() - stats.mtimeMs > YT_DLP_MAX_AGE_MS;
  } catch (e) {
    return true;
  }
}

async function installYtDlp(message) {
  mainWindow.webContents.send('setup-status', { status: 'downloading', message });
  cleanupTempFile(YT_DLP_DOWNLOAD_PATH);
  await downloadFile(YT_DLP_URL, YT_DLP_DOWNLOAD_PATH);
  if (!IS_WIN) fs.chmodSync(YT_DLP_DOWNLOAD_PATH, 0o755);
  replaceFile(YT_DLP_DOWNLOAD_PATH, YT_DLP_PATH);
}

function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn(`Could not remove temp file ${filePath}:`, e);
  }
}

function replaceFile(tempPath, finalPath) {
  const backupPath = `${finalPath}.bak`;
  if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

  const hadOriginal = fs.existsSync(finalPath);
  if (hadOriginal) fs.renameSync(finalPath, backupPath);

  try {
    fs.renameSync(tempPath, finalPath);
    if (hadOriginal) fs.unlinkSync(backupPath);
  } catch (err) {
    if (hadOriginal && !fs.existsSync(finalPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, finalPath);
    }
    throw err;
  }
}

function waitForBinaryReady(filePath, retries = 5) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const verify = () => {
      try {
        fs.renameSync(filePath, filePath);
        resolve();
      } catch (err) {
        attempts++;
        if (attempts > retries) {
          reject(new Error('Engine is still locked. Restart Klipt and try again.'));
          return;
        }
        setTimeout(verify, 1000);
      }
    };
    verify();
  });
}

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('Too many redirects while downloading engine.'));
      return;
    }

    let settled = false;
    const file = fs.createWriteStream(dest);
    const cleanupAndReject = (err) => {
      if (settled) return;
      settled = true;
      file.close(() => {
        fs.unlink(dest, () => reject(err));
      });
    };
    const finishDownload = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const request = https.get(url, (response) => {
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          cleanupAndReject(new Error('Engine download redirected without a location header.'));
          return;
        }
        file.close(() => {
          fs.unlink(dest, () => {});
          downloadFile(new URL(location, url).toString(), dest, redirects + 1).then(resolve, reject);
        });
        return;
      }

      if (status !== 200) {
        response.resume();
        cleanupAndReject(new Error(`Engine download failed with HTTP ${status}.`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close(finishDownload);
      });
    });

    request.on('error', cleanupAndReject);
    file.on('error', cleanupAndReject);
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

  const timeRegex = /^\d{2}:[0-5]\d:[0-5]\d$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      sender.send('log', { type: 'error', message: 'Invalid format. Use HH:MM:SS' });
      sender.send('process-finished', { success: false });
      return;
  }

  if (toSeconds(startTime) >= toSeconds(endTime)) {
      sender.send('log', { type: 'error', message: 'End time must be after Start time' });
      sender.send('process-finished', { success: false });
      return;
  }
  
  const safeName = (outputName || 'klipt_clip').replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || `klipt_clip_${Date.now()}`;
  const outputPath = path.join(app.getPath('downloads'), `${safeName}.mp4`);
  
  let fixedFfmpegPath = ffmpegPath;
  if (app.isPackaged) {
      fixedFfmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }

  const args = [
    url,
    '--no-playlist',
    '--newline',
    '--ffmpeg-location', fixedFfmpegPath,
    '--download-sections', `*${startTime}-${endTime}`,
    // --- Removed force-keyframes-at-cuts for Speed Optimization ---
    '-o', outputPath,
    '--force-overwrites',
    '-S', 'ext:mp4:m4a',
    '--remux-video', 'mp4'
  ];

  if (quality && quality !== 'best') {
      args.push('-f', `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}]/b`);
  }

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
