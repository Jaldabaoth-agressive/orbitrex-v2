/**
 * Telemetry Engine for ORBITREX Ground Station
 * Ingestion parsing, realistic orbital simulation, and in-memory circular history buffer.
 */

import { OrbitrexTelemetryPacket, SensorPacket } from './telemetry-types';

export class TelemetryEngine {
  private history: OrbitrexTelemetryPacket[] = [];
  private maxHistory: number = 1000;
  private seqCounter: number = 0;
  private packetsReceived: number = 0;
  private packetsBroadcast: number = 0;
  private lastPacketTime: string | null = null;
  private lastPacket: OrbitrexTelemetryPacket | null = null;

  // Realistic simulation state variables
  private simState = {
    seq: 0,
    startTime: Date.now(),
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
    lat: 28.572872, // Kennedy Space Center launch pad start
    lon: -80.648981,
    alt: 420.0, // meters
    speed: 7.2, // km/h
    satellites: 9,
    gpsFix: 1,
    bmpTemp: 24.2,
    pressure: 1013.25,
    bmpAlt: 420.0,
    rssi: -68,
    solarPhase: 0,
    orbitalAngle: 0,
  };

  constructor(maxHistory: number = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * Parse any incoming telemetry format (SensorPacket JSON, Orbitrex JSON, or CSV line)
   * and normalize it to the strict OrbitrexTelemetryPacket schema.
   */
  public normalizePacket(raw: any, source: 'HARDWARE' | 'SIMULATION' = 'HARDWARE'): OrbitrexTelemetryPacket {
    let p: any = raw;

    // Handle string inputs (JSON or CSV)
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        try {
          p = JSON.parse(trimmed);
        } catch {
          p = this.parseCsvLine(trimmed);
        }
      } else {
        p = this.parseCsvLine(trimmed);
      }
    }

    this.seqCounter++;
    const nowIso = new Date().toISOString();

    // Map struct field names (ax, ay, az, gx, gy, gz, packetNo, etc.) or existing fields
    const seq = Number.isInteger(p.sequence_number)
      ? p.sequence_number
      : Number.isInteger(p.packetNo)
      ? p.packetNo
      : this.seqCounter;

    const satId = typeof p.satellite_id === 'string' && p.satellite_id.length > 0
      ? p.satellite_id
      : 'ORBITREX-01';

    // Temperature resolution (DHT11 or BMP280 or direct)
    const tempC = this.safeNum(p.temperature_c ?? p.temperature ?? p.bmpTemperature, 24.5);
    const bmpTemp = this.safeNum(p.bmpTemperature ?? tempC, tempC);

    // Humidity resolution
    const hum = this.safeNum(p.humidity_percent ?? p.humidity, 45.0);

    // Accelerometer resolution
    const ax = this.safeNum(p.acceleration_x ?? p.ax, 0.0);
    const ay = this.safeNum(p.acceleration_y ?? p.ay, 0.0);
    const az = this.safeNum(p.acceleration_z ?? p.az, 9.81);
    const totalAcc = this.safeNum(p.totalAcc ?? p.total_acc, Math.sqrt(ax * ax + ay * ay + az * az));

    // Gyroscope resolution
    const gx = this.safeNum(p.gyroscope_x ?? p.gx, 0.0);
    const gy = this.safeNum(p.gyroscope_y ?? p.gy, 0.0);
    const gz = this.safeNum(p.gyroscope_z ?? p.gz, 0.0);

    // Attitude (roll, pitch)
    const roll = this.safeNum(p.roll, 0.0);
    const pitch = this.safeNum(p.pitch, 0.0);

    // BMP280 Barometer
    const pressure = this.safeNum(p.pressure, 1013.25);
    const bmpAlt = this.safeNum(p.bmpAltitude, 44330 * (1 - Math.pow(Math.max(10, pressure) / 1013.25, 0.1903)));

    // GPS
    const gpsFix = typeof p.gpsFix === 'number' ? p.gpsFix : (p.gpsFix ? 1 : (p.latitude ? 1 : 0));
    const lat = this.safeNum(p.latitude, 0.0);
    const lon = this.safeNum(p.longitude, 0.0);
    const alt = this.safeNum(p.altitude ?? bmpAlt, bmpAlt);
    const speed = this.safeNum(p.speed, 0.0);
    const sats = typeof p.satellites === 'number' ? p.satellites : (gpsFix ? 8 : 0);

    // Derived or mapped battery voltage
    // Single-cell Li-ion typically 3.5V - 4.2V
    let battV = this.safeNum(p.battery_voltage_v ?? p.battery_v ?? p.batt, NaN);
    if (isNaN(battV)) {
      // Synthesize realistic battery based on runtime if not wired to an ADC pin
      const drain = (this.seqCounter % 3600) * 0.0001;
      battV = Math.max(3.6, +(4.15 - drain).toFixed(3));
    }

    // Signal strength (RSSI)
    const rssi = this.safeNum(p.signal_strength_dbm ?? p.rssi, -68);

    const normalized: OrbitrexTelemetryPacket = {
      satellite_id: satId,
      sequence_number: seq,
      timestamp: typeof p.timestamp === 'string' && p.timestamp.endsWith('Z') ? p.timestamp : nowIso,
      received_at: nowIso,
      status: p.status || 'OK',
      source,
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

    return normalized;
  }

