/**
 * Generates the standalone ground station bundle and ZIP file
 */

import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

async function createBundle() {
  const zip = new JSZip();

  // 1. Read base HTML
  let html = fs.readFileSync('public/assets/aistudio/orbitrex-v2_c3a49f71.html', 'utf8');

  // Enhance HTML to support both native file:// double-click and live http:// server WebSocket
  const autoConnectCode = `
const autoWs = (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.host || 'localhost:3000');
const isHttpServer = location.protocol.startsWith('http');
const VER='1.0.0',DEF={mission:'ORBITREX Mission',desc:'ESP32-based CubeSat prototype',sat:'ORBITREX-01',start:'',interval:1000,timeout:10,range:300,retention:5000,theme:'dark',mode:isHttpServer?'hardware':'sim',ws:autoWs,`;

  html = html.replace(/const VER=.1\.0\.0.,DEF=\{mission:.ORBITREX Mission.,desc:.ESP32-based CubeSat prototype.,sat:.ORBITREX-01.,start:...,interval:1000,timeout:10,range:300,retention:5000,theme:.dark.,mode:.sim.,ws:...,/g, autoConnectCode);

  // Preload history if running on server
  const preloadCode = `
if (location.protocol.startsWith('http')) {
  fetch('/api/history?limit=50')
    .then(r => r.json())
    .then(res => {
      const pts = Array.isArray(res) ? res : (res && res.data);
      if (Array.isArray(pts) && pts.length > 0) {
        pts.forEach(p => ingest(p, 'HARDWARE'));
        render();
      }
    })
    .catch(() => {});
}
attInit();`;

  html = html.replace('attInit();', preloadCode);

  // Save standalone index.html
  fs.writeFileSync('public/standalone.html', html, 'utf8');

  // Read other assets
  const serverJs = fs.readFileSync('server.js', 'utf8');
  const arduinoCode = fs.readFileSync('arduino/ESP32_Bridge_Receiver.ino', 'utf8');

  const pkgJson = JSON.stringify({
    name: 'orbitrex-cubesat-groundstation',
    version: '1.0.0',
    description: 'ORBITREX CubeSat Real-time Telemetry Ground Station',
    main: 'server.js',
    scripts: {
      start: 'node server.js'
    },
    dependencies: {
      express: '^4.21.2',
      ws: '^8.18.0',
      serialport: '^12.0.0',
      '@serialport/parser-readline': '^12.0.0'
    }
  }, null, 2);

  const runBat = `@echo off
echo ========================================================
echo   ORBITREX CubeSat Ground Station Launcher (Windows)
echo ========================================================
echo.

if not exist node_modules (
  echo [1/3] First-time setup: Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Make sure Node.js is installed from https://nodejs.org
    pause
    exit /b
  )
)

echo [2/3] Opening Mission Control in default browser...
start http://localhost:3000

echo [3/3] Starting Ground Station Server (WebSocket + USB Serial)...
echo Press Ctrl+C in this window to stop the server.
echo.
node server.js
pause
`;

  const runSh = `#!/bin/bash
echo "========================================================"
echo "  ORBITREX CubeSat Ground Station Launcher (Mac/Linux)"
echo "========================================================"
echo ""

if [ ! -d "node_modules" ]; then
  echo "[1/3] First-time setup: Installing dependencies..."
  npm install
  if [ $? -ne 0 ]; then
    echo "[ERROR] npm install failed. Make sure Node.js is installed."
    exit 1
  fi
fi

echo "[2/3] Opening browser at http://localhost:3000..."
if which xdg-open > /dev/null; then
  xdg-open http://localhost:3000 &
elif which open > /dev/null; then
  open http://localhost:3000 &
fi

echo "[3/3] Starting Ground Station Server..."
node server.js
`;

  const readme = `================================================================================
ORBITREX CUBESAT GROUND STATION - SETUP & QUICK START GUIDE
================================================================================

IMPORTANT NOTE FOR WINDOWS USERS:
"Could not find the item" Error:
If you double-click files directly from inside the ZIP file without extracting,
Windows will show: "Could not find this item. This is no longer located in..."
To fix this:
  1. Right-click the downloaded ZIP file.
  2. Click "Extract All..." (or unzip with 7-Zip / WinRAR).
  3. Choose a destination folder (e.g. Desktop or Documents) and click Extract.
  4. Now open the extracted folder and follow the steps below!

--------------------------------------------------------------------------------
OPTION A: INSTANT OFFLINE RUN (No server or terminal needed)
--------------------------------------------------------------------------------
1. In the extracted folder, double-click "public/index.html".
2. It opens directly in Chrome, Edge, Safari, or Firefox with the complete
   interactive Mission Dashboard, 3D attitude cuboid model, and SVG charts!

--------------------------------------------------------------------------------
OPTION B: FULL HARDWARE GROUND STATION (With ESP32 USB Serial & WebSockets)
--------------------------------------------------------------------------------
Prerequisites:
  - Install Node.js (v18 or higher) from https://nodejs.org (LTS recommended)
  - Arduino IDE to flash your ESP32 boards

Step 1: Flash the 2nd ESP32 Bridge
  - Open "arduino/ESP32_Bridge_Receiver.ino" in Arduino IDE.
  - Connect your 2nd ESP32 to your computer via USB.
  - Flash the sketch and open Serial Monitor at 115200 baud.
  - Verify the printed MAC address matches the 'receiverMAC[]' on your CubeSat.

Step 2: Start the Ground Station Server
  - Windows: Double-click "run.bat"
  - Mac / Linux: Run chmod +x run.sh && ./run.sh
  - OR open your terminal in this folder and run:
      npm install
      node server.js

Step 3: Open Mission Control
  - Navigate to http://localhost:3000 in your browser.
  - The dashboard will connect via WebSocket automatically!

--------------------------------------------------------------------------------
API ENDPOINTS:
--------------------------------------------------------------------------------
  - GET  /api/status          Server uptime and connection status
  - GET  /api/history         Last 50 recorded telemetry packets
  - POST /api/telemetry       Ingest raw telemetry packet (JSON or CSV)
  - GET  /api/serial/ports    List available computer COM ports
================================================================================
`;

  // Add files to ZIP
  zip.file('server.js', serverJs);
  zip.file('package.json', pkgJson);
  zip.file('run.bat', runBat);
  zip.file('run.sh', runSh);
  zip.file('README.txt', readme);
  zip.file('public/index.html', html);
  zip.file('arduino/ESP32_Bridge_Receiver.ino', arduinoCode);

  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync('public/orbitrex-groundstation.zip', content);
  console.log(`[ZIP BUILD] Generated public/orbitrex-groundstation.zip (${content.length} bytes)`);
}

createBundle().catch(err => {
  console.error('Bundle build error:', err);
  process.exit(1);
});
