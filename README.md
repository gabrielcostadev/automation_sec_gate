# ADM Gate Cam — Controle de Portão com Reconhecimento Facial

Sistema para **controlar abertura e fechamento do portão de recepção de uma casa ou edifício** usando câmeras de segurança, reconhecimento facial, Frigate NVR, MQTT, Node-RED e ESP32, com supervisão manual por um aplicativo de portaria em Python (PyQt6).

## 1. Visão geral

O sistema permite duas formas de abertura do portão:

1. **Automática:** câmera detecta uma pessoa → Frigate publica evento com reconhecimento facial → Node-RED valida se a pessoa é autorizada → publica comando MQTT → ESP32 aciona o relé do portão.
2. **Manual (portaria):** o porteiro vê o status em tempo real (`ABERTO` / `FECHADO`) no app desktop `main.py` e pode forçar `ABRIR` / `FECHAR`.

### Arquitetura

```
┌─────────────┐   RTSP    ┌──────────────┐  frigate/events  ┌───────────┐
│ Câmera IP / │ ────────► │ Frigate NVR  │ ───────────────► │ Mosquitto │
│ Webcam      │           │ + go2rtc     │   (MQTT Broker)  │  :1883    │
└─────────────┘           │ detecção +   │ ◄──────────────► │           │
                          │ rec. facial  │                  └─────┬─────┘
                          └──────────────┘                        │
                                                                  │ MQTT
                          ┌──────────────┐  building/gate/command  │
                          │  Node-RED    │ ◄───────────────────────┘
                          │  :1880       │ ──regras/automação──┐
                          │ (red-node)   │                     │
                          └──────────────┘                     ▼
                          ┌──────────────┐  building/gate/command  ┌────────────┐
                          │ App Portaria │ ──────────────────────► │ ESP32 +    │
                          │ main.py      │ ◄────────────────────── │ Relé GPIO4 │
                          │ PyQt6        │  building/gate/status   │ portão     │
                          └──────────────┘                         └────────────┘
```

Papéis:

| Componente | Pasta / arquivo | Função |
|---|---|---|
| **Frigate NVR** | `containers/frigate_nvr/` | Recebe RTSP das câmeras, roda detecção de objetos/pessoas e reconhecimento facial, publica em `frigate/events`. |
| **Mosquitto** | `containers/mosquitto/` | Broker MQTT central. Todo mundo fala via MQTT. Porta `1883` (MQTT) e `9001` (websocket). |
| **Node-RED** | `containers/red-node/` | Orquestrador. Assina `frigate/events`, decide se abre (pessoa autorizada), publica `building/gate/command` e mantém `building/gate/status` atualizado. |
| **ESP32** | `esp32_gate_controller/esp32_gate_controller.ino` | Atuador físico. Assina `building/gate/command` e liga/desliga o relé do portão (GPIO 4). |
| **App Portaria** | `main.py` (+ `dist/main.exe`) | Painel do porteiro: mostra status, log de reconhecimento facial, botões ABRIR/FECHAR manuais. |

## 2. Fluxo detalhado

### 2.1 Abertura automática por rosto

1. Câmera envia vídeo via RTSP para o Frigate (`rtsp://192.168.1.7:8554/webcam` → re-publicado via go2rtc em `rtsp://127.0.0.1:8554/minha_webcam`).
2. Frigate com `detect.enabled: true` detecta `person` e, com modelo de reconhecimento facial, preenche `after.label` + `before.sub_label[0]` com o nome da pessoa.
3. Frigate publica JSON em `frigate/events`, ex:
   ```json
   {"before": {"sub_label": ["gabriel"]}, "after": {"label": "person", "camera": "camera_do_netcam"}}
   ```
4. Node-RED (flow em `http://<servidor>:1880`) filtra: se `sub_label` está na lista de autorizados → publica `1` em `building/gate/command`. Caso contrário, só loga/ignora.
5. ESP32 recebe `1`, coloca `GPIO4 = HIGH` por 5 s (`TEMPO_DESLIGAR_MS = 5000`) e depois desliga sozinho — pulso suficiente para o automatizador do portão.
6. Node-RED (ou sensor/retorno do ESP32) publica `ABERTO`/`FECHADO` em `building/gate/status`.
7. App de portaria recebe o status e atualiza a tela + log: `Reconhecimento facial: 'person' detectado... Pessoa identificada: gabriel. Abertura automática via Node-RED.`

### 2.2 Abertura/fechamento manual

1. Porteiro clica em **🔓 ABRIR PORTÃO** ou **🔒 FECHAR PORTÃO** no app.
2. App publica `1` (abrir) ou `0` (fechar) com QoS 1 em `building/gate/command`.
3. ESP32 executa o comando da mesma forma que o automático.
4. App faz atualização otimista da tela e depois confirma quando chegar o `building/gate/status` real via MQTT.
5. Tudo fica registrado no painel `Eventos`.

### 2.3 Tópicos MQTT padrão

| Tópico | Direção | Payload | Quem usa |
|---|---|---|---|
| `building/gate/status` | Node-RED/ESP32 → App | `ABERTO` / `FECHADO` (aceita `OPEN`/`CLOSED`, `ON`/`OFF`, `1`/`0`, `true`/`false`, JSON `{"status":"open"}`) | Status oficial do portão |
| `building/gate/command` | App/Node-RED → ESP32 | `1` / `0` (o firmware atual também aceita `OPEM`* e `DESLIGAR`) | Comando do relé |
| `frigate/events` | Frigate → Node-RED/App | JSON Frigate `before`/`after` | Log de reconhecimento facial |

> *No `.ino` há um typo `OPEM` em vez de `OPEN`. O app usa `1`/`0`, então funciona normalmente, mas vale corrigir para `OPEN`.

Todos os tópicos são editáveis na tela **⚙ Configurações** do app e salvos via `QSettings` (`CasaPortao/AdmGateCam`).

## 3. Componentes em detalhe

### 3.1 `main.py` — App de portaria (PyQt6 + paho-mqtt)

- `MqttBridge(QObject)`: encapsula `paho.mqtt.client`, roda callbacks em thread do paho e repassa via `pyqtSignal` (`connected`, `disconnected`, `status_changed`, `log_message`). Interpreta status texto/JSON de forma tolerante e só loga eventos Frigate (não abre sozinho — a automação é do Node-RED).
- `ConfigDialog`: única tela com broker, porta, usuário/senha e os 3 tópicos. Salva e reconecta.
- `MainWindow`: painel com dot de conexão, banner grande `PORTÃO ABERTO` (verde) / `FECHADO` (vermelho) / `—` (cinza), `Último evento`, botões manuais, `Conectar/Desconectar`, `Limpar log` e `QTextEdit` de eventos. Conecta automaticamente ao abrir com a última config salva.
- Requisitos: Python `>=3.10`, `PyQt6>=6.6`, `paho-mqtt>=2.0` (ver `pyproject.toml`).
- Build Windows: `main.spec` (PyInstaller, `console=False`) gera `dist/main.exe` (+ pasta `build/`).

### 3.2 `containers/frigate_nvr/` — Frigate + go2rtc

- `docker-compose.yml`: imagem `ghcr.io/blakeblackshear/frigate:stable`, `privileged: true`, `shm_size: 512mb`, portas `8971` (UI), `5000`, `8554` (RTSP), `8555` (WebRTC), volumes `config.yml`, `media/`, `tmpfs /tmp/cache 1GB`. Prepara Coral USB/PCIe, GPU AMD/Intel e NPU Intel (ajustar `devices:` ao seu hardware).
- `config.yml`:
  ```yaml
  mqtt:
    enabled: true
    host: 192.168.1.200
  go2rtc:
    streams:
      minha_webcam:
        - rtsp://192.168.1.7:8554/webcam
  cameras:
    camera_do_netcam:
      inputs:
        - path: rtsp://127.0.0.1:8554/minha_webcam
          roles: [detect]
  ```
  Troque o IP da câmera, credenciais RTSP e `host` MQTT para o IP do seu servidor.

### 3.3 `containers/mosquitto/` — Broker MQTT

- `docker-compose.yml`: `eclipse-mosquitto:latest`, portas `1883:1883`, `9001:9001`, volumes `config/`, `data/`, `log/`, `restart: always`.
- `config/mosquitto.conf`:
  ```
  listener 1883 0.0.0.0
  allow_anonymous true
  persistence true
  ```
  `allow_anonymous true` é **só para testes locais**. Em produção, habilite usuário/senha e ACL.

### 3.4 `containers/red-node/` — Node-RED (automação)

- `docker-compose.yml`: `nodered/node-red:latest`, porta `1880:1880`, volume `./data:/data`, `TZ=America/Belem`, `restart: unless-stopped`.
- Lógica esperada (criar no editor `http://servidor:1880`):
  - `mqtt in frigate/events` → `function` (checa `msg.payload.after.label == "person"` e `before.sub_label[0]` autorizado) → `mqtt out building/gate/command` (`1`) + `mqtt out building/gate/status` (`ABERTO`) + `delay` + `mqtt out building/gate/status` (`FECHADO`).
  - `mqtt in building/gate/command` (manual do app) → espelha para `building/gate/status` se não houver retorno físico.
- O repositório só versiona o compose; os flows ficam em `containers/red-node/data/` (não versionado).

### 3.5 `esp32_gate_controller/esp32_gate_controller.ino` — Atuador

- Libs: `WiFi.h`, `PubSubClient.h`. Relé no `GPIO 4` (`RELE_PINO`).
- Config atual (alterar antes de gravar):
  ```cpp
  const char* ssid = "JESUS";
  const char* password = "I&G@2607";
  const char* mqtt_server = "192.168.1.200";
  const int mqtt_port = 1883;
  const char* mqtt_topic = "building/gate/command";
  ```
