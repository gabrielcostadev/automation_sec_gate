"""Sistema de Controle de Abertura de Portão.

Fluxo previsto:
- Frigate NVR faz o reconhecimento facial e publica o evento.
- Node-RED / Mosquitto Broker roteiam o comando até o atuador do portão.
- Este app (portaria) monitora o status via MQTT e permite
  abertura/fechamento manual pelo porteiro.

Tópicos padrão (editáveis na tela de Configurações):
- Status do portão : building/gate/status   -> payload ABERTO/FECHADO (aceita OPEN/CLOSED, ON/OFF, 1/0, etc.)
- Comando manual   : building/gate/command  -> publica OPEN / CLOSE
- Eventos Frigate  : frigate/events       -> apenas log de reconhecimento facial
"""
import sys
import json
from datetime import datetime

import paho.mqtt.client as mqtt
from PyQt6.QtCore import QObject, pyqtSignal, QSettings, Qt
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QTextEdit, QLineEdit, QLabel, QDialog,
    QDialogButtonBox, QFormLayout, QMessageBox,
)


# ---------------------------------------------------------------------------
# Camada MQTT (thread-safe via signals)
# ---------------------------------------------------------------------------
class MqttBridge(QObject):
    connected = pyqtSignal()
    disconnected = pyqtSignal()
    status_changed = pyqtSignal(bool, str)   # (aberto?, origem)
    log_message = pyqtSignal(str)
    raw_message = pyqtSignal(str, str)       # (topico, payload)

    PAYLOADS_ABERTO = {"aberto", "abrir", "open", "opened", "on", "unlock",
                       "unlocked", "1", "true"}
    PAYLOADS_FECHADO = {"fechado", "fechar", "close", "closed", "off", "lock",
                        "locked", "0", "false"}

    def __init__(self):
        super().__init__()
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect
        self.topic_status = "building/gate/status"
        self.topic_frigate = "frigate/events"
        self._connected = False

    # -- conexão ----------------------------------------------------------
    def connect(self, broker, port, username=None, password=None,
                topic_status="building/gate/status",
                topic_command="building/gate/command",
                topic_frigate="frigate/events"):
        try:
            if self._connected:
                self.disconnect()
            self.topic_status = topic_status or self.topic_status
            self.topic_command = topic_command or self.topic_command
            self.topic_frigate = topic_frigate or self.topic_frigate
            if username and password:
                self.client.username_pw_set(username, password)
            else:
                # limpa credenciais antigas
                try:
                    self.client.username_pw_set("", "")
                except Exception:
                    pass
            self.client.connect(broker, port, 60)
            self.client.loop_start()
            return True
        except Exception as e:
            self.log_message.emit(f"[ERRO] Falha na conexão: {e}")
            return False

    def disconnect(self):
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass
        self._connected = False

    def is_connected(self):
        return self._connected and self.client.is_connected()

    def publish_command(self, topic_comando, payload):
        if not self.is_connected():
            self.log_message.emit("[ERRO] Conecte-se ao broker primeiro.")
            return False
        try:
            self.client.publish(topic_comando, payload, qos=1, retain=False)
            return True
        except Exception as e:
            self.log_message.emit(f"[ERRO] Falha ao publicar: {e}")
            return False

    # -- callbacks (rodam em thread do paho) ------------------------------
    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            self._connected = True
            # assina status + frigate
            try:
                client.subscribe(self.topic_status, qos=1)
                if self.topic_frigate:
                    client.subscribe(self.topic_frigate, qos=0)
            except Exception as e:
                self.log_message.emit(f"[ERRO] Falha ao subscrever: {e}")
            self.connected.emit()
            self.log_message.emit(
                f"[{datetime.now():%H:%M:%S}] Conectado. "
                f"Inscrito em: {self.topic_status}")
        else:
            self.log_message.emit(
                f"[ERRO] Broker recusou conexão (código {reason_code})")

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        self._connected = False
        self.disconnected.emit()
        self.log_message.emit(
            f"[{datetime.now():%H:%M:%S}] Desconectado (código {reason_code})")

    def _on_message(self, client, userdata, msg):
        try:
            payload_str = msg.payload.decode("utf-8", errors="replace").strip()
        except Exception:
            payload_str = ""
        self.raw_message.emit(msg.topic, payload_str)

        # 1) Status do portão -> atualiza tela
        if msg.topic == self.topic_status:
            estado = self._interpretar_status(payload_str)
            if estado is True:
                self.status_changed.emit(True, "mqtt")
                self.log_message.emit(
                    f"[{datetime.now():%H:%M:%S}] Portão ABERTO (via MQTT)")
            elif estado is False:
                self.status_changed.emit(False, "mqtt")
                self.log_message.emit(
                    f"[{datetime.now():%H:%M:%S}] Portão FECHADO (via MQTT)")
            else:
                self.log_message.emit(
                    f"[{datetime.now():%H:%M:%S}] Status desconhecido "
                    f"em {msg.topic}: {payload_str}")
            return

        # 2) Evento do Frigate (reconhecimento facial) -> só loga.
        #    A abertura automática em si é feita pelo Node-RED.
        if self.topic_frigate and msg.topic.startswith(
                self.topic_frigate.rstrip("#").rstrip("+").rstrip("/")):
            self._log_frigate(payload_str, msg.topic)
            return

    # -- helpers ----------------------------------------------------------
    @classmethod
    def _interpretar_status(cls, payload_str):
        """Retorna True=aberto, False=fechado, None=desconhecido."""
        texto = payload_str.strip().lower()
        # tenta JSON: {"status": "open"}, {"state": "on"}, {"open": true} ...
        if texto.startswith("{"):
            try:
                data = json.loads(payload_str)
                for chave in ("status", "state", "portao", "gate", "door"):
                    if chave in data:
                        texto = str(data[chave]).strip().lower()
                        break
                else:
                    # {"open": true} / {"aberto": 1}
                    for k, v in data.items():
                        if k.lower() in cls.PAYLOADS_ABERTO and v in (
                                True, 1, "1", "true", "on"):
                            return True
                        if k.lower() in cls.PAYLOADS_FECHADO and v in (
                                True, 1, "1", "true", "on"):
                            return False
            except json.JSONDecodeError:
                pass
        if texto in cls.PAYLOADS_ABERTO:
            return True
        if texto in cls.PAYLOADS_FECHADO:
            return False
        return None

    def _log_frigate(self, payload_str, topic):
        nome = None
        if payload_str.startswith("{"):
            try:
                data = json.loads(payload_str)
                # Frigate envia {"before": {...}, "after": {"label": "gabriel", ...}}
                after = data.get("after", data)
                nome = after.get("label") or data.get("label")
                before = data.get("before") or {}
                sub_label = before.get("sub_label") or []
                nome_person = sub_label[0] if sub_label else "--"
            except json.JSONDecodeError:
                pass
        if nome:
            self.log_message.emit(
                f"[{datetime.now():%H:%M:%S}] Reconhecimento facial: "
                f"'{nome}' detectado ({topic}) - Pessoa identificada: {nome_person}. "
                "Abertura automática via Node-RED.")
            # [20:01:54] Reconhecimento facial: 'person' detectado (frigate/events). Abertura automática via Node-RED.
        else:
            self.log_message.emit(
                f"[{datetime.now():%H:%M:%S}] Evento Frigate em {topic}: "
                f"{payload_str[:200]}")


# ---------------------------------------------------------------------------
# Dialog de configuração (único lugar com dados de conexão MQTT)
# ---------------------------------------------------------------------------
class ConfigDialog(QDialog):
    def __init__(self, parent, settings: QSettings):
        super().__init__(parent)
        self.setWindowTitle("Configurações — Conexão MQTT")
        self.setModal(True)

        self.broker_input = QLineEdit(
            settings.value("mqtt/broker", "localhost"))
        self.port_input = QLineEdit(
            str(settings.value("mqtt/port", "1883")))
        self.user_input = QLineEdit(
            settings.value("mqtt/username", ""))
        self.user_input.setPlaceholderText("Opcional")
        self.pass_input = QLineEdit(
            settings.value("mqtt/password", ""))
        self.pass_input.setPlaceholderText("Opcional")
        self.pass_input.setEchoMode(QLineEdit.EchoMode.Password)

        self.topic_status_input = QLineEdit(
            settings.value("mqtt/topic_status", "building/gate/status"))
        self.topic_cmd_input = QLineEdit(
            settings.value("mqtt/topic_command", "building/gate/command"))
        self.topic_frigate_input = QLineEdit(
            settings.value("mqtt/topic_frigate", "frigate/events"))

        form = QFormLayout()
        form.addRow("Broker:", self.broker_input)
        form.addRow("Porta:", self.port_input)
        form.addRow("Usuário:", self.user_input)
        form.addRow("Senha:", self.pass_input)
        form.addRow("Tópico status:", self.topic_status_input)
        form.addRow("Tópico comando:", self.topic_cmd_input)
        form.addRow("Tópico Frigate:", self.topic_frigate_input)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save |
            QDialogButtonBox.StandardButton.Cancel)
        buttons.button(
            QDialogButtonBox.StandardButton.Save).setText("Salvar e conectar")
        buttons.button(
            QDialogButtonBox.StandardButton.Cancel).setText("Cancelar")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel(
            "Preencha os dados do Mosquitto Broker.\n"
            "O Node-RED deve publicar o estado do portão no tópico de status."))
        layout.addLayout(form)
        layout.addWidget(buttons)

    def values(self):
        try:
            port = int(self.port_input.text().strip() or "1883")
        except ValueError:
            port = 1883
        return {
            "broker": self.broker_input.text().strip() or "localhost",
            "port": port,
            "username": self.user_input.text().strip() or None,
            "password": self.pass_input.text() or None,
            "topic_status": self.topic_status_input.text().strip()
            or "building/gate/status",
            "topic_command": self.topic_cmd_input.text().strip()
            or "building/gate/command",
            "topic_frigate": self.topic_frigate_input.text().strip()
            or "frigate/events",
        }


