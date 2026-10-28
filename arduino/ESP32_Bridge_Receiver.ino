/**
 * ============================================================================
 * ORBITREX CubeSat Ground Station - ESP-NOW to Serial Bridge Receiver
 * ============================================================================
 * Target Hardware: ESP32 DevKit V1 / NodeMCU-32S / ESP32-WROOM-32
 * Role: Receives telemetry packets transmitted from CubeSat via ESP-NOW,
 *       formats them into clean single-line JSON strings, and streams them
 *       over USB Serial to the Node.js Ground Station server.
 *
 * Baud Rate: 115200 bps
 * WiFi Channel: 1 (Must match Sender)
 * ============================================================================
 */

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define WIFI_CHANNEL 1
#define LED_PIN 2            // Built-in LED on most ESP32 Dev boards

// Must strictly match the sender's memory layout and byte packing
struct __attribute__((packed)) SensorPacket {
  uint32_t packetNo;
  float temperature;
  float humidity;

  float ax;
  float ay;
  float az;
  float totalAcc;

  float gx;
  float gy;
  float gz;

  float roll;
  float pitch;

  double latitude;
  double longitude;
  float altitude;
  float speed;
  uint32_t satellites;
  uint8_t gpsFix;

  // BMP280 telemetry
  float bmpTemperature;
  float pressure;
  float bmpAltitude;
};

// Global telemetry packet buffer
SensorPacket rxData;

// Performance metrics
volatile uint32_t totalPacketsReceived = 0;
volatile uint32_t lastPacketNumber = 0;
volatile uint32_t packetGaps = 0;
unsigned long lastRxTime = 0;

// LED toggle helper
void flashLed() {
  digitalWrite(LED_PIN, HIGH);
  delay(15);
  digitalWrite(LED_PIN, LOW);
}

// ---------------------------------------------------------------------------
// Print packet formatted as clean, single-line JSON for Node.js / SerialPort
// ---------------------------------------------------------------------------
void printPacketJson(const SensorPacket &pkt, int rssi = -65) {
  Serial.print("{\"packetNo\":");
  Serial.print(pkt.packetNo);

  Serial.print(",\"temperature\":");
  Serial.print(pkt.temperature, 2);

  Serial.print(",\"humidity\":");
  Serial.print(pkt.humidity, 2);

  Serial.print(",\"ax\":");
  Serial.print(pkt.ax, 3);
  Serial.print(",\"ay\":");
  Serial.print(pkt.ay, 3);
  Serial.print(",\"az\":");
  Serial.print(pkt.az, 3);
  Serial.print(",\"totalAcc\":");
  Serial.print(pkt.totalAcc, 3);

  Serial.print(",\"gx\":");
  Serial.print(pkt.gx, 2);
  Serial.print(",\"gy\":");
  Serial.print(pkt.gy, 2);
  Serial.print(",\"gz\":");
  Serial.print(pkt.gz, 2);

  Serial.print(",\"roll\":");
  Serial.print(pkt.roll, 2);
  Serial.print(",\"pitch\":");
  Serial.print(pkt.pitch, 2);

  Serial.print(",\"latitude\":");
  Serial.print(pkt.latitude, 6);
  Serial.print(",\"longitude\":");
  Serial.print(pkt.longitude, 6);
  Serial.print(",\"altitude\":");
  Serial.print(pkt.altitude, 2);
  Serial.print(",\"speed\":");
  Serial.print(pkt.speed, 2);
  Serial.print(",\"satellites\":");
  Serial.print(pkt.satellites);
  Serial.print(",\"gpsFix\":");
  Serial.print(pkt.gpsFix);

  Serial.print(",\"bmpTemperature\":");
  Serial.print(pkt.bmpTemperature, 2);
  Serial.print(",\"pressure\":");
  Serial.print(pkt.pressure, 2);
  Serial.print(",\"bmpAltitude\":");
  Serial.print(pkt.bmpAltitude, 2);

  Serial.print(",\"rssi\":");
  Serial.print(rssi);

  Serial.println("}");
}

// ---------------------------------------------------------------------------
// ESP-NOW Receive Callback (Supports ESP32 Core v2.x and v3.x)
// ---------------------------------------------------------------------------
#if defined(ESP_IDF_VERSION_MAJOR) && (ESP_IDF_VERSION_MAJOR >= 5)
void onDataReceive(const esp_now_recv_info_t *recv_info, const uint8_t *data, int len) {
  int rssi = recv_info->rx_ctrl->rssi;
#else
void onDataReceive(const uint8_t *mac, const uint8_t *data, int len) {
  int rssi = -60; // Estimated default if rx_ctrl is not exposed in v2
#endif

  if (len != sizeof(SensorPacket)) {
    Serial.print("{\"error\":\"PACKET_SIZE_MISMATCH\",\"expected\":");
    Serial.print(sizeof(SensorPacket));
    Serial.print(",\"received\":");
    Serial.print(len);
    Serial.println("}");
    return;
  }

  memcpy(&rxData, data, sizeof(SensorPacket));
  totalPacketsReceived++;
  lastRxTime = millis();

  // Sequence gap detection
  if (lastPacketNumber > 0 && rxData.packetNo > (lastPacketNumber + 1)) {
    packetGaps += (rxData.packetNo - lastPacketNumber - 1);
  }
  lastPacketNumber = rxData.packetNo;

  // Stream directly to USB Serial Monitor
  printPacketJson(rxData, rssi);

  // Quick activity flash
  flashLed();
}

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // High speed serial output to computer COM port
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=================================================");
  Serial.println("  ORBITREX CubeSat ESP-NOW to Serial Bridge      ");
  Serial.println("=================================================");

  // Set device as Wi-Fi Station
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  // Lock to same WiFi channel as transmitter
  esp_wifi_set_channel(WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);

  // Display this Bridge ESP32 MAC address
  String macStr = WiFi.macAddress();
  Serial.print("[INFO] Bridge Receiver MAC Address: ");
  Serial.println(macStr);
  Serial.println("[NOTE] Ensure transmitter's 'receiverMAC[]' matches above address!");

  // Initialize ESP-NOW
  if (esp_now_init() != ESP_OK) {
    Serial.println("{\"error\":\"ESP_NOW_INIT_FAILED\"}");
    while (1) {
      digitalWrite(LED_PIN, HIGH);
      delay(200);
      digitalWrite(LED_PIN, LOW);
      delay(200);
    }
  }

  // Register receive callback
  esp_now_register_recv_cb(onDataReceive);

  Serial.print("{\"status\":\"BRIDGE_ONLINE\",\"channel\":");
  Serial.print(WIFI_CHANNEL);
  Serial.print(",\"expectedBytes\":");
  Serial.print(sizeof(SensorPacket));
  Serial.println("}");

  // Double flash to indicate readiness
  flashLed();
  delay(100);
  flashLed();
}

void loop() {
  // Heartbeat check if no packets have arrived for 5 seconds
  if (millis() - lastRxTime > 5000 && lastRxTime > 0) {
    // Keep alive message every 5 seconds of silence
    Serial.println("{\"status\":\"WAITING_FOR_SATELLITE_PACKET\"}");
    lastRxTime = millis();
  }

  delay(10);
}
