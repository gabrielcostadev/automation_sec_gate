# ADM Gate Cam — Frontend Web da Portaria

Painel do porteiro no navegador: vídeo ao vivo do Frigate/go2rtc com caixas
de detecção (pessoa + placa), estado do portão via MQTT e abertura manual.

Sem build: HTML + CSS + JS puro. Só servir os arquivos estáticos.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Tela da portaria (vídeo, portão, pessoa, placa, logs, config) |
| `styles.css` | Tema escuro responsivo |
| `app.js` | MQTT (WebSocket) + vídeo go2rtc/MJPEG + overlay canvas |
| `index2-canva.html` | Protótipo antigo de overlay (referência) |

## Como rodar

```bash
cd web/frontend
# qualquer servidor estático, ex:
npx serve .
# ou
python -m http.server 8080
```

Abra `http://localhost:8080` e clique em **⚙ MQTT / Vídeo**.

> Abrir o `index.html` com duplo clique (`file://`) funciona para testar o
> layout e o modo **▶ Demo**, mas o vídeo/MQTT podem ser bloqueados por CORS
> ou política do navegador. Prefira servir via HTTP.

## Configuração

Tudo fica em `localStorage` (`admGateCam.config.v1`) e pode ser passado por URL:

```
index.html?broker=192.168.1.200&wsPort=9001&frigateHost=192.168.1.200&camera=camera_do_netcam&stream=minha_webcam
```

| Campo | Padrão | Onde |
|---|---|---|
| Broker MQTT | `192.168.1.200:9001` (WS) | Mosquitto |
| Tópico status | `building/gate/status` | `ABERTO`/`FECHADO` (`OPEN`/`1`… também valem) |
| Tópico comando | `building/gate/command` | publica `1` (abrir) / `0` (fechar) |
| Tópico Frigate | `frigate/events` (+ `frigate/events/#`) | JSON `before`/`after` |
| Frigate HTTP | `192.168.1.200:5000` | UI/API do Frigate |
| Câmera / stream | `camera_do_netcam` / `minha_webcam` | `config.yml` do Frigate + go2rtc |

Pré-requisito no broker (`containers/mosquitto/config/mosquitto.conf`):

```
listener 1883 0.0.0.0
listener 9001 0.0.0.0
protocol websockets
```

Recrie o container do Mosquitto após editar e libere a porta `9001`.

## Vídeo

- **MSE (go2rtc):** `http://<frigate>:5000/api/go2rtc/api/stream.mp4?src=<stream>`
- **MJPEG (Frigate):** `http://<frigate>:5000/api/<camera>/mjpeg`
- **Snapshot:** botão 📷 abre `http://<frigate>:5000/api/<camera>/latest.jpg`

## Overlay (pessoa + placa)

Assina `frigate/events` e desenha no `<canvas>` sobre o vídeo:

- `box = [x_min, y_min, x_max, y_max]` em pixels do frame de detecção
  (escalado para o canvas; valores 0–1 tratados como normalizados).
- `label == "person"` + `sub_label` = nome. Formatos aceitos:
  `["Nome", 0.9]`, `["Nome"]`, `"Nome"`.
- Nome na lista de autorizados → caixa **verde** + `✅ ACESSO LIBERADO`;
  senão → caixa **amarela** + `⚠️ NÃO IDENTIFICADO`.
- `label` em `license_plate/plate/placa` → caixa **ciano** com a placa.
- `car/automobile/vehicle/...` → caixa **azul**; se o carro trouxer
  `recognized_license_plate` (Frigate+) ou `sub_label` com cara de placa,
  a placa é exibida no cartão 🚗.
- Eventos `type: "end"` removem a caixa; sem atualização por 4 s a caixa expira.

## Portão

- Banner grande: **ABERTO** (verde) / **FECHADO** (vermelho) / **—** (cinza).
- `building/gate/status` aceita texto ou JSON (`{"status":"open"}` etc.).
- Botões **🔓 ABRIR** / **🔒 FECHAR** publicam `1`/`0` com QoS 1 e refletem
  otimistamente até o status real chegar.
- Fita `PORTÃO ABERTO` sobre o vídeo + som (desligável).

## Modo Demo

Sem broker/Frigate: botão **▶ Demo** simula pessoa autorizada, pessoa
desconhecida e placa a cada 4 s, incluindo abertura/fechamento do portão.