# ---------------------------------------------------------------------------
# Janela principal — portaria
# ---------------------------------------------------------------------------
class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Controle de Portão — Portaria")
        self.setGeometry(100, 100, 560, 620)

        self.settings = QSettings("CasaPortao", "AdmGateCam")
        self.mqtt = MqttBridge()
        self.mqtt.connected.connect(self._on_mqtt_connected)
        self.mqtt.disconnected.connect(self._on_mqtt_disconnected)
        self.mqtt.status_changed.connect(self._on_gate_status)
        self.mqtt.log_message.connect(self._append_log)

        self.gate_open = None  # None = desconhecido
        self._build_ui()
        self._apply_saved_config(silent=True)
        # tenta conectar automaticamente com a config salva
        self.connect_mqtt()

    # -- interface --------------------------------------------------------
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setSpacing(12)

        # barra superior: status conexão + botão config
        top = QHBoxLayout()
        self.conn_dot = QLabel("●")
        self.conn_dot.setStyleSheet(
            "font-size: 22px; color: gray;")
        self.conn_label = QLabel("Desconectado")
        top.addWidget(self.conn_dot)
        top.addWidget(self.conn_label)
        top.addStretch()
        self.config_btn = QPushButton("⚙ Configurações")
        self.config_btn.clicked.connect(self.open_config)
        top.addWidget(self.config_btn)
        layout.addLayout(top)

        # status grande do portão
        self.status_label = QLabel("PORTÃO\n—")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setStyleSheet(self._status_style("unknown"))
        self.status_label.setMinimumHeight(170)
        layout.addWidget(self.status_label)

        self.last_event_label = QLabel("Último evento: nenhum")
        layout.addWidget(self.last_event_label)

        # botões manuais do porteiro
        btn_row = QHBoxLayout()
        self.open_btn = QPushButton("🔓 ABRIR PORTÃO")
        self.open_btn.setMinimumHeight(60)
        self.open_btn.setStyleSheet(
            "font-size: 18px; font-weight: bold; "
            "background-color: #2e7d32; color: white; border-radius: 8px;")
        self.open_btn.clicked.connect(self.manual_open)
        self.close_btn = QPushButton("🔒 FECHAR PORTÃO")
        self.close_btn.setMinimumHeight(60)
        self.close_btn.setStyleSheet(
            "font-size: 18px; font-weight: bold; "
            "background-color: #455a64; color: white; border-radius: 8px;")
        self.close_btn.clicked.connect(self.manual_close)
        btn_row.addWidget(self.open_btn)
        btn_row.addWidget(self.close_btn)
        layout.addLayout(btn_row)

        # conectar / desconectar (sem expor campos de conexão aqui)
        conn_row = QHBoxLayout()
        self.connect_btn = QPushButton("Conectar")
        self.connect_btn.clicked.connect(self.toggle_connection)
        conn_row.addWidget(self.connect_btn)
        clear_btn = QPushButton("Limpar log")
        clear_btn.clicked.connect(lambda: self.log_view.clear())
        conn_row.addWidget(clear_btn)
        layout.addLayout(conn_row)

        layout.addWidget(QLabel("Eventos (reconhecimento facial + manual):"))
        self.log_view = QTextEdit()
        self.log_view.setReadOnly(True)
        layout.addWidget(self.log_view)

    @staticmethod
    def _status_style(state):
        base = ("font-size: 34px; font-weight: bold; border-radius: 12px; "
                "padding: 20px;")
        if state == "open":
            return base + "background-color: #2e7d32; color: white;"
        if state == "closed":
            return base + "background-color: #c62828; color: white;"
        return base + "background-color: #616161; color: white;"

    # -- config / conexão -------------------------------------------------
    def _apply_saved_config(self, silent=False):
        self.broker = self.settings.value("mqtt/broker", "localhost")
        try:
            self.port = int(self.settings.value("mqtt/port", "1883"))
        except (ValueError, TypeError):
            self.port = 1883
        self.username = self.settings.value("mqtt/username", "") or None
        self.password = self.settings.value("mqtt/password", "") or None
        self.topic_status = self.settings.value(
            "mqtt/topic_status", "building/gate/status")
        self.topic_command = self.settings.value(
            "mqtt/topic_command", "building/gate/command")
        self.topic_frigate = self.settings.value(
            "mqtt/topic_frigate", "frigate/events")

    def open_config(self):
        dlg = ConfigDialog(self, self.settings)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            vals = dlg.values()
            for k, v in vals.items():
                self.settings.setValue(f"mqtt/{k}", v if v is not None else "")
            self._apply_saved_config()
            self._append_log(
                f"[{datetime.now():%H:%M:%S}] Configuração salva. "
                "Reconectando...")
            self.connect_mqtt()

    def toggle_connection(self):
        if self.mqtt.is_connected():
            self.mqtt.disconnect()
        else:
            self.connect_mqtt()

    def connect_mqtt(self):
        ok = self.mqtt.connect(self.broker, self.port, self.username, self.password, 
                               self.topic_status, self.topic_command, self.topic_frigate)

        if not ok:
            QMessageBox.warning(
                self, "Conexão MQTT",
                "Não foi possível conectar. Verifique em ⚙ Configurações.")

    # -- slots MQTT -------------------------------------------------------
    def _on_mqtt_connected(self):
        self.conn_dot.setStyleSheet("font-size: 22px; color: green;")
        self.conn_label.setText(f"Conectado ({self.broker}:{self.port})")
        self.connect_btn.setText("Desconectar")

    def _on_mqtt_disconnected(self):
        self.conn_dot.setStyleSheet("font-size: 22px; color: gray;")
        self.conn_label.setText("Desconectado")
        self.connect_btn.setText("Conectar")

    def _on_gate_status(self, is_open, origem):
        self.gate_open = is_open
        if is_open:
            self.status_label.setText("PORTÃO\nABERTO")
            self.status_label.setStyleSheet(self._status_style("open"))
        else:
            self.status_label.setText("PORTÃO\nFECHADO")
            self.status_label.setStyleSheet(self._status_style("closed"))
        self.last_event_label.setText(
            f"Último evento: {'abertura' if is_open else 'fechamento'} "
            f"({origem}) em {datetime.now():%d/%m %H:%M:%S}")

    # -- ações manuais do porteiro ---------------------------------------
    def _send_command(self, payload, descricao):
        if self.mqtt.publish_command(self.topic_command, payload):
            self._append_log(
                f"[{datetime.now():%H:%M:%S}] {descricao} "
                f"enviado pelo porteiro -> {self.topic_command}: {payload}")
            # otimismo: reflete na tela até o status real chegar
            self._on_gate_status(payload == "1", "manual")
        else:
            QMessageBox.warning(
                self, "Portão",
                "Sem conexão com o broker. Verifique em ⚙ Configurações.")

    def manual_open(self):
        self._send_command("1", "Comando ABRIR")

    def manual_close(self):
        self._send_command("0", "Comando FECHAR")

    def _append_log(self, text):
        self.log_view.append(text)

    def closeEvent(self, event):
        self.mqtt.disconnect()
        super().closeEvent(event)


def main():
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
