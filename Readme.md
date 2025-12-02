Klipt

The ultimate desktop media clipper.

Klipt is an Electron-based desktop utility designed for processing HLS streams and creating local archives. It serves as a GUI wrapper for yt-dlp and ffmpeg, providing a technical demonstration of child-process management, binary orchestration, and cross-platform desktop architecture.

Key Features

Precision Clipping: Frame-accurate start/end time processing.

Dynamic Engine Loading: Auto-detects and installs the latest binaries on the first run to ensure compatibility.

System Resilience: Implements "Wait-and-Retry" logic to handle Windows EBUSY filesystem locks during antivirus scans.

Format Interoperability: Forces MP4 containerization for universal playback compatibility, solving common WebM/Opus issues.

🛠 Technical Implementation

This project demonstrates several system-integration patterns suitable for modern desktop engineering:

1. Child Process Management

The application spawns independent processes for media handling to keep the main thread unblocked. It uses Node.js spawn to interface with the CLI backend.

// Example: Streaming terminal data to Renderer
proc.stdout.on('data', (d) => {
  const str = d.toString();
  sender.send('terminal-data', str);
});


2. Binary Handling in Production

To handle the "ASAR packing" limitation in Electron (where executables cannot run inside the archive), the app:

Detects the OS environment.

Checks for external binaries in userData.

Downloads dependencies dynamically if missing.

Points spawn to app.asar.unpacked for static assets like FFmpeg.

Setup & Development

Prerequisites: Node.js v16+

Install Dependencies

npm install


Run Locally

npm start


Build for Production (Windows/NSIS)

npm run dist


Stack

Core: Electron, Node.js

UI: HTML5, TailwindCSS

Engine: yt-dlp, FFmpeg-static

Disclaimer:
Klipt is a graphical interface intended for personal archiving and offline analysis. Users are responsible for ensuring compliance with the Terms of Service of the platforms they utilize.