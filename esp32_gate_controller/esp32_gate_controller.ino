#include <WiFi.h>
#include <PubSubClient.h>
#include "secrets.h"

// --- Configurações de Hardware ---
const int RELE_PINO = 4;

// Todas as credenciais de Wi-Fi e MQTT estão em "secrets.h":
// WIFI_SSID, WIFI_PASSWORD, MQTT_SERVER, MQTT_PORT,
// MQTT_USER, MQTT_PASSWORD, MQTT_TOPIC_COMMAND

// --- Controle de Tempo Não-Bloqueante ---
bool releAtivo = false;
unsigned long tempoInicioRele = 0;
const unsigned long TEMPO_DESLIGAR_MS = 5000; // 10 segundos em milissegundos

WiFiClient espClient;
PubSubClient client(espClient);

// Função chamada quando uma mensagem MQTT é recebida
void callback(char* topic, byte* payload, unsigned int length) {
  String mensagem = "";
  for (int i = 0; i < length; i++) {
    mensagem += (char)payload[i];
  }

  Serial.print("[MQTT] Mensagem recebida no topico '");
  Serial.print(topic);
  Serial.print("': ");
  Serial.println(mensagem);

  // Compara a mensagem recebida para acionar ou desligar o relé
  if (mensagem == "OPEM" || mensagem == "1") {
    digitalWrite(RELE_PINO, HIGH);
    releAtivo = true;
    tempoInicioRele = millis(); // Guarda o momento do acionamento
    Serial.println("[RELE] Estado: LIGADO / ABRIR");
  } else if (mensagem == "DESLIGAR" || mensagem == "0") {
    digitalWrite(RELE_PINO, LOW);
    releAtivo = false;
    Serial.println("[RELE] Estado: DESLIGADO / FECHAR");
  } else {
    Serial.println("[RELE] Comando desconhecido retido.");
  }
}

void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("[Wi-Fi] Conectando a rede: ");
  Serial.println(WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("[Wi-Fi] Conectado com sucesso!");
  Serial.print("[Wi-Fi] Endereco IP: ");
  Serial.println(WiFi.localIP());
}

void reconnect() {
  // Loop até reconectar ao Broker MQTT
  while (!client.connected()) {
    Serial.print("[MQTT] Tentando conectar ao Broker...");
    Serial.print(MQTT_SERVER);
    Serial.print(" como ");
    Serial.println(MQTT_USER);

    String clientId = "ESP32Client-";
    clientId += String(random(0xffff), HEX);

    if (client.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD)) {
      Serial.println(" Conectado!");

      // Inscreve-se no tópico assim que conecta
      client.subscribe(MQTT_TOPIC_COMMAND);
      Serial.print("[MQTT] Inscrito no topico: ");
      Serial.println(MQTT_TOPIC_COMMAND);
    } else {
      Serial.print(" Falhou, rc=");
      Serial.print(client.state());
      Serial.println(" Tentando novamente em 5 segundos...");
      delay(5000);
    }
  }
}

void setup() {
  // Inicializa a comunicação serial
  Serial.begin(115200);
  delay(100);

  Serial.println("\n--- Inicializando ESP32 ---");

  pinMode(RELE_PINO, OUTPUT);
  digitalWrite(RELE_PINO, LOW);  // Garante que inicia desligado

  setup_wifi();

  client.setServer(MQTT_SERVER, MQTT_PORT);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }

  client.loop();  // Mantém a conexão viva e processa mensagens recebidas

  // --- Verificação do Temporizador do Relé ---
  if (releAtivo && (millis() - tempoInicioRele >= TEMPO_DESLIGAR_MS)) {
    digitalWrite(RELE_PINO, LOW);
    releAtivo = false;
    Serial.println("[RELE] Tempo esgotado (10s). Desligado automaticamente.");
  }
}