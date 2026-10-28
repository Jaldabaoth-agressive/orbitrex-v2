/**
 * Telemetry Data Types and Schemas
 * ORBITREX CubeSat Ground Station
 */

// Raw struct packet coming from ESP32 CubeSat transmitter
export interface SensorPacket {
  packetNo: number;
  temperature: number;
  humidity: number;

  ax: number;
  ay: number;
  az: number;
  totalAcc: number;

  gx: number;
  gy: number;
  gz: number;

  roll: number;
  pitch: number;

  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  satellites: number;
  gpsFix: number;

  // BMP280 telemetry
  bmpTemperature: number;
  pressure: number;
  bmpAltitude: number;
}

// Normalized packet format required by ORBITREX frontend
export interface OrbitrexTelemetryPacket {
  satellite_id: string;
  sequence_number: number;
  timestamp: string;
  status: string;
  source: 'HARDWARE' | 'SIMULATION';
  received_at?: string;

  // Primary parameters
  temperature_c: number;
  battery_voltage_v: number;
  humidity_percent: number;
  signal_strength_dbm: number;

  // IMU Acceleration
  acceleration_x: number;
  acceleration_y: number;
  acceleration_z: number;
  total_acc?: number;

  // IMU Gyroscope
  gyroscope_x: number;
  gyroscope_y: number;
  gyroscope_z: number;

  // Attitude & Navigation
  roll: number;
  pitch: number;
  yaw?: number;

  // GPS Telemetry
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  satellites: number;
  gpsFix: number;

  // BMP280 Barometer
  bmpTemperature: number;
  pressure: number;
  bmpAltitude: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
}

export interface ServerStatus {
  online: boolean;
  uptimeSeconds: number;
  connectedClients: number;
  simulationActive: boolean;
  packetsReceived: number;
  packetsSent: number;
  serialConnected: boolean;
  serialPort: string | null;
  baudRate: number;
  lastPacketTime: string | null;
  lastPacket: OrbitrexTelemetryPacket | null;
}
