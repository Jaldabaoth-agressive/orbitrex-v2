/**
 * ============================================================================
 * ORBITREX CubeSat Ground Station Backend Server (Standalone)
 * ============================================================================
 * Technologies:
 *  - Node.js + Express.js for REST API & Static Serving
 *  - 'ws' for High-Rate Real-Time Bi-Directional WebSocket Telemetry
 *  - 'serialport' for USB Serial Bridge communication with ESP32 Ground Node
 * ============================================================================
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// Optional SerialPort loading so server runs smoothly even before USB is plugged in
let SerialPort = null;
let ReadlineParser = null;
try {
  const sp = require('serialport');
  SerialPort = sp.SerialPort;
  const parser = require('@serialport/parser-readline');
  ReadlineParser = parser.ReadlineParser;
} catch (err) {
  console.log('[INFO] serialport module not globally loaded yet; run npm install serialport @serialport/parser-readline');
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_COM_PORT = process.env.SERIAL_PORT || null; // e.g., 'COM3' or '/dev/ttyUSB0'
const DEFAULT_BAUD_RATE = parseInt(process.env.BAUD_RATE || '115200', 10);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve frontend static files if placed in public directory
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ----------------------------------------------------------------------------
// In-Memory Telemetry Storage & State
// ----------------------------------------------------------------------------
const MAX_HISTORY = 1000;
const telemetryHistory = [];
let seqCounter = 0;
let simulationActive = true;
let simulationTimer = null;
let activeSerialInstance = null;
let lastHardwarePacketTime = 0;
const serverStartTime = Date.now();

const simState = {
  seq: 0,
  batteryV: 4.18,
  temp: 24.5,
  humidity: 48.0,
  ax: 0.05,
  ay: -0.02,
  az: 9.81,
  gx: 0.2,
  gy: -0.1,
  gz: 0.05,
  roll: 1.2,
  pitch: -2.5,
  lat: 28.572872,
  lon: -80.648981,
  alt: 420.0,
  speed: 7.2,
  satellites: 9,
  gpsFix: 1,
  bmpTemp: 24.2,
  pressure: 1013.25,
  bmpAlt: 420.0,
  solarPhase: 0,
};

// ----------------------------------------------------------------------------
// Telemetry Normalizer (Maps SensorPacket Struct / CSV / JSON to ORBITREX Format)
// ----------------------------------------------------------------------------
function normalizeTelemetry(raw, source = 'HARDWARE') {
  let p = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        p = JSON.parse(trimmed);
      } catch (e) {
        p = parseCsvLine(trimmed);
      }
    } else {
      p = parseCsvLine(trimmed);
    }
  }

  seqCounter++;
  const nowIso = new Date().toISOString();

  const seq = Number.isInteger(p.sequence_number)
    ? p.sequence_number
    : Number.isInteger(p.packetNo)
    ? p.packetNo
    : seqCounter;

  const tempC = safeNum(p.temperature_c ?? p.temperature ?? p.bmpTemperature, 24.5);
  const bmpTemp = safeNum(p.bmpTemperature ?? tempC, tempC);
  const hum = safeNum(p.humidity_percent ?? p.humidity, 45.0);

  const ax = safeNum(p.acceleration_x ?? p.ax, 0.0);
  const ay = safeNum(p.acceleration_y ?? p.ay, 0.0);
  const az = safeNum(p.acceleration_z ?? p.az, 9.81);
  const totalAcc = safeNum(p.totalAcc ?? p.total_acc, Math.sqrt(ax * ax + ay * ay + az * az));

  const gx = safeNum(p.gyroscope_x ?? p.gx, 0.0);
  const gy = safeNum(p.gyroscope_y ?? p.gy, 0.0);
  const gz = safeNum(p.gyroscope_z ?? p.gz, 0.0);

  const roll = safeNum(p.roll, 0.0);
  const pitch = safeNum(p.pitch, 0.0);

  const pressure = safeNum(p.pressure, 1013.25);
  const bmpAlt = safeNum(p.bmpAltitude, 44330 * (1 - Math.pow(Math.max(10, pressure) / 1013.25, 0.1903)));

  const gpsFix = typeof p.gpsFix === 'number' ? p.gpsFix : (p.gpsFix ? 1 : 0);
  const lat = safeNum(p.latitude, 0.0);
  const lon = safeNum(p.longitude, 0.0);
  const alt = safeNum(p.altitude ?? bmpAlt, bmpAlt);
  const speed = safeNum(p.speed, 0.0);
  const sats = typeof p.satellites === 'number' ? p.satellites : (gpsFix ? 8 : 0);

  let battV = safeNum(p.battery_voltage_v ?? p.battery_v ?? p.batt, NaN);
  if (isNaN(battV)) {
    battV = Math.max(3.6, +(4.15 - (seqCounter % 3600) * 0.0001).toFixed(3));
  }

  const rssi = safeNum(p.signal_strength_dbm ?? p.rssi, -68);

  const packet = {
    satellite_id: p.satellite_id || 'ORBITREX-01',
    sequence_number: seq,
    timestamp: typeof p.timestamp === 'string' && p.timestamp.endsWith('Z') ? p.timestamp : nowIso,
    received_at: nowIso,
    status: p.status || 'OK',
    source: source,
    temperature_c: +tempC.toFixed(2),
    battery_voltage_v: +battV.toFixed(3),
    humidity_percent: +hum.toFixed(1),
    signal_strength_dbm: Math.round(rssi),
    acceleration_x: +ax.toFixed(3),
    acceleration_y: +ay.toFixed(3),
    acceleration_z: +az.toFixed(3),
    total_acc: +totalAcc.toFixed(3),
    gyroscope_x: +gx.toFixed(2),
    gyroscope_y: +gy.toFixed(2),
    gyroscope_z: +gz.toFixed(2),
    roll: +roll.toFixed(2),
    pitch: +pitch.toFixed(2),
    latitude: +lat.toFixed(6),
    longitude: +lon.toFixed(6),
    altitude: +alt.toFixed(1),
    speed: +speed.toFixed(1),
    satellites: Math.round(sats),
    gpsFix: gpsFix ? 1 : 0,
    bmpTemperature: +bmpTemp.toFixed(2),
    pressure: +pressure.toFixed(2),
    bmpAltitude: +bmpAlt.toFixed(1),
  };

  return packet;
}

function parseCsvLine(line) {
  const clean = line.replace(/^(PKT:|DATA:|TELEMETRY:)/i, '').trim();
  const parts = clean.split(',').map((s) => s.trim());
  if (parts.length >= 8) {
    return {
      packetNo: parseInt(parts[0], 10) || 0,
      temperature: parseFloat(parts[1]) || 25,
      humidity: parseFloat(parts[2]) || 50,
      ax: parseFloat(parts[3]) || 0,
      ay: parseFloat(parts[4]) || 0,
      az: parseFloat(parts[5]) || 9.81,
      totalAcc: parseFloat(parts[6]) || 9.81,
      gx: parseFloat(parts[7]) || 0,
      gy: parseFloat(parts[8]) || 0,
      gz: parseFloat(parts[9]) || 0,
      roll: parseFloat(parts[10]) || 0,
      pitch: parseFloat(parts[11]) || 0,
      latitude: parseFloat(parts[12]) || 0,
      longitude: parseFloat(parts[13]) || 0,
      altitude: parseFloat(parts[14]) || 0,
      speed: parseFloat(parts[15]) || 0,
      satellites: parseInt(parts[16], 10) || 0,
      gpsFix: parseInt(parts[17], 10) || 0,
      bmpTemperature: parseFloat(parts[18]) || 25,
      pressure: parseFloat(parts[19]) || 1013.25,
      bmpAltitude: parseFloat(parts[20]) || 0,
    };
  }
  return {};
}

function safeNum(val, fallback) {
  if (typeof val === 'number' && !isNaN(val) && isFinite(val)) return val;
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && isFinite(parsed)) return parsed;
  }
  return fallback;
}

function recordPacket(packet) {
  telemetryHistory.push(packet);
  if (telemetryHistory.length > MAX_HISTORY) {
    telemetryHistory.shift();
  }
}

// ----------------------------------------------------------------------------
// HTTP & WebSocket Servers
// ----------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(packet) {
  const jsonStr = JSON.stringify(packet);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(jsonStr);
      } catch (e) {
        console.error('[WS] Send error:', e);
      }
    }
  });
}

function handleTelemetry(raw, source = 'HARDWARE') {
  if (source === 'HARDWARE') {
    lastHardwarePacketTime = Date.now();
  }
  const packet = normalizeTelemetry(raw, source);
  recordPacket(packet);
  broadcast(packet);
  return packet;
}

// ----------------------------------------------------------------------------
// Realistic Simulation Generator
// ----------------------------------------------------------------------------
function generateSimulatedPacket() {
  const s = simState;
  s.seq++;
  s.solarPhase += 0.05;

  s.batteryV -= 0.0003;
  if (s.batteryV < 3.45) s.batteryV = 4.2;
  const currentBatt = +(s.batteryV + (Math.random() - 0.5) * 0.006).toFixed(3);

  const solarTemp = 24.0 + 12.0 * Math.sin(s.solarPhase);
  s.temp += (solarTemp - s.temp) * 0.08 + (Math.random() - 0.5) * 0.3;
  s.bmpTemp = s.temp + (Math.random() - 0.5) * 0.2;
  s.humidity += (45.0 - s.humidity) * 0.05 + (Math.random() - 0.5) * 0.8;

  s.alt -= 0.15 + Math.random() * 0.05;
  if (s.alt < 50) s.alt = 450;
  s.bmpAlt = s.alt + (Math.random() - 0.5) * 0.8;
  s.pressure = 1013.25 * Math.pow(1 - (0.0065 * s.bmpAlt) / 288.15, 5.255);

  s.gx = +(s.gx * 0.95 + (Math.random() - 0.5) * 4.0).toFixed(2);
  s.gy = +(s.gy * 0.95 + (Math.random() - 0.5) * 4.0).toFixed(2);
  s.gz = +(s.gz * 0.95 + (Math.random() - 0.5) * 3.0).toFixed(2);

  s.roll = +(((s.roll + s.gx * 0.1 + 180) % 360) - 180).toFixed(2);
  s.pitch = +Math.max(-85, Math.min(85, s.pitch + s.gy * 0.1)).toFixed(2);

  s.ax = +(Math.sin(s.roll * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
  s.ay = +(Math.sin(s.pitch * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
  s.az = +(Math.cos(s.pitch * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
  const totalAcc = Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az);

  s.lat += Math.cos(s.seq * 0.01) * 0.0003;
  s.lon += Math.sin(s.seq * 0.01) * 0.0003;
  s.speed = +(14.5 + Math.random() * 2.0).toFixed(1);

  const nowIso = new Date().toISOString();

  const packet = {
    satellite_id: 'ORBITREX-01',
    sequence_number: s.seq,
    timestamp: nowIso,
    received_at: nowIso,
    status: 'OK',
    source: 'SIMULATION',
    temperature_c: +s.temp.toFixed(2),
    battery_voltage_v: currentBatt,
    humidity_percent: +s.humidity.toFixed(1),
    signal_strength_dbm: Math.round(-65 + (Math.random() - 0.5) * 6),
    acceleration_x: s.ax,
    acceleration_y: s.ay,
    acceleration_z: s.az,
    total_acc: +totalAcc.toFixed(3),
    gyroscope_x: s.gx,
    gyroscope_y: s.gy,
    gyroscope_z: s.gz,
    roll: s.roll,
    pitch: s.pitch,
    latitude: +s.lat.toFixed(6),
    longitude: +s.lon.toFixed(6),
    altitude: +s.alt.toFixed(1),
    speed: s.speed,
    satellites: 10,
    gpsFix: 1,
    bmpTemperature: +s.bmpTemp.toFixed(2),
    pressure: +s.pressure.toFixed(2),
    bmpAltitude: +s.bmpAlt.toFixed(1),
  };

  recordPacket(packet);
  return packet;
}

function setSimulationMode(enabled) {
  simulationActive = enabled;
  if (simulationTimer) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }
  if (simulationActive) {
    console.log('[SIM] Realistic simulation active (broadcasting at 1 Hz)');
    simulationTimer = setInterval(() => {
      if (Date.now() - lastHardwarePacketTime < 3000) return; // Yield to live hardware
      const packet = generateSimulatedPacket();
      broadcast(packet);
    }, 1000);
  } else {
    console.log('[SIM] Simulation stopped');
  }
}

// Start simulation initially
setSimulationMode(true);

// ----------------------------------------------------------------------------
// WebSocket Handler
// ----------------------------------------------------------------------------
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip} (Total: ${wss.clients.size})`);

  // Send initial handshake and latest packet
  const lastPkt = telemetryHistory[telemetryHistory.length - 1];
  ws.send(JSON.stringify({
    type: 'CONNECTION_ACK',
    satellite_id: 'ORBITREX-01',
    simulationActive,
    lastPacket: lastPkt || null,
  }));

  if (lastPkt) {
    ws.send(JSON.stringify(lastPkt));
  }

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'TOGGLE_SIMULATION') {
        setSimulationMode(parsed.enabled !== undefined ? !!parsed.enabled : !simulationActive);
        ws.send(JSON.stringify({ type: 'SIMULATION_STATUS', simulationActive }));
      } else if (parsed.type === 'GET_HISTORY') {
        const lim = parsed.limit || 50;
        ws.send(JSON.stringify({ type: 'HISTORY_RESPONSE', data: telemetryHistory.slice(-lim) }));
      } else if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', time: new Date().toISOString() }));
      }
    } catch {
      handleTelemetry(msg.toString(), 'HARDWARE');
    }
  });

  ws.on('close', () => console.log(`[WS] Client disconnected (Remaining: ${wss.clients.size})`));
});

// ----------------------------------------------------------------------------
// REST API Endpoints
// ----------------------------------------------------------------------------

// POST /api/telemetry - Radio ingestion endpoint
app.post('/api/telemetry', (req, res) => {
  try {
    const raw = req.body;
    if (!raw) return res.status(400).json({ error: 'Missing telemetry payload' });
    const packet = handleTelemetry(raw, 'HARDWARE');
    return res.status(200).json({ success: true, packet, clients: wss.clients.size });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/history - Return last 50 points
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  const data = telemetryHistory.slice(-Math.min(limit, telemetryHistory.length));
  if (req.query.format === 'array') return res.json(data);
  return res.json({ total: telemetryHistory.length, limit, data });
});

// GET /api/status - Server health & diagnostics
app.get('/api/status', (req, res) => {
  res.json({
    online: true,
    uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
    clients: wss.clients.size,
    simulationActive,
    totalHistory: telemetryHistory.length,
    serialConnected: !!activeSerialInstance && activeSerialInstance.isOpen,
    lastPacket: telemetryHistory[telemetryHistory.length - 1] || null,
  });
});

// POST /api/simulation/toggle
app.post('/api/simulation/toggle', (req, res) => {
  const enable = req.body.enabled !== undefined ? !!req.body.enabled : !simulationActive;
  setSimulationMode(enable);
  res.json({ success: true, simulationActive });
});

// GET /api/serial/ports
app.get('/api/serial/ports', async (req, res) => {
  if (!SerialPort) return res.json({ success: false, ports: [], error: 'SerialPort package not installed' });
  try {
    const ports = await SerialPort.list();
    res.json({ success: true, ports });
  } catch (e) {
    res.json({ success: false, ports: [], error: e.message });
  }
});

// POST /api/serial/connect
app.post('/api/serial/connect', async (req, res) => {
  const { port, baudRate = DEFAULT_BAUD_RATE } = req.body;
  if (!SerialPort || !ReadlineParser) {
    return res.status(500).json({ error: 'SerialPort module not installed. Run: npm install serialport @serialport/parser-readline' });
  }

  try {
    if (activeSerialInstance && activeSerialInstance.isOpen) {
      activeSerialInstance.close();
    }

    activeSerialInstance = new SerialPort({ path: port, baudRate: parseInt(baudRate, 10), autoOpen: true });
    const parser = activeSerialInstance.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (line) => {
      const clean = line.trim();
      if (!clean) return;
      console.log(`[SERIAL RX] ${clean}`);
      handleTelemetry(clean, 'HARDWARE');
    });

    activeSerialInstance.on('open', () => console.log(`[SERIAL] Port ${port} opened at ${baudRate} baud`));
    activeSerialInstance.on('error', (err) => console.error('[SERIAL] Error:', err.message));

    res.json({ success: true, message: `Connected to ${port}`, port, baudRate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------------------
// Auto-connect to SerialPort if environment variable set
// ----------------------------------------------------------------------------
if (DEFAULT_COM_PORT && SerialPort && ReadlineParser) {
  console.log(`[SERIAL] Attempting auto-connect to ${DEFAULT_COM_PORT}...`);
  try {
    activeSerialInstance = new SerialPort({ path: DEFAULT_COM_PORT, baudRate: DEFAULT_BAUD_RATE, autoOpen: true });
    const parser = activeSerialInstance.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    parser.on('data', (line) => handleTelemetry(line.trim(), 'HARDWARE'));
  } catch (e) {
    console.warn(`[SERIAL] Auto-connect failed:`, e.message);
  }
}

// ----------------------------------------------------------------------------
// Listen
// ----------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log('===============================================================');
  console.log(`🛰️  ORBITREX Ground Station Server listening on http://${HOST}:${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://${HOST}:${PORT}`);
  console.log(`📥 Telemetry Ingestion: POST http://${HOST}:${PORT}/api/telemetry`);
  console.log(`📜 History API:         GET  http://${HOST}:${PORT}/api/history`);
  console.log('===============================================================');
});