- `callback()`: `1`/`OPEM` → `HIGH` + timer; `0`/`DESLIGAR` → `LOW`. Desconhecido → ignora.
- `loop()`: auto-desliga após `TEMPO_DESLIGAR_MS = 5000` ms (o log diz 10 s, mas o código está 5 s). `reconnect()` reinscreve no tópico com `clientId` aleatório.

## 4. Como subir

### Pré-requisitos

- Docker + Docker Compose (para Frigate, Mosquitto, Node-RED) em um servidor na rede local (ex: `192.168.1.200`).
- Câmera IP com RTSP.
- ESP32 + módulo relé ligado ao automatizador do portão + Arduino IDE com libs `PubSubClient`.
- Python 3.10+ (só para rodar o app da portaria sem o `.exe`).

### Passo a passo

1. **Ajuste IPs/credenciais:**
   - `containers/frigate_nvr/config.yml` → `mqtt.host`, URL RTSP.
   - `esp32_gate_controller/esp32_gate_controller.ino` → `ssid`, `password`, `mqtt_server`.
   - `containers/mosquitto/config/mosquitto.conf` → crie usuário/senha se for para produção.

2. **Suba os containers:**
   ```bash
   cd containers/mosquitto && docker compose up -d
   cd ../red-node && docker compose up -d
   cd ../frigate_nvr && docker compose up -d
   ```
   - Frigate UI: `http://192.168.1.200:8971`
   - Node-RED: `http://192.168.1.200:1880`
   - Broker: `192.168.1.200:1883`

3. **Crie o flow no Node-RED** (seção 3.4) ligando `frigate/events` → filtro de autorizados → `building/gate/command`.

4. **Grave o ESP32:** abra o `.ino` no Arduino IDE, ajuste Wi-Fi/MQTT, selecione a placa `ESP32 Dev Module`, compile e uploade. Abra o Monitor Serial a 115200 para ver `[Wi-Fi]`, `[MQTT]` e `[RELE]`.

5. **Rode o app de portaria:**
   ```bash
   # com uv / pip
   pip install -e .
   python main.py
   # ou use o binário pronto
   ./dist/main.exe
   ```
   Abra **⚙ Configurações**, informe broker/porta/tópicos, `Salvar e conectar`. Teste **ABRIR** / **FECHAR** e observe o log de reconhecimento facial.

## 5. Estrutura do repositório

```
adm-gate-cam/
├── main.py                          # App PyQt6 da portaria (MQTT monitor + comando manual)
├── pyproject.toml                   # deps: PyQt6, paho-mqtt | python >=3.10
├── main.spec / build/ / dist/       # Build PyInstaller (dist/main.exe)
├── esp32_gate_controller/
│   └── esp32_gate_controller.ino    # Firmware ESP32 + relé GPIO4 via MQTT
└── containers/
    ├── frigate_nvr/
    │   ├── docker-compose.yml       # Frigate stable
    │   └── config.yml               # mqtt, go2rtc, cameras
    ├── mosquitto/
    │   ├── docker-compose.yml
    │   └── config/mosquitto.conf    # listener 1883, allow_anonymous true (dev)
    └── red-node/
        └── docker-compose.yml       # Node-RED :1880, TZ America/Belem
```

## 6. Limitações e próximos passos

- Credenciais Wi-Fi chapadas no `.ino` e `allow_anonymous true` no Mosquitto — migrar para secrets, usuário/senha MQTT e TLS.
- IPs fixos (`192.168.1.200`, `192.168.1.7`) — parametrizar via `.env` / DHCP reserva / DNS.
- Corrigir `OPEM` → `OPEN` e alinhar comentário de 10 s vs `5000` ms no firmware; publicar `building/gate/status` a partir do ESP32 para feedback real do portão.
- Versionar o flow do Node-RED (`flows.json`) e adicionar lista de pessoas autorizadas + trilha de auditoria.
- Adicionar autenticação na UI do Frigate (`5000` exposta sem auth) e retenção de vídeos em `media/`.

## 7. Troubleshooting rápido

| Sintoma | Onde olhar |
|---|---|
| App `Desconectado` | Broker no ar? `docker logs mosquitto-broker`, firewall porta 1883, IP/porta em ⚙ Configurações |
| Rosto detectado mas portão não abre | `frigate/events` chegando? Teste com MQTT Explorer; flow Node-RED com `sub_label` correto? ESP32 inscrito em `building/gate/command`? |
| ESP32 não conecta | SSID/senha, IP do broker, Monitor Serial 115200, `client.state()` no `reconnect()` |
| Vídeo não aparece no Frigate | URL RTSP válida (teste no VLC), `docker logs frigate`, `shm_size`, aceleração de hardware em `devices:` |
| Status travado em `—` | Ninguém publica `building/gate/status` — confira flow Node-RED e payloads aceitos em `MqttBridge._interpretar_status` |
