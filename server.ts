/**
 * ORBITREX CubeSat Ground Station Server
 * Node.js Express + WebSocket (ws) + SerialPort Telemetry Ingestion Engine
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { TelemetryEngine } from './src/telemetry-engine';
import { OrbitrexTelemetryPacket, ServerStatus } from './src/telemetry-types';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const startTime = Date.now();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Enable CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Telemetry engine instance
const telemetry = new TelemetryEngine(2000);

// Server state
let simulationActive = true; // Enabled by default so gauges show live orbital telemetry immediately
let simulationInterval: NodeJS.Timeout | null = null;
let serialPortInstance: any = null;
let currentSerialPort: string | null = null;
let currentBaudRate: number = 115200;
let lastHardwarePacketTime: number = 0;

// HTTP & WebSocket Servers
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Broadcast packet to all active WebSocket clients
 */
function broadcast(packet: OrbitrexTelemetryPacket) {
  const payload = JSON.stringify(packet);
  telemetry.incrementBroadcast();

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload);
      } catch (err) {
        console.error('[WS] Send error:', err);
      }
    }
  });
}

/**
 * Handle new telemetry packet from any source (HTTP POST, Serial, or Simulator)
 */
function handleIncomingTelemetry(raw: any, source: 'HARDWARE' | 'SIMULATION' = 'HARDWARE'): OrbitrexTelemetryPacket {
  if (source === 'HARDWARE') {
    lastHardwarePacketTime = Date.now();
  }
  const packet = telemetry.normalizePacket(raw, source);
  telemetry.recordPacket(packet);
  broadcast(packet);
  return packet;
}

/**
 * Simulation Mode Loop (1000ms cadence)
 */
function setSimulationMode(enabled: boolean) {
  simulationActive = enabled;
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }

  if (simulationActive) {
    console.log('[SIM] Realistic CubeSat orbital simulation started (1 Hz)');
    simulationInterval = setInterval(() => {
      // If hardware packets arrived within the last 3 seconds, skip simulation step
      if (Date.now() - lastHardwarePacketTime < 3000) {
        return;
      }
      const simPacket = telemetry.generateSimulatedStep();
      broadcast(simPacket);
    }, 1000);
  } else {
    console.log('[SIM] Simulation stopped');
  }
}

// Start simulation initially so frontend gauges have immediate data
setSimulationMode(true);

/**
 * WebSocket Connection Handler
 */
wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}. Total active: ${wss.clients.size}`);

  // Send server status and most recent packet on connect
  const stats = telemetry.getStats();
  const initMsg = {
    type: 'CONNECTION_ACK',
    status: 'CONNECTED',
    satellite_id: 'ORBITREX-01',
    simulationActive,
    serverUptime: Math.floor((Date.now() - startTime) / 1000),
    lastPacket: stats.lastPacket,
  };
  ws.send(JSON.stringify(initMsg));

  // If we already have a latest packet, send it immediately as valid telemetry
  if (stats.lastPacket) {
    ws.send(JSON.stringify(stats.lastPacket));
  }

  // Handle messages from frontend (control commands or bidirectional communication)
  ws.on('message', (message: string) => {
    try {
      const msgStr = message.toString();
      const parsed = JSON.parse(msgStr);

      if (parsed.type === 'TOGGLE_SIMULATION') {
        const targetState = parsed.enabled !== undefined ? !!parsed.enabled : !simulationActive;
        setSimulationMode(targetState);
        ws.send(JSON.stringify({ type: 'SIMULATION_STATUS', simulationActive }));
      } else if (parsed.type === 'GET_HISTORY') {
        const limit = parsed.limit || 50;
        ws.send(JSON.stringify({
          type: 'HISTORY_RESPONSE',
          data: telemetry.getHistory(limit),
        }));
      } else if (parsed.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', timestamp: new Date().toISOString() }));
      } else if (parsed.type === 'INJECT_PACKET' && parsed.packet) {
        handleIncomingTelemetry(parsed.packet, 'HARDWARE');
      }
    } catch {
      // If incoming message was a raw telemetry JSON object, ingest it
      try {
        handleIncomingTelemetry(message.toString(), 'HARDWARE');
      } catch (err) {
        console.warn('[WS] Unhandled message:', err);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Active clients: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err);
  });
});

/**
 * ============================================================================
 * REST API ENDPOINTS
 * ============================================================================
 */

// 1. Telemetry Ingestion (Data Input)
app.post('/api/telemetry', (req: Request, res: Response) => {
  try {
    const rawPayload = req.body;
    if (!rawPayload || (typeof rawPayload === 'object' && Object.keys(rawPayload).length === 0)) {
      return res.status(400).json({ error: 'Empty telemetry payload received' });
    }

    const packet = handleIncomingTelemetry(rawPayload, 'HARDWARE');
    return res.status(200).json({
      success: true,
      message: 'Telemetry ingested and broadcasted successfully',
      packet,
      connectedClients: wss.clients.size,
    });
  } catch (err: any) {
    console.error('[API] Ingestion error:', err);
    return res.status(500).json({ error: 'Failed to process telemetry payload', details: err.message });
  }
});

// 2. Telemetry History API (Data Output)
app.get('/api/history', (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '50', 10);
  const data = telemetry.getHistory(limit);

  // Return both array directly or structured object depending on format param
  if (req.query.format === 'raw' || req.query.format === 'array') {
    return res.json(data);
  }

  return res.json({
    totalRecords: data.length,
    requestedLimit: limit,
    satellite_id: 'ORBITREX-01',
    data,
  });
});

// 3. Server Status & Diagnostics
app.get('/api/status', (req: Request, res: Response) => {
  const stats = telemetry.getStats();
  const status: ServerStatus = {
    online: true,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    connectedClients: wss.clients.size,
    simulationActive,
    packetsReceived: stats.packetsReceived,
    packetsSent: stats.packetsBroadcast,
    serialConnected: !!serialPortInstance && serialPortInstance.isOpen,
    serialPort: currentSerialPort,
    baudRate: currentBaudRate,
    lastPacketTime: stats.lastPacketTime,
    lastPacket: stats.lastPacket,
  };
  return res.json(status);
});

// 4. Simulation Mode Toggle
app.post('/api/simulation/toggle', (req: Request, res: Response) => {
  const enable = req.body.enabled !== undefined ? !!req.body.enabled : !simulationActive;
  setSimulationMode(enable);
  return res.json({
    success: true,
    simulationActive,
    message: simulationActive ? 'Simulation mode active (1 Hz updates)' : 'Simulation mode disabled',
  });
});

// 5. Serial Port Management (List available hardware COM ports)
app.get('/api/serial/ports', async (req: Request, res: Response) => {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();
    return res.json({
      success: true,
      ports,
      currentPort: currentSerialPort,
      isOpen: !!serialPortInstance && serialPortInstance.isOpen,
    });
  } catch (err: any) {
    return res.json({
      success: true,
      ports: [],
      warning: 'Physical serialport detection unavailable or no ports detected',
      details: err.message,
    });
  }
});

// 6. Connect to Serial Port
app.post('/api/serial/connect', async (req: Request, res: Response) => {
  const { port, baudRate = 115200 } = req.body;
  if (!port) {
    return res.status(400).json({ error: 'Port path is required (e.g. COM3 or /dev/ttyUSB0)' });
  }

  try {
    const { SerialPort } = await import('serialport');
    const { ReadlineParser } = await import('@serialport/parser-readline');

    if (serialPortInstance && serialPortInstance.isOpen) {
      serialPortInstance.close();
    }

    currentSerialPort = port;
    currentBaudRate = parseInt(baudRate, 10);

    serialPortInstance = new SerialPort({
      path: port,
      baudRate: currentBaudRate,
      autoOpen: true,
    });

    const parser = serialPortInstance.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (line: string) => {
      const cleanLine = line.trim();
      if (!cleanLine) return;
      console.log(`[SERIAL RX] ${cleanLine}`);
      try {
        handleIncomingTelemetry(cleanLine, 'HARDWARE');
      } catch (err) {
        console.warn('[SERIAL] Failed to parse line:', cleanLine, err);
      }
    });

    serialPortInstance.on('open', () => {
      console.log(`[SERIAL] Connected to ${port} @ ${currentBaudRate} baud`);
    });

    serialPortInstance.on('error', (err: any) => {
      console.error('[SERIAL] Port error:', err);
    });

    return res.json({
      success: true,
      message: `Connecting to ${port} at ${currentBaudRate} baud`,
      port,
      baudRate: currentBaudRate,
    });
  } catch (err: any) {
    return res.status(500).json({
      error: 'Failed to open serial port',
      details: err.message,
    });
  }
});

// 7. Disconnect Serial Port
app.post('/api/serial/disconnect', (req: Request, res: Response) => {
  if (serialPortInstance && serialPortInstance.isOpen) {
    serialPortInstance.close();
    serialPortInstance = null;
    currentSerialPort = null;
    return res.json({ success: true, message: 'Serial port disconnected' });
  }
  return res.json({ success: true, message: 'No active serial port was open' });
});

// 8. Virtual Serial Test Line Injector (for web testing without hardware)
app.post('/api/serial/simulate-input', (req: Request, res: Response) => {
  const line = req.body.line || req.body;
  if (!line) {
    return res.status(400).json({ error: 'Missing line content' });
  }
  const packet = handleIncomingTelemetry(line, 'HARDWARE');
  return res.json({ success: true, packet });
});

// 9. Serve Arduino Bridge C++ Code
app.get('/api/arduino/code', (req: Request, res: Response) => {
  const filePath = path.join(process.cwd(), 'arduino', 'ESP32_Bridge_Receiver.ino');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain');
    return res.sendFile(filePath);
  }
  return res.status(404).json({ error: 'Arduino code file not found' });
});

// 9b. Serve Ground Station Standalone ZIP Bundle
app.get('/orbitrex-groundstation.zip', (req: Request, res: Response) => {
  const zipPath = path.join(process.cwd(), 'public', 'orbitrex-groundstation.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="orbitrex-groundstation.zip"');
    return res.sendFile(zipPath);
  }
  return res.status(404).json({ error: 'ZIP bundle not found' });
});

// 10. Serve the integrated ORBITREX Mission Control directly
app.get('/orbitrex', (req: Request, res: Response) => {
  const orbitrexPath = path.join(process.cwd(), 'public', 'orbitrex.html');
  if (fs.existsSync(orbitrexPath)) {
    return res.sendFile(orbitrexPath);
  }
  // Fallback to asset attachment if not yet created
  const assetPath = path.join(process.cwd(), 'public', 'assets', 'aistudio', 'orbitrex-v2_c3a49f71.html');
  return res.sendFile(assetPath);
});

/**
 * Start Express Server + Vite dev middleware
 */
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  server.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(`🚀 ORBITREX CubeSat Ground Station Server Active`);
    console.log(`📡 HTTP & WebSocket: http://${HOST}:${PORT}`);
    console.log(`📊 ORBITREX Dashboard: http://${HOST}:${PORT}/orbitrex`);
    console.log(`🛰️ Ingestion Endpoint: POST http://${HOST}:${PORT}/api/telemetry`);
    console.log(`🕒 History Endpoint:   GET  http://${HOST}:${PORT}/api/history`);
    console.log(`=======================================================`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
});