  /**
   * Parse CSV formatted line:
   * e.g., "PKT,packetNo,temp,humidity,ax,ay,az,totalAcc,gx,gy,gz,roll,pitch,lat,lon,alt,speed,satellites,gpsFix,bmpTemp,pressure,bmpAlt"
   */
  private parseCsvLine(line: string): Partial<SensorPacket> {
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

  private safeNum(val: any, fallback: number): number {
    if (typeof val === 'number' && !isNaN(val) && isFinite(val)) {
      return val;
    }
    if (typeof val === 'string') {
      const parsed = parseFloat(val);
      if (!isNaN(parsed) && isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  }

  /**
   * Save normalized packet to in-memory circular history buffer.
   */
  public recordPacket(packet: OrbitrexTelemetryPacket): void {
    this.history.push(packet);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    this.packetsReceived++;
    this.lastPacketTime = packet.timestamp;
    this.lastPacket = packet;
  }

  public incrementBroadcast(): void {
    this.packetsBroadcast++;
  }

  /**
   * Get the last N packets from history.
   */
  public getHistory(limit: number = 50): OrbitrexTelemetryPacket[] {
    const safeLimit = Math.max(1, Math.min(limit, this.history.length));
    return this.history.slice(-safeLimit);
  }

  public getAllHistory(): OrbitrexTelemetryPacket[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history = [];
  }

  public getStats() {
    return {
      historyCount: this.history.length,
      packetsReceived: this.packetsReceived,
      packetsBroadcast: this.packetsBroadcast,
      lastPacketTime: this.lastPacketTime,
      lastPacket: this.lastPacket,
    };
  }

  /**
   * Generate realistic simulated CubeSat telemetry.
   * Simulates:
   * - Orbital decay / altitude drop
   * - Battery discharge (4.2V -> 3.7V) with solar charge fluctuations
   * - Temperature swings (sunlight vs shadow)
   * - 3D attitude tumbling (roll & pitch integration from gyros)
   * - Realistic barometric pressure based on altitude
   * - GPS orbit path
   */
  public generateSimulatedStep(): OrbitrexTelemetryPacket {
    const s = this.simState;
    s.seq++;
    s.solarPhase += 0.05; // sinusoidal thermal cycle
    s.orbitalAngle += 0.008;

    // Battery drain model: gradual drain with slight fluctuation
    s.batteryV -= 0.0003;
    if (s.batteryV < 3.45) {
      s.batteryV = 4.2; // simulate recharge
    }
    const battNoise = (Math.random() - 0.5) * 0.006;
    const currentBatt = +(s.batteryV + battNoise).toFixed(3);

    // Temperature model: sinusoidal solar oscillation (-5°C to 38°C) + noise
    const solarTemp = 24.0 + 12.0 * Math.sin(s.solarPhase);
    s.temp += (solarTemp - s.temp) * 0.08 + (Math.random() - 0.5) * 0.3;
    s.bmpTemp = s.temp + (Math.random() - 0.5) * 0.2;

    // Humidity model: 30% - 60%
    s.humidity += (45.0 - s.humidity) * 0.05 + (Math.random() - 0.5) * 0.8;

    // Orbital decay / altitude model: starts at 420m (or sounding apex), slowly decays
    s.alt -= 0.15 + Math.random() * 0.05;
    if (s.alt < 50) s.alt = 450; // loop simulation
    s.bmpAlt = s.alt + (Math.random() - 0.5) * 0.8;

    // Barometric pressure computed from altitude: P = P0 * (1 - L*h/T0)^(g*M/(R*L))
    s.pressure = 1013.25 * Math.pow(1 - (0.0065 * s.bmpAlt) / 288.15, 5.255);

    // Attitude dynamics (slow tumble with gyroscopic damping)
    s.gx = +(s.gx * 0.95 + (Math.random() - 0.5) * 4.0).toFixed(2);
    s.gy = +(s.gy * 0.95 + (Math.random() - 0.5) * 4.0).toFixed(2);
    s.gz = +(s.gz * 0.95 + (Math.random() - 0.5) * 3.0).toFixed(2);

    s.roll = +(((s.roll + s.gx * 0.1 + 180) % 360) - 180).toFixed(2);
    s.pitch = +Math.max(-85, Math.min(85, s.pitch + s.gy * 0.1)).toFixed(2);

    // Accelerometer: 1G vertical + dynamic tumble components
    s.ax = +(Math.sin(s.roll * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
    s.ay = +(Math.sin(s.pitch * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
    s.az = +(Math.cos(s.pitch * (Math.PI / 180)) * 9.81 + (Math.random() - 0.5) * 0.2).toFixed(3);
    const totalAcc = Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az);

    // GPS ground track
    s.lat += Math.cos(s.orbitalAngle) * 0.0003;
    s.lon += Math.sin(s.orbitalAngle) * 0.0003;
    s.speed = +(14.5 + Math.random() * 2.0).toFixed(1);
    s.satellites = 10 + Math.round(Math.random() * 2);

    // Signal strength (RSSI)
    s.rssi = Math.round(-65 + (Math.random() - 0.5) * 6);

    const nowIso = new Date().toISOString();

    const simPacket: OrbitrexTelemetryPacket = {
      satellite_id: 'ORBITREX-01',
      sequence_number: s.seq,
      timestamp: nowIso,
      received_at: nowIso,
      status: 'OK',
      source: 'SIMULATION',
      temperature_c: +s.temp.toFixed(2),
      battery_voltage_v: currentBatt,
      humidity_percent: +s.humidity.toFixed(1),
      signal_strength_dbm: s.rssi,
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
      satellites: s.satellites,
      gpsFix: 1,
      bmpTemperature: +s.bmpTemp.toFixed(2),
      pressure: +s.pressure.toFixed(2),
      bmpAltitude: +s.bmpAlt.toFixed(1),
    };

    this.recordPacket(simPacket);
    return simPacket;
  }
}
