/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Radio,
  Satellite,
  Activity,
  Cpu,
  Layers,
  Terminal,
  Code2,
  Copy,
  Check,
  Play,
  Pause,
  RefreshCw,
  Database,
  Gauge,
  Compass,
  Send,
  Usb,
  ExternalLink,
  ShieldCheck,
  Zap,
  Globe,
  Sliders,
  FileCode2,
  HardDrive
} from 'lucide-react';
import { OrbitrexTelemetryPacket, ServerStatus } from './telemetry-types';
import { ARDUINO_BRIDGE_CODE, PACKAGE_JSON_CODE, HTML_MODIFICATION_EXPLANATION } from './embedded-code';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'hud' | 'serial' | 'arduino' | 'backend' | 'history'>('dashboard');
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<OrbitrexTelemetryPacket | null>(null);
  const [history, setHistory] = useState<OrbitrexTelemetryPacket[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [simulationActive, setSimulationActive] = useState<boolean>(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Serial Port state
  const [ports, setPorts] = useState<any[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>('COM3');
  const [baudRate, setBaudRate] = useState<number>(115200);
  const [serialConnected, setSerialConnected] = useState<boolean>(false);
  const [terminalLogs, setTerminalLogs] = useState<{ id: string; time: string; text: string; type: 'rx' | 'tx' | 'info' }[]>([]);
  const [customPayload, setCustomPayload] = useState<string>(
    JSON.stringify(
      {
        packetNo: 101,
        temperature: 24.8,
        humidity: 46.5,
        ax: 0.12,
        ay: -0.04,
        az: 9.82,
        totalAcc: 9.82,
        gx: 0.5,
        gy: -0.2,
        gz: 0.1,
        roll: 2.1,
        pitch: -1.8,
        latitude: 28.572872,
        longitude: -80.648981,
        altitude: 432.5,
        speed: 16.2,
        satellites: 11,
        gpsFix: 1,
        bmpTemperature: 24.6,
        pressure: 1012.8,
        bmpAltitude: 433.0
      },
      null,
      2
    )
  );
  const [injectResult, setInjectResult] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState<number>(1);
  const wsRef = useRef<WebSocket | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Helper for copy to clipboard
  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const addLog = (text: string, type: 'rx' | 'tx' | 'info' = 'info') => {
    const time = new Date().toISOString().slice(11, 19);
    setTerminalLogs((prev) => [...prev.slice(-150), { id: Math.random().toString(), time, text, type }]);
  };

  // Connect WebSocket to backend server
  useEffect(() => {
    let reconnectTimer: any = null;

    function initWebSocket() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;

      addLog(`Connecting to WebSocket at ${wsUrl}...`, 'info');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        addLog(`WebSocket connection established with Ground Station server`, 'info');
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);

          if (parsed.type === 'CONNECTION_ACK') {
            setSimulationActive(parsed.simulationActive);
            if (parsed.lastPacket) {
              setTelemetry(parsed.lastPacket);
            }
          } else if (parsed.type === 'SIMULATION_STATUS') {
            setSimulationActive(parsed.simulationActive);
          } else if (parsed.type === 'HISTORY_RESPONSE') {
            setHistory(parsed.data || []);
          } else if (parsed.satellite_id && parsed.sequence_number !== undefined) {
            // Live telemetry packet
            const pkt = parsed as OrbitrexTelemetryPacket;
            setTelemetry(pkt);
            setHistory((prev) => [...prev.slice(-99), pkt]);
            addLog(
              `[PKT #${pkt.sequence_number}] Temp:${pkt.temperature_c}°C Batt:${pkt.battery_voltage_v}V Alt:${pkt.altitude}m Fix:${pkt.gpsFix}`,
              'rx'
            );
          }
        } catch (e) {
          addLog(`Raw stream: ${event.data.slice(0, 100)}`, 'rx');
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        addLog(`WebSocket closed. Reconnecting in 3s...`, 'info');
        reconnectTimer = setTimeout(initWebSocket, 3000);
      };

      ws.onerror = (err) => {
        console.error('WS Error:', err);
      };
    }

    initWebSocket();

    // Fetch initial status and history
    fetchStatus();
    fetchHistory();
    fetchPorts();

    const statusInterval = setInterval(fetchStatus, 4000);

    return () => {
      clearTimeout(reconnectTimer);
      clearInterval(statusInterval);
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [terminalLogs]);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data: ServerStatus = await res.json();
        setServerStatus(data);
        setSimulationActive(data.simulationActive);
        setSerialConnected(data.serialConnected);
        if (data.serialPort) setSelectedPort(data.serialPort);
      }
    } catch {}
  };

  const fetchHistory = async () => {
    try {
      const res = await fetch('/api/history?limit=50');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setHistory(data);
        } else if (data.data) {
          setHistory(data.data);
        }
      }
    } catch {}
  };

  const fetchPorts = async () => {
    try {
      const res = await fetch('/api/serial/ports');
      if (res.ok) {
        const data = await res.json();
        if (data.ports && data.ports.length > 0) {
          setPorts(data.ports);
          if (!selectedPort && data.ports[0].path) {
            setSelectedPort(data.ports[0].path);
          }
        }
      }
    } catch {}
  };

  const toggleSimulation = async () => {
    const nextState = !simulationActive;
    try {
      const res = await fetch('/api/simulation/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextState })
      });
      if (res.ok) {
        setSimulationActive(nextState);
        addLog(`Simulation mode set to: ${nextState ? 'ACTIVE (1 Hz)' : 'PAUSED'}`, 'info');
      }
    } catch (e: any) {
      addLog(`Failed to toggle simulation: ${e.message}`, 'info');
    }
  };

  const handleConnectSerial = async () => {
    try {
      addLog(`Requesting serial connect to ${selectedPort} @ ${baudRate} baud...`, 'tx');
      const res = await fetch('/api/serial/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPort, baudRate })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSerialConnected(true);
        addLog(`Serial port ${selectedPort} opened successfully`, 'info');
      } else {
        addLog(`Serial port warning: ${data.details || data.error}`, 'info');
      }
      fetchStatus();
    } catch (e: any) {
      addLog(`Serial connect failed: ${e.message}`, 'info');
    }
  };

  const handleDisconnectSerial = async () => {
    try {
      const res = await fetch('/api/serial/disconnect', { method: 'POST' });
      if (res.ok) {
        setSerialConnected(false);
        addLog(`Serial port disconnected`, 'info');
      }
      fetchStatus();
    } catch (e: any) {
      addLog(`Disconnect failed: ${e.message}`, 'info');
    }
  };

  const handleInjectPayload = async () => {
    try {
      setInjectResult(null);
      const res = await fetch('/api/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: customPayload
      });
      const data = await res.json();
      if (res.ok) {
        setInjectResult(`✓ Packet #${data.packet?.sequence_number} ingested and broadcasted!`);
        addLog(`Manual telemetry injected via POST /api/telemetry`, 'tx');
      } else {
        setInjectResult(`Error: ${data.error}`);
      }
    } catch (e: any) {
      setInjectResult(`Request failed: ${e.message}`);
    }
  };

  // Standalone server.js code preview
  const serverJsSnippet = `/**
 * Standalone server.js for ORBITREX Ground Station
 * Node.js + Express + 'ws' + 'serialport'
 */
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const history = [];

function broadcast(packet) {
  const msg = JSON.stringify(packet);
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(msg));
}

// Ingestion endpoint (Ground radio software or scripts)
app.post('/api/telemetry', (req, res) => {
  const pkt = normalizePacket(req.body);
  history.push(pkt);
  if (history.length > 1000) history.shift();
  broadcast(pkt);
  res.json({ success: true, packet: pkt });
});

// Telemetry history endpoint
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(history.slice(-limit));
});

// SerialPort listener for ESP32 Bridge
const port = new SerialPort({ path: 'COM3', baudRate: 115200 });
const parser = port.pipe(new ReadlineParser({ delimiter: '\\r\\n' }));
parser.on('data', line => {
  try {
    const raw = JSON.parse(line.trim());
    const pkt = normalizePacket(raw);
    history.push(pkt);
    broadcast(pkt);
  } catch (err) {}
});

server.listen(3000, () => console.log('Ground Station listening on port 3000'));`;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#04080f] font-mono text-slate-200">
      {/* Sidebar Navigation */}
      <aside className="flex w-64 flex-col border-r border-[#1b3050] bg-[#0a1424]">
        {/* App Title */}
        <div className="flex items-center gap-3 border-b border-[#1b3050] p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-950/60 text-cyan-400 shadow-[0_0_15px_rgba(34,211,238,0.2)]">
            <Satellite className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-wider text-cyan-400">ORBITREX</h1>
            <p className="text-[11px] text-slate-400">CubeSat Ground Station</p>
          </div>
        </div>

        {/* Satellite Call Sign & Status */}
        <div className="border-b border-[#1b3050] bg-[#070e1b] p-3 text-[11px]">
          <div className="flex items-center justify-between text-slate-400">
            <span>SATELLITE</span>
            <span className="font-bold text-cyan-300">ORBITREX-01</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-slate-400">
            <span>LINK STREAM</span>
            <span className={`inline-flex items-center gap-1.5 font-semibold ${wsConnected ? 'text-emerald-400' : 'text-rose-400'}`}>
              <span className={`h-2 w-2 rounded-full ${wsConnected ? 'animate-pulse bg-emerald-400' : 'bg-rose-400'}`}></span>
              {wsConnected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-slate-400">
            <span>DATA SOURCE</span>
            <span className="rounded bg-cyan-950/80 px-1.5 py-0.5 text-[10px] text-cyan-300">
              {simulationActive ? 'SIMULATION (1 Hz)' : 'HARDWARE (ESP-NOW)'}
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex-1 space-y-1 p-2">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'dashboard'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Layers className="h-4 w-4 text-cyan-400" />
            <span>Mission Control Console</span>
          </button>

          <button
            onClick={() => setActiveTab('hud')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'hud'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Gauge className="h-4 w-4 text-cyan-400" />
            <span>Flight Director HUD</span>
          </button>

          <button
            onClick={() => setActiveTab('serial')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'serial'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Usb className="h-4 w-4 text-cyan-400" />
            <span>Serial Port & Ingestion</span>
          </button>

          <button
            onClick={() => setActiveTab('arduino')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'arduino'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Cpu className="h-4 w-4 text-cyan-400" />
            <span>ESP-NOW Bridge Code</span>
          </button>

          <button
            onClick={() => setActiveTab('backend')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'backend'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Code2 className="h-4 w-4 text-cyan-400" />
            <span>Node.js server.js Code</span>
          </button>

          <button
            onClick={() => setActiveTab('history')}
            className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-colors ${
              activeTab === 'history'
                ? 'border border-cyan-500/50 bg-[#0f1f38] font-bold text-cyan-400 shadow-sm'
                : 'text-slate-400 hover:bg-[#0f1f38]/50 hover:text-slate-200'
            }`}
          >
            <Database className="h-4 w-4 text-cyan-400" />
            <span>Telemetry History API</span>
          </button>
        </nav>

        {/* Ingestion & Simulation Controls */}
        <div className="border-t border-[#1b3050] bg-[#070e1b] p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] text-slate-400">SIMULATION MODE</span>
            <button
              onClick={toggleSimulation}
              className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold transition-colors ${
                simulationActive
                  ? 'border border-cyan-500/60 bg-cyan-950/80 text-cyan-300'
                  : 'border border-slate-700 bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {simulationActive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {simulationActive ? 'Running' : 'Paused'}
            </button>
          </div>
          <div className="text-[10px] text-slate-500">
            {simulationActive ? 'Generating 1 Hz orbital telemetry' : 'Waiting for ESP-NOW / serial telemetry'}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Status Header */}
        <header className="flex h-12 items-center justify-between border-b border-[#1b3050] bg-[#0a1424] px-4 text-xs">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-slate-400">
              <Activity className="h-4 w-4 text-cyan-400" />
              <span>PACKETS:</span>
              <span className="font-bold text-cyan-300">{serverStatus?.packetsReceived ?? history.length}</span>
            </div>

            <div className="h-4 w-px bg-slate-800"></div>

            <div className="flex items-center gap-2 text-slate-400">
              <Radio className="h-4 w-4 text-emerald-400" />
              <span>WS CLIENTS:</span>
              <span className="font-bold text-emerald-300">{serverStatus?.connectedClients ?? 1}</span>
            </div>

            <div className="h-4 w-px bg-slate-800"></div>

            <div className="flex items-center gap-2 text-slate-400">
              <Usb className="h-4 w-4 text-cyan-400" />
              <span>SERIAL:</span>
              <span className={`font-semibold ${serialConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                {serialConnected ? `ONLINE (${selectedPort})` : 'READY'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[11px] text-slate-400">
              LATEST: <span className="text-slate-200">{telemetry ? telemetry.timestamp.slice(11, 23) + 'Z' : 'WAITING'}</span>
            </span>

            <a
              href="/orbitrex"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-950/40 px-2.5 py-1 text-[11px] text-cyan-300 transition-colors hover:bg-cyan-900/60"
              title="Open full dashboard in standalone tab"
            >
              <span>Full Screen ORBITREX</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </header>

        {/* Tab Content */}
        <div className="flex-1 overflow-auto bg-[#04080f]">
          {/* TAB 1: EMBEDDED ORBITREX CONSOLE */}
          {activeTab === 'dashboard' && (
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-[#1b3050] bg-[#070e1b] px-4 py-2 text-xs">
                <div className="flex items-center gap-2 text-slate-400">
                  <span className="h-2 w-2 rounded-full bg-cyan-400"></span>
                  <span>Live Ground Station Console (pre-configured to WebSocket stream on port 3000)</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIframeKey((k) => k + 1)}
                    className="flex items-center gap-1 rounded border border-[#1b3050] bg-[#0a1424] px-2 py-1 text-[11px] text-slate-300 hover:text-cyan-400"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Reload Console</span>
                  </button>
                  <a
                    href="/orbitrex"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded border border-[#1b3050] bg-[#0a1424] px-2 py-1 text-[11px] text-cyan-400 hover:border-cyan-500"
                  >
                    <span>Open in New Tab</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              <div className="flex-1 bg-black">
                <iframe
                  key={iframeKey}
                  src="/orbitrex"
                  className="h-full w-full border-none"
                  title="ORBITREX Mission Control"
                />
              </div>
            </div>
          )}

          {/* TAB 2: FLIGHT DIRECTOR HUD */}
          {activeTab === 'hud' && (
            <div className="space-y-6 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-cyan-400">Flight Director HUD Telemetry</h2>
                  <p className="text-xs text-slate-400">Real-time parameters parsed from CubeSat SensorPacket struct</p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded border border-[#1b3050] bg-[#0a1424] px-2.5 py-1">
                    Packet #{telemetry?.sequence_number ?? 0}
                  </span>
                  <span className="rounded border border-[#1b3050] bg-[#0a1424] px-2.5 py-1 text-cyan-400">
                    Source: {telemetry?.source ?? 'OFFLINE'}
                  </span>
                </div>
              </div>

              {/* Grid of Telemetry Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                {/* 1. Temperature & Barometer */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 shadow">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>THERMAL (DHT11 / BMP280)</span>
                    <span className="text-cyan-400">°C</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold text-cyan-300">
                    {telemetry ? telemetry.temperature_c.toFixed(1) : '—'} <span className="text-sm font-normal text-slate-400">°C</span>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    BMP Temp: {telemetry?.bmpTemperature?.toFixed(1) ?? '—'} °C
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Humidity: {telemetry?.humidity_percent?.toFixed(1) ?? '—'} %
                  </div>
                </div>

                {/* 2. Barometric Pressure & Altitude */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 shadow">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>BAROMETRIC ALTITUDE</span>
                    <span className="text-cyan-400">BMP280</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold text-cyan-300">
                    {telemetry ? telemetry.bmpAltitude.toFixed(1) : '—'} <span className="text-sm font-normal text-slate-400">m</span>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    Pressure: {telemetry?.pressure?.toFixed(1) ?? '—'} hPa
                  </div>
                  <div className="text-[11px] text-slate-400">
                    GPS Alt: {telemetry?.altitude?.toFixed(1) ?? '—'} m
                  </div>
                </div>

                {/* 3. Battery Voltage & Signal */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 shadow">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>ELECTRICAL POWER</span>
                    <span className="text-emerald-400">Li-ion</span>
                  </div>
                  <div className="mt-2 text-2xl font-bold text-emerald-400">
                    {telemetry ? telemetry.battery_voltage_v.toFixed(3) : '—'} <span className="text-sm font-normal text-slate-400">V</span>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    RSSI: {telemetry?.signal_strength_dbm ?? '—'} dBm
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Status: <span className="text-emerald-400">{telemetry?.status ?? 'OK'}</span>
                  </div>
                </div>

                {/* 4. GPS Fix & Coordinates */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 shadow">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>GNSS POSITION (NEO-6M)</span>
                    <span className={telemetry?.gpsFix ? 'text-emerald-400' : 'text-amber-400'}>
                      {telemetry?.gpsFix ? '3D FIX' : 'NO FIX'}
                    </span>
                  </div>
                  <div className="mt-2 text-base font-bold text-cyan-300">
                    {telemetry?.latitude ? telemetry.latitude.toFixed(5) : '0.00000'}°, {telemetry?.longitude ? telemetry.longitude.toFixed(5) : '0.00000'}°
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">
                    Speed: {telemetry?.speed?.toFixed(1) ?? '0.0'} km/h
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Satellites: {telemetry?.satellites ?? 0} tracked
                  </div>
                </div>
              </div>

              {/* IMU & Attitude Row */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Attitude Gauges */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4">
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-cyan-400">Attitude & Orientation (MPU6500)</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded border border-[#1b3050] bg-[#070e1b] p-3 text-center">
                      <div className="text-xs text-slate-400">ROLL</div>
                      <div className="mt-1 text-2xl font-bold text-cyan-300">{telemetry?.roll?.toFixed(1) ?? '0.0'}°</div>
                      <div className="mt-2 text-[10px] text-slate-500">Gyro X: {telemetry?.gyroscope_x?.toFixed(1) ?? '0.0'} °/s</div>
                    </div>
                    <div className="rounded border border-[#1b3050] bg-[#070e1b] p-3 text-center">
                      <div className="text-xs text-slate-400">PITCH</div>
                      <div className="mt-1 text-2xl font-bold text-cyan-300">{telemetry?.pitch?.toFixed(1) ?? '0.0'}°</div>
                      <div className="mt-2 text-[10px] text-slate-500">Gyro Y: {telemetry?.gyroscope_y?.toFixed(1) ?? '0.0'} °/s</div>
                    </div>
                  </div>

                  <div className="mt-4 rounded border border-[#1b3050] bg-[#070e1b] p-3">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>3-AXIS ACCELEROMETER (g)</span>
                      <span>Total: {telemetry?.total_acc?.toFixed(2) ?? '1.00'} g</span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                      <div className="rounded bg-[#0a1424] p-1.5">
                        <span className="text-red-400">X:</span> {telemetry?.acceleration_x?.toFixed(3) ?? '0.000'}
                      </div>
                      <div className="rounded bg-[#0a1424] p-1.5">
                        <span className="text-green-400">Y:</span> {telemetry?.acceleration_y?.toFixed(3) ?? '0.000'}
                      </div>
                      <div className="rounded bg-[#0a1424] p-1.5">
                        <span className="text-blue-400">Z:</span> {telemetry?.acceleration_z?.toFixed(3) ?? '9.810'}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Subsystem Health Status */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4">
                  <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-cyan-400">Subsystem Health & Status</h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex items-center justify-between rounded border border-[#1b3050] bg-[#070e1b] p-2">
                      <span className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-emerald-400" />
                        <span>ESP-NOW Wireless Telemetry Link</span>
                      </span>
                      <span className="rounded bg-emerald-950 px-2 py-0.5 text-emerald-400">ACTIVE (CH 1)</span>
                    </div>

                    <div className="flex items-center justify-between rounded border border-[#1b3050] bg-[#070e1b] p-2">
                      <span className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-cyan-400" />
                        <span>MPU6500 6-DoF IMU (0x68)</span>
                      </span>
                      <span className="rounded bg-cyan-950 px-2 py-0.5 text-cyan-400">ONLINE</span>
                    </div>

                    <div className="flex items-center justify-between rounded border border-[#1b3050] bg-[#070e1b] p-2">
                      <span className="flex items-center gap-2">
                        <Activity className="h-4 w-4 text-cyan-400" />
                        <span>BMP280 Barometer & Thermometer</span>
                      </span>
                      <span className="rounded bg-cyan-950 px-2 py-0.5 text-cyan-400">CALIBRATED</span>
                    </div>

                    <div className="flex items-center justify-between rounded border border-[#1b3050] bg-[#070e1b] p-2">
                      <span className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-amber-400" />
                        <span>NEO-6M GPS Receiver (9600 baud)</span>
                      </span>
                      <span className={`rounded px-2 py-0.5 ${telemetry?.gpsFix ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'}`}>
                        {telemetry?.gpsFix ? 'LOCKED' : 'SEARCHING'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: SERIAL PORT & INGESTION LAB */}
          {activeTab === 'serial' && (
            <div className="space-y-6 p-6">
              <div>
                <h2 className="text-lg font-bold text-cyan-400">USB Serial Bridge & Radio Ingestion Lab</h2>
                <p className="text-xs text-slate-400">
                  Manage computer COM ports with serialport, inspect raw telemetry streams, or inject test packets.
                </p>
              </div>

              {/* Hardware Serial Port Connection Card */}
              <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4">
                <div className="flex items-center justify-between border-b border-[#1b3050] pb-3">
                  <div className="flex items-center gap-2">
                    <Usb className="h-5 w-5 text-cyan-400" />
                    <h3 className="text-sm font-bold text-slate-200">Hardware Serial Port (ESP32 Bridge Receiver)</h3>
                  </div>
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${serialConnected ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                    {serialConnected ? 'CONNECTED' : 'DISCONNECTED'}
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-4">
                  <div>
                    <label className="text-[11px] text-slate-400">SERIAL PORT</label>
                    <div className="mt-1 flex gap-2">
                      <input
                        type="text"
                        value={selectedPort}
                        onChange={(e) => setSelectedPort(e.target.value)}
                        placeholder="COM3 or /dev/ttyUSB0"
                        className="w-full rounded border border-[#1b3050] bg-[#070e1b] px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"
                      />
                      <button
                        onClick={fetchPorts}
                        title="Scan for available ports"
                        className="rounded border border-[#1b3050] bg-[#0f1f38] px-2 py-1 text-slate-300 hover:text-cyan-400"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-slate-400">BAUD RATE</label>
                    <select
                      value={baudRate}
                      onChange={(e) => setBaudRate(parseInt(e.target.value, 10))}
                      className="mt-1 w-full rounded border border-[#1b3050] bg-[#070e1b] px-3 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"
                    >
                      <option value="115200">115200 (ESP32 Bridge Default)</option>
                      <option value="9600">9600</option>
                      <option value="57600">57600</option>
                      <option value="230400">230400</option>
                    </select>
                  </div>

                  <div className="flex items-end">
                    {!serialConnected ? (
                      <button
                        onClick={handleConnectSerial}
                        className="flex w-full items-center justify-center gap-1.5 rounded border border-cyan-500/60 bg-cyan-950/80 px-4 py-1.5 text-xs font-semibold text-cyan-300 hover:bg-cyan-900"
                      >
                        <Usb className="h-4 w-4" />
                        <span>Open Port</span>
                      </button>
                    ) : (
                      <button
                        onClick={handleDisconnectSerial}
                        className="flex w-full items-center justify-center gap-1.5 rounded border border-rose-500/60 bg-rose-950/80 px-4 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-900"
                      >
                        <span>Disconnect Port</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-end">
                    <button
                      onClick={async () => {
                        const testLine = `{"packetNo":${Date.now() % 10000},"temperature":25.2,"humidity":47.0,"ax":0.01,"ay":0.02,"az":9.81,"totalAcc":9.81,"gx":0.1,"gy":-0.1,"gz":0.0,"roll":1.5,"pitch":-0.5,"latitude":28.5728,"longitude":-80.6489,"altitude":435.0,"speed":12.0,"satellites":10,"gpsFix":1,"bmpTemperature":25.0,"pressure":1012.5,"bmpAltitude":436.0}`;
                        await fetch('/api/serial/simulate-input', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ line: testLine })
                        });
                        addLog(`Simulated serial packet injected`, 'tx');
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded border border-[#1b3050] bg-[#0f1f38] px-4 py-1.5 text-xs text-slate-300 hover:border-cyan-500 hover:text-cyan-300"
                    >
                      <Zap className="h-4 w-4 text-amber-400" />
                      <span>Simulate Serial Line</span>
                    </button>
                  </div>
                </div>

                {ports.length > 0 && (
                  <div className="mt-3 text-[11px] text-slate-400">
                    Detected ports: {ports.map((p) => p.path).join(', ')}
                  </div>
                )}
              </div>

              {/* Ingestion API Tester & Live Terminal */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {/* Manual HTTP POST /api/telemetry Tester */}
                <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4">
                  <div className="flex items-center justify-between border-b border-[#1b3050] pb-2">
                    <span className="text-xs font-bold text-cyan-400">HTTP POST /api/telemetry Ingestion</span>
                    <button
                      onClick={handleInjectPayload}
                      className="flex items-center gap-1 rounded bg-cyan-600 px-3 py-1 text-xs font-bold text-white hover:bg-cyan-500"
                    >
                      <Send className="h-3 w-3" />
                      <span>POST Telemetry</span>
                    </button>
                  </div>

                  <p className="mt-2 text-[11px] text-slate-400">
                    Your ground radio software can POST incoming packets in raw JSON or CSV format directly to this endpoint.
                  </p>

                  <textarea
                    rows={12}
                    value={customPayload}
                    onChange={(e) => setCustomPayload(e.target.value)}
                    className="mt-3 w-full rounded border border-[#1b3050] bg-[#070e1b] p-3 font-mono text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"
                  />

                  {injectResult && (
                    <div className="mt-2 rounded bg-[#070e1b] p-2 text-xs text-cyan-300">
                      {injectResult}
                    </div>
                  )}
                </div>

                {/* Live Real-time Terminal Log */}
                <div className="flex flex-col rounded-lg border border-[#1b3050] bg-[#0a1424] p-4">
                  <div className="flex items-center justify-between border-b border-[#1b3050] pb-2">
                    <div className="flex items-center gap-2 text-xs font-bold text-cyan-400">
                      <Terminal className="h-4 w-4" />
                      <span>Live Ingestion & Serial Terminal</span>
                    </div>
                    <button
                      onClick={() => setTerminalLogs([])}
                      className="text-[11px] text-slate-400 hover:text-slate-200"
                    >
                      Clear
                    </button>
                  </div>

                  <div
                    ref={logContainerRef}
                    className="mt-3 h-[300px] flex-1 overflow-y-auto rounded border border-[#1b3050] bg-black p-3 font-mono text-[11px] leading-relaxed text-slate-300"
                  >
                    {terminalLogs.length === 0 ? (
                      <div className="text-slate-600">Waiting for incoming telemetry stream...</div>
                    ) : (
                      terminalLogs.map((log) => (
                        <div key={log.id} className="flex gap-2">
                          <span className="text-slate-500">[{log.time}]</span>
                          <span
                            className={
                              log.type === 'rx'
                                ? 'text-emerald-400'
                                : log.type === 'tx'
                                ? 'text-cyan-400'
                                : 'text-slate-400'
                            }
                          >
                            {log.text}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ARDUINO ESP-NOW BRIDGE CODE */}
          {activeTab === 'arduino' && (
            <div className="space-y-6 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-cyan-400">ESP-NOW to Serial Bridge Receiver (ESP32 #2)</h2>
                  <p className="text-xs text-slate-400">
                    Flash this firmware to your second ESP32 connected to your computer via USB cable.
                  </p>
                </div>
                <button
                  onClick={() => copyToClipboard(ARDUINO_BRIDGE_CODE, 'arduino')}
                  className="flex items-center gap-1.5 rounded border border-cyan-500/50 bg-cyan-950/80 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-900"
                >
                  {copiedKey === 'arduino' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                  <span>{copiedKey === 'arduino' ? 'Copied to Clipboard!' : 'Copy Arduino Code'}</span>
                </button>
              </div>

              {/* Instructions Callout */}
              <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 text-xs text-slate-300">
                <h3 className="font-bold text-cyan-300">Hardware & Firmware Configuration Steps:</h3>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-400">
                  <li>
                    Connect your <strong>Bridge ESP32</strong> to your PC/Mac with a micro-USB / USB-C data cable.
                  </li>
                  <li>Open Arduino IDE, select <strong>ESP32 Dev Module</strong> and the corresponding COM port.</li>
                  <li>
                    Paste the code below, compile and flash it. Open Serial Monitor at <strong>115200 baud</strong>.
                  </li>
                  <li>
                    Note the printed <strong>Bridge Receiver MAC Address</strong> in Serial Monitor. Ensure your
                    CubeSat transmitter's <code className="text-cyan-300">receiverMAC[]</code> array matches this address.
                  </li>
                  <li>
                    Both ESP32s must stay on <code className="text-cyan-300">WIFI_CHANNEL 1</code>.
                  </li>
                </ol>
              </div>

              {/* Code Display */}
              <div className="rounded-lg border border-[#1b3050] bg-black">
                <div className="flex items-center justify-between border-b border-[#1b3050] bg-[#0a1424] px-4 py-2 text-xs text-slate-400">
                  <span>ESP32_Bridge_Receiver.ino</span>
                  <span>115200 Baud · ESP-NOW Channel 1</span>
                </div>
                <pre className="max-h-[500px] overflow-auto p-4 text-xs text-cyan-300">
                  <code>{ARDUINO_BRIDGE_CODE}</code>
                </pre>
              </div>
            </div>
          )}

          {/* TAB 5: NODE.JS SERVER.JS CODE */}
          {activeTab === 'backend' && (
            <div className="space-y-6 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-cyan-400">Node.js Ground Station Backend (server.js)</h2>
                  <p className="text-xs text-slate-400">
                    Production Express + WebSocket (ws) + SerialPort ingestion server.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => copyToClipboard(PACKAGE_JSON_CODE, 'package')}
                    className="flex items-center gap-1.5 rounded border border-[#1b3050] bg-[#0f1f38] px-3 py-1.5 text-xs text-slate-300 hover:text-cyan-400"
                  >
                    {copiedKey === 'package' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    <span>Copy package.json</span>
                  </button>
                  <button
                    onClick={() => copyToClipboard(serverJsSnippet, 'server')}
                    className="flex items-center gap-1.5 rounded border border-cyan-500/50 bg-cyan-950/80 px-3 py-1.5 text-xs font-bold text-cyan-300 hover:bg-cyan-900"
                  >
                    {copiedKey === 'server' ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                    <span>{copiedKey === 'server' ? 'Copied server.js!' : 'Copy server.js'}</span>
                  </button>
                </div>
              </div>

              {/* Explanation of HTML Modification */}
              <div className="rounded-lg border border-[#1b3050] bg-[#0a1424] p-4 text-xs">
                <h3 className="font-bold text-cyan-300">How to Modify Your Existing HTML Code (3 Quick Steps)</h3>
                <div className="mt-2 space-y-2 text-slate-300">
                  <p>
                    Your HTML file already has an internal WebSocket client in <code className="text-cyan-300">hwStart()</code>.
                    To have it automatically connect on page load:
                  </p>
                  <div className="rounded bg-[#070e1b] p-3 font-mono text-[11px] text-slate-400">
                    <p className="text-slate-500">// Line 32 of your HTML:</p>
                    <p className="text-rose-400">- mode: 'sim', ws: ''</p>
                    <p className="text-emerald-400">
                      + const autoWs = (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.host || 'localhost:3000');
                    </p>
                    <p className="text-emerald-400">+ mode: 'hardware', ws: autoWs</p>
                  </div>
                  <p>
                    Then, to preload the historical records upon loading, call <code className="text-cyan-300">fetch('/api/history?limit=50')</code> and ingest them!
                  </p>
                </div>
              </div>

              {/* server.js code preview */}
              <div className="rounded-lg border border-[#1b3050] bg-black">
                <div className="flex items-center justify-between border-b border-[#1b3050] bg-[#0a1424] px-4 py-2 text-xs text-slate-400">
                  <span>server.js (Standalone Backend)</span>
                  <span>Node.js / Express / ws / serialport</span>
                </div>
                <pre className="max-h-[450px] overflow-auto p-4 text-xs text-slate-300">
                  <code>{serverJsSnippet}</code>
                </pre>
              </div>

              {/* package.json */}
              <div className="rounded-lg border border-[#1b3050] bg-black">
                <div className="flex items-center justify-between border-b border-[#1b3050] bg-[#0a1424] px-4 py-2 text-xs text-slate-400">
                  <span>package.json</span>
                  <span>Dependencies for Local Ground Station</span>
                </div>
                <pre className="overflow-auto p-4 text-xs text-amber-300">
                  <code>{PACKAGE_JSON_CODE}</code>
                </pre>
              </div>
            </div>
          )}

          {/* TAB 6: TELEMETRY HISTORY API & EXPORT */}
          {activeTab === 'history' && (
            <div className="space-y-6 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-cyan-400">Telemetry History API & Export</h2>
                  <p className="text-xs text-slate-400">
                    Inspect the in-memory circular buffer of received CubeSat telemetry points.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={fetchHistory}
                    className="flex items-center gap-1 rounded border border-[#1b3050] bg-[#0a1424] px-3 py-1.5 text-xs text-slate-300 hover:text-cyan-400"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>Refresh</span>
                  </button>
                  <button
                    onClick={() => {
                      const jsonStr = JSON.stringify(history, null, 2);
                      const blob = new Blob([jsonStr], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `cubesat-telemetry-${new Date().toISOString().slice(0, 19)}.json`;
                      a.click();
                    }}
                    className="flex items-center gap-1 rounded border border-cyan-500/50 bg-cyan-950 px-3 py-1.5 text-xs text-cyan-300 hover:bg-cyan-900"
                  >
                    <span>Export JSON</span>
                  </button>
                </div>
              </div>

              {/* Table of Historical Telemetry */}
              <div className="overflow-hidden rounded-lg border border-[#1b3050] bg-[#0a1424]">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[#1b3050] bg-[#070e1b] text-slate-400">
                      <tr>
                        <th className="p-3">SEQ #</th>
                        <th className="p-3">TIME (UTC)</th>
                        <th className="p-3">SOURCE</th>
                        <th className="p-3">TEMP (°C)</th>
                        <th className="p-3">BATT (V)</th>
                        <th className="p-3">ALT (m)</th>
                        <th className="p-3">PRESS (hPa)</th>
                        <th className="p-3">ROLL (°)</th>
                        <th className="p-3">PITCH (°)</th>
                        <th className="p-3">GPS FIX</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1b3050]/50 text-slate-300">
                      {history.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="p-6 text-center text-slate-500">
                            No telemetry packets recorded yet.
                          </td>
                        </tr>
                      ) : (
                        [...history].reverse().slice(0, 50).map((pkt) => (
                          <tr key={pkt.sequence_number + pkt.timestamp} className="hover:bg-[#0f1f38]/40">
                            <td className="p-3 font-bold text-cyan-300">#{pkt.sequence_number}</td>
                            <td className="p-3 text-slate-400">{pkt.timestamp.slice(11, 23)}Z</td>
                            <td className="p-3">
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] ${
                                  pkt.source === 'HARDWARE'
                                    ? 'bg-emerald-950 text-emerald-400'
                                    : 'bg-cyan-950 text-cyan-400'
                                }`}
                              >
                                {pkt.source}
                              </span>
                            </td>
                            <td className="p-3">{pkt.temperature_c.toFixed(1)}</td>
                            <td className="p-3 text-emerald-400">{pkt.battery_voltage_v.toFixed(3)}</td>
                            <td className="p-3">{pkt.altitude.toFixed(1)}</td>
                            <td className="p-3">{pkt.pressure.toFixed(1)}</td>
                            <td className="p-3">{pkt.roll.toFixed(1)}</td>
                            <td className="p-3">{pkt.pitch.toFixed(1)}</td>
                            <td className="p-3">
                              <span className={pkt.gpsFix ? 'text-emerald-400' : 'text-amber-400'}>
                                {pkt.gpsFix ? 'FIX' : 'NO FIX'}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
