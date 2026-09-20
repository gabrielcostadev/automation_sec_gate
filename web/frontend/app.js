/* ADM Gate Cam — Portaria
 * - Vídeo: go2rtc (MSE mp4) ou MJPEG do Frigate
 * - Overlay: canvas com boxes do frigate/events (box = [x_min,y_min,x_max,y_max] em px do frame de detecção)
 * - MQTT via WebSockets (mosquitto precisa de `listener 9001` + `protocol websockets`)
 * - Portão: building/gate/status (ABERTO/FECHADO) + building/gate/command (1/0)
 */
(function () {
  "use strict";

  var LS_KEY = "admGateCam.config.v1";
  var DEFAULTS = {
    broker: "192.168.1.200",
    wsPort: "443",
    username: "",
    password: "",
    topicStatus: "building/gate/status",
    topicCommand: "building/gate/command",
    topicFrigate: "frigate/events",
    extraTopics: "",
    frigateHost: "192.168.1.200",
    frigatePort: "5000",
    camera: "camera_do_netcam",
    stream: "minha_webcam",
    videoMode: "mse",
    authorized: "gabriel",
    beep: true,
  };

  var OPEN_WORDS = [
    "aberto",
    "abrir",
    "open",
    "opened",
    "on",
    "unlock",
    "unlocked",
    "1",
    "true",
  ];
  var CLOSED_WORDS = [
    "fechado",
    "fechar",
    "close",
    "closed",
    "off",
    "lock",
    "locked",
    "0",
    "false",
  ];
  var PLATE_LABELS = [
    "license_plate",
    "plate",
    "car_plate",
    "licence_plate",
    "placa",
  ];
  var CAR_LABELS = [
    "car",
    "automobile",
    "vehicle",
    "truck",
    "motorcycle",
    "bus",
    "carro",
  ];
  var OBJECT_TTL_MS = 4000;

  // ---------- estado ----------
  var cfg = loadConfig();
  var client = null;
  var gateOpen = null; // true | false | null
  var activeObjects = new Map(); // id -> {obj, lastSeen}
  var mqttSeen = 0;

  // ---------- dom ----------
  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {};
  [
    "mqttPill",
    "videoPill",
    "clock",
    "demoBtn",
    "configBtn",
    "camLabel",
    "video",
    "mjpeg",
    "overlay",
    "playerWrapper",
    "noSignal",
    "gateRibbon",
    "recDot",
    "frigateHost",
    "cameraInput",
    "streamInput",
    "modeSelect",
    "videoBtn",
    "snapBtn",
    "boxesToggle",
    "beepToggle",
    "videoStatus",
    "gateBanner",
    "gateSub",
    "openBtn",
    "closeBtn",
    "personCard",
    "avatar",
    "personName",
    "personMeta",
    "personConf",
    "accessVerdict",
    "unknownVerdict",
    "plateText",
    "plateMeta",
    "eventLog",
    "mqttLog",
    "mqttCount",
    "exportBtn",
    "clearBtn",
    "clearMqttBtn",
    "configDialog",
    "configForm",
    "cfgBroker",
    "cfgWsPort",
    "cfgUser",
    "cfgPass",
    "cfgTopicStatus",
    "cfgTopicCommand",
    "cfgTopicFrigate",
    "cfgExtra",
    "cfgFrigatePort",
    "cfgAuth",
    "saveConfigBtn",
    "toasts",
  ].forEach(function (id) {
    els[id] = $(id);
  });

  // ---------- utils ----------
  function now() {
    return new Date();
  }
  function hhmmss(d) {
    d = d || now();
    return (
      ("0" + d.getHours()).slice(-2) +
      ":" +
      ("0" + d.getMinutes()).slice(-2) +
      ":" +
      ("0" + d.getSeconds()).slice(-2)
    );
  }
  function loadConfig() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveConfig() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }
  function authorizedList() {
    return String(cfg.authorized || "")
      .split(/[,;\n]+/)
      .map(function (s) {
        return s.trim().toLowerCase();
      })
      .filter(Boolean);
  }
  function isAuthorized(name) {
    if (!name) return false;
    return authorizedList().indexOf(String(name).trim().toLowerCase()) !== -1;
  }
  function toast(msg, kind) {
    var div = document.createElement("div");
    div.className = "toast " + (kind || "");
    div.textContent = msg;
    els.toasts.appendChild(div);
    setTimeout(function () {
      div.remove();
    }, 6000);
  }
  function logEvent(html, cls) {
    var li = document.createElement("li");
    if (cls) li.className = cls;
    li.innerHTML = '<span class="t">[' + hhmmss() + "]</span>" + html;
    els.eventLog.prepend(li);
    while (els.eventLog.children.length > 300) els.eventLog.lastChild.remove();
  }
  function logMqtt(topic, payload) {
    mqttSeen++;
    els.mqttCount.textContent = "(" + mqttSeen + " msgs)";
    var li = document.createElement("li");
    var short = payload.length > 220 ? payload.slice(0, 220) + "…" : payload;
    li.textContent = "[" + hhmmss() + "] " + topic + " → " + short;
    els.mqttLog.prepend(li);
    while (els.mqttLog.children.length > 200) els.mqttLog.lastChild.remove();
  }
  function beep(freq, dur) {
    if (!cfg.beep && !els.beepToggle.checked) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var o = ctx.createOscillator(),
        g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.frequency.value = freq || 880;
      o.type = "sine";
      g.gain.value = 0.12;
      o.start();
      setTimeout(function () {
        o.stop();
        ctx.close();
      }, dur || 350);
    } catch (e) {}
  }

  // ---------- relógio ----------
  setInterval(function () {
    els.clock.textContent = hhmmss();
  }, 1000);

  // ---------- portão ----------
  function interpretGateStatus(payload) {
    var text = String(payload == null ? "" : payload)
      .trim()
      .toLowerCase();
    if (text.charAt(0) === "{") {
      try {
        var data = JSON.parse(payload);
        var keys = ["status", "state", "portao", "gate", "door"];
        for (var i = 0; i < keys.length; i++) {
          if (data[keys[i]] !== undefined) {
            text = String(data[keys[i]]).trim().toLowerCase();
            break;
          }
        }
      } catch (e) {}
    }
    if (OPEN_WORDS.indexOf(text) !== -1) return true;
    if (CLOSED_WORDS.indexOf(text) !== -1) return false;
    return null;
  }
  function setGate(open, origin, silent) {
    gateOpen = open;
    var b = els.gateBanner;
    b.classList.remove("open", "closed", "unknown");
    els.gateRibbon.hidden = true;
    if (open === true) {
      b.classList.add("open");
      b.innerHTML = "PORTÃO<br/>ABERTO";
      els.gateRibbon.hidden = false;
      els.gateRibbon.textContent = "PORTÃO ABERTO";
    } else if (open === false) {
      b.classList.add("closed");
      b.innerHTML = "PORTÃO<br/>FECHADO";
    } else {
      b.classList.add("unknown");
      b.innerHTML = "PORTÃO<br/>—";
    }
    els.gateSub.textContent =
      "Último evento: " +
      (open === true
        ? "abertura"
        : open === false
          ? "fechamento"
          : "desconhecido") +
      " (" +
      origin +
      ") em " +
      hhmmss();
    if (!silent) {
      logEvent(
        open === true
          ? "🚪 Portão <b>ABERTO</b> (" + origin + ")"
          : open === false
            ? "🚪 Portão <b>FECHADO</b> (" + origin + ")"
            : "❓ Status desconhecido (" + origin + ")",
        open === true ? "ok" : "",
      );
    }
  }
  function sendCommand(payload, label) {
    if (!client || !client.connected) {
      toast("Sem conexão MQTT. Abra ⚙ MQTT / Vídeo e conecte.", "err");
      logEvent("⚠️ " + label + " não enviado — MQTT desconectado.", "warn");
      return;
    }
    client.publish(
      cfg.topicCommand,
      String(payload),
      { qos: 1 },
      function (err) {
        if (err) {
          toast("Falha ao publicar comando: " + err.message, "err");
          return;
        }
        logEvent(
          "👮 Porteiro: <b>" +
            label +
            "</b> → <span class='mono'>" +
            escapeHtml(cfg.topicCommand) +
            ": " +
            escapeHtml(String(payload)) +
            "</span>",
        );
        setGate(String(payload) === "1", "manual"); // otimismo até chegar o status real
      },
    );
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  // ---------- Frigate events ----------
  // sub_label no Frigate novo = [nome, score]; no antigo = ["nome"] ou string
  function extractName(obj, fallbackBefore) {
    var raw =
      obj && obj.sub_label !== undefined && obj.sub_label !== null
        ? obj.sub_label
        : fallbackBefore && fallbackBefore.sub_label;
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { name: null, score: null };
      if (Array.isArray(raw[0]))
        return { name: raw[0][0] || null, score: raw[0][1] || null };
      // ["John Smith", 0.79]
      if (
        typeof raw[0] === "string" &&
        (typeof raw[1] === "number" || raw[1] === undefined)
      )
        return {
          name: raw[0],
          score: typeof raw[1] === "number" ? raw[1] : null,
        };
      return { name: raw[0] != null ? String(raw[0]) : null, score: null };
    }
    if (typeof raw === "string" && raw.trim())
      return { name: raw.trim(), score: null };
    return { name: null, score: null };
  }

  function handleFrigatePayload(topic, text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      logEvent(
        "📷 Evento Frigate (não-JSON) em <span class='mono'>" +
          escapeHtml(topic) +
          "</span>",
      );
      return;
    }
    // Evento LPR dedicado: {type:"lpr", plate, score, camera, ...}
    if (data.type === "lpr" || (data.plate && !data.after)) {
      var plate = data.plate || data.recognized_license_plate;
      if (plate)
        showPlate(
          String(plate).toUpperCase(),
          data.score || data.recognized_license_plate_score,
          data.camera,
        );
      return;
    }
    var after = data.after || data;
    var before = data.before || {};
    if (!after) return;
    if (cfg.camera && after.camera && after.camera !== cfg.camera) {
      // ignora outras câmeras, mas ainda registra no tráfego MQTT
      return;
    }
    var type = data.type || "update";
    var id =
      after.id ||
      (before && before.id) ||
      after.label + "@" + (after.camera || "");
    if (type === "end") {
      activeObjects.delete(id);
      return;
    }
    if (after.box && after.label) {
      activeObjects.set(id, {
        obj: after,
        before: before,
        lastSeen: Date.now(),
      });
    }
    // Placa reconhecida acoplada ao carro (Frigate+): recognized_license_plate
    var recPlate = after.recognized_license_plate;
    if (recPlate)
      showPlate(
        String(recPlate).toUpperCase(),
        after.recognized_license_plate_score,
        after.camera,
      );

    var label = String(after.label || "").toLowerCase();
    if (label === "person") {
      var idn = extractName(after, before);
      var score = idn.score != null ? idn.score : after.score;
      if (idn.name) {
        showPerson(idn.name, score, after.camera, after);
        if (isAuthorized(idn.name)) {
          logEvent(
            "✅ <b>" +
              escapeHtml(idn.name) +
              "</b> (autorizado, " +
              pct(score) +
              ") — abertura automática via Node-RED.",
            "ok",
          );
          toast("Acesso liberado: " + idn.name, "ok");
          beep(880, 350);
        } else {
          logEvent(
            "⚠️ <b>" +
              escapeHtml(idn.name) +
              "</b> NÃO está na lista de autorizados (" +
              pct(score) +
              ") — liberação manual disponível.",
            "warn",
          );
          toast("Pessoa não autorizada: " + idn.name, "warn");
          beep(330, 500);
        }
      } else {
        showUnknown(after.score, after.camera);
        logEvent(
          "👁 Pessoa detectada sem identificação (" +
            pct(after.score) +
            ") — aguardando reconhecimento.",
          "warn",
        );
      }
    } else if (PLATE_LABELS.indexOf(label) !== -1) {
      var p = extractName(after, before);
      showPlate(
        p.name ? String(p.name).toUpperCase() : "(placa?)",
        p.score != null ? p.score : after.score,
        after.camera,
      );
    } else if (CAR_LABELS.indexOf(label) !== -1) {
      // carro com sub_label parecido com placa? exibe também
      var s = extractName(after, before);
      if (s.name && /[A-Z]{2,3}[- ]?\d/.test(String(s.name).toUpperCase())) {
        showPlate(
          String(s.name).toUpperCase(),
          s.score != null ? s.score : after.score,
          after.camera,
        );
      }
    }
  }

  function pct(x) {
    if (typeof x !== "number") return "—";
    var v = x <= 1 ? x * 100 : x;
    return Math.round(v) + "%";
  }
  function showPerson(name, score, camera, raw) {
    els.personName.textContent = name;
    els.avatar.textContent = (name.trim()[0] || "?").toUpperCase();
    els.personMeta.textContent =
      "confiança " + pct(score) + " · " + (camera || "—") + " · " + hhmmss();
    els.personConf.style.width = pct(score);
    var ok = isAuthorized(name);
    els.accessVerdict.hidden = !ok;
    els.unknownVerdict.hidden = ok;
  }
  function showUnknown(score, camera) {
    els.personName.textContent = "Não identificada";
    els.avatar.textContent = "?";
    els.personMeta.textContent =
      "rosto não reconhecido · " +
      pct(score) +
      " · " +
      (camera || "—") +
      " · " +
      hhmmss();
    els.personConf.style.width = pct(score);
    els.accessVerdict.hidden = true;
    els.unknownVerdict.hidden = false;
  }
  function showPlate(plate, score, camera) {
    els.plateText.textContent = plate || "— — —";
    els.plateMeta.textContent =
      "confiança " + pct(score) + " · " + (camera || "—") + " · " + hhmmss();
    logEvent(
      "🚗 Placa detectada: <b class='mono'>" +
        escapeHtml(plate) +
        "</b> (" +
        pct(score) +
        ")",
    );
  }

  // ---------- MQTT ----------
  function setMqttPill(on, text) {
    els.mqttPill.textContent = "● MQTT: " + text;
    els.mqttPill.classList.toggle("on", !!on);
    els.mqttPill.classList.toggle("bad", !on);
  }
  function connectMQTT() {
    if (typeof mqtt === "undefined") {
      toast("Biblioteca mqtt.min.js não carregou (CDN bloqueado?).", "err");
      return;
    }
    if (client) {
      try {
        client.end(true);
      } catch (e) {}
      client = null;
    }
    var url = "wss://" + cfg.broker; //+ ":" + cfg.wsPort;
    setMqttPill(false, "conectando…");
    logEvent(
      "🔌 Conectando MQTT em <span class='mono'>" +
        escapeHtml(url) +
        "</span>…",
    );
    var opts = { reconnectPeriod: 3000, connectTimeout: 8000, clean: true };
    if (cfg.username) {
      opts.username = cfg.username;
      opts.password = cfg.password || undefined;
    }
    client = mqtt.connect(url, opts);
    client.on("connect", function () {
      setMqttPill(true, "conectado");
      logEvent("🔌 MQTT conectado. Assinando tópicos…", "ok");
      var subs = [cfg.topicStatus, cfg.topicFrigate];
      if (
        cfg.topicFrigate.indexOf("#") === -1 &&
        cfg.topicFrigate.indexOf("+") === -1
      ) {
        subs.push(cfg.topicFrigate.replace(/\/$/, "") + "/#");
      }
      String(cfg.extraTopics || "")
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
        .forEach(function (t) {
          subs.push(t);
        });
      subs.forEach(function (t) {
        client.subscribe(t, { qos: 0 }, function (err) {
          if (!err)
            logEvent(
              "👂 Inscrito em <span class='mono'>" + escapeHtml(t) + "</span>",
            );
        });
      });
      toast("MQTT conectado: " + url, "ok");
    });
    client.on("reconnect", function () {
      setMqttPill(false, "reconectando…");
    });
    client.on("close", function () {
      setMqttPill(false, "desconectado");
    });
    client.on("error", function (err) {
      setMqttPill(false, "erro");
      logEvent(
        "❌ MQTT erro: " + escapeHtml((err && err.message) || err),
        "warn",
      );
    });
    client.on("message", function (topic, payload) {
      var text = "";
      try {
        text = payload.toString();
      } catch (e) {}
      logMqtt(topic, text);
      if (topic === cfg.topicStatus) {
        var st = interpretGateStatus(text);
        if (st === null) {
          logEvent(
            "❓ Status desconhecido em <span class='mono'>" +
              escapeHtml(topic) +
              "</span>: " +
              escapeHtml(text),
            "warn",
          );
        } else {
          setGate(st, "mqtt");
          if (st) beep(660, 250);
        }
        return;
      }
      var frigBase = cfg.topicFrigate.replace(/[#+\/]+$/, "");
      if (
        frigBase &&
        (topic === cfg.topicFrigate || topic.indexOf(frigBase) === 0)
      ) {
        handleFrigatePayload(topic, text);
      }
    });
  }

  // ---------- vídeo + overlay ----------
  var video = els.video,
    mjpeg = els.mjpeg,
    canvas = els.overlay;
  var ctx = canvas.getContext("2d");

  function videoUrls() {
    var base = "https://" + cfg.frigateHost; // + ":" + cfg.frigatePort;
    return {
      mse:
        base +
        "/api/go2rtc/api/stream.mp4?src=" +
        encodeURIComponent(cfg.stream || cfg.camera),
      mjpeg: base + "/api/" + encodeURIComponent(cfg.camera), // + "/mjpeg",
      snap: base + "/api/" + encodeURIComponent(cfg.camera) + "/latest.jpg",
    };
  }
  function setVideoPill(text, ok) {
    els.videoPill.textContent = "● Vídeo: " + text;
    els.videoPill.classList.toggle("on", ok === true);
    els.videoPill.classList.toggle("bad", ok === false);
  }
  function fitCanvasToMedia(w, h) {
    if (!w || !h) return;
    canvas.width = w;
    canvas.height = h;
  }
  video.addEventListener("loadedmetadata", function () {
    fitCanvasToMedia(video.videoWidth, video.videoHeight);
    els.noSignal.style.display = "none";
    els.recDot.hidden = false;
    setVideoPill("ao vivo (MSE)", true);
    els.videoStatus.textContent =
      "MSE " + video.videoWidth + "×" + video.videoHeight;
    logEvent(
      "📹 Vídeo MSE conectado (" +
        video.videoWidth +
        "×" +
        video.videoHeight +
        ")",
      "ok",
    );
  });
  video.addEventListener("error", function () {
    setVideoPill("erro", false);
    els.videoStatus.textContent =
      "erro no stream — confira IP/câmera e CORS do Frigate";
  });
  mjpeg.addEventListener("load", function () {
    fitCanvasToMedia(mjpeg.naturalWidth, mjpeg.naturalHeight);
    els.noSignal.style.display = "none";
    els.recDot.hidden = false;
    setVideoPill("ao vivo (MJPEG)", true);
    els.videoStatus.textContent =
      "MJPEG " + mjpeg.naturalWidth + "×" + mjpeg.naturalHeight;
  });
  mjpeg.addEventListener("error", function () {
    mjpeg.style.display = "none";
    setVideoPill("erro", false);
    els.videoStatus.textContent =
      "MJPEG falhou — câmera offline ou nome incorreto";
  });

  function connectVideo() {
    cfg.frigateHost = els.frigateHost.value.trim() || cfg.frigateHost;
    cfg.camera = els.cameraInput.value.trim() || cfg.camera;
    cfg.stream = els.streamInput.value.trim() || cfg.stream;
    cfg.videoMode = els.modeSelect.value;
    saveConfig();
    els.camLabel.textContent = cfg.camera + " · " + cfg.stream;
    var u = videoUrls();
    video.pause();
    video.removeAttribute("src");
    video.style.display = "none";
    mjpeg.removeAttribute("src");
    mjpeg.style.display = "none";
    els.noSignal.style.display = "flex";
    if (cfg.videoMode === "mjpeg") {
      mjpeg.src = u.mjpeg + "?t=" + Date.now();
      mjpeg.style.display = "block";
      els.videoStatus.textContent = "conectando MJPEG…";
    } else {
      video.src = u.mjpeg ? u.mse : u.mse;
      video.style.display = "block";
      els.videoStatus.textContent = "conectando MSE…";
      video.play().catch(function () {
        els.videoStatus.textContent = "clique no play dentro do player";
      });
    }
    setVideoPill("conectando…", null);
  }

  // Box Frigate: [x_min, y_min, x_max, y_max] em pixels do frame de detecção.
  // Como o canvas tem a resolução do vídeo exibido, escalamos proporcionalmente.
  function projectBox(box) {
    if (!Array.isArray(box) || box.length < 4) return null;
    var a = box.map(Number);
    if (a.some(isNaN)) return null;
    var cw = canvas.width || 1280,
      ch = canvas.height || 720;
    var vw = video.videoWidth || mjpeg.naturalWidth || cw;
    var vh = video.videoHeight || mjpeg.naturalHeight || ch;
    var allSmall = a.every(function (v) {
      return v >= 0 && v <= 1.5;
    });
    var x1, y1, x2, y2;
    if (allSmall) {
      // normalizado 0..1 (Double Take / atributos)
      x1 = a[0] * cw;
      y1 = a[1] * ch;
      x2 = a[2] * cw;
      y2 = a[3] * ch;
    } else {
      // pixels do frame de detecção → escala p/ canvas
      var sx = cw / vw,
        sy = ch / vh;
      x1 = a[0] * sx;
      y1 = a[1] * sy;
      x2 = a[2] * sx;
      y2 = a[3] * sy;
    }
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }
  function styleFor(label, authorized) {
    label = String(label || "").toLowerCase();
    if (PLATE_LABELS.indexOf(label) !== -1)
      return { color: "#00e5ff", tag: "PLACA" };
    if (CAR_LABELS.indexOf(label) !== -1)
      return { color: "#42a5f5", tag: "VEÍCULO" };
    if (label === "person")
      return authorized
        ? { color: "#00e676", tag: "PESSOA" }
        : { color: "#ffea00", tag: "PESSOA?" };
    return { color: "#ff5252", tag: String(label).toUpperCase() };
  }
  function renderLoop() {
    requestAnimationFrame(renderLoop);
    if (!canvas.width) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!els.boxesToggle.checked) return;
    var cutoff = Date.now() - OBJECT_TTL_MS;
    activeObjects.forEach(function (entry, id) {
      if (entry.lastSeen < cutoff) {
        activeObjects.delete(id);
        return;
      }
      var obj = entry.obj;
      var r = projectBox(obj.box);
      if (!r || r.w < 4 || r.h < 4) return;
      var idn = extractName(obj, entry.before);
      var auth = idn.name ? isAuthorized(idn.name) : false;
      var st = styleFor(obj.label, auth);
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.strokeStyle = st.color;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      var score = idn.score != null ? idn.score : obj.score;
      var main = idn.name || st.tag;
      if (st.tag === "PLACA" && idn.name) main = idn.name.toUpperCase();
      var text = main + " " + pct(score);
      ctx.font =
        "bold " + Math.max(13, Math.round(canvas.width / 55)) + "px Arial";
      var tw = ctx.measureText(text).width + 12;
      var ty = Math.max(0, r.y - 26);
      ctx.fillStyle = st.color;
      ctx.fillRect(r.x, ty, Math.min(tw, canvas.width - r.x), 24);
      ctx.fillStyle =
        st.tag === "PESSOA?" || st.tag === "PLACA" ? "#111" : "#fff";
      ctx.fillText(text, r.x + 6, ty + 17);
    });
  }
  requestAnimationFrame(renderLoop);
  setInterval(function () {
    // limpeza periódica
    var cutoff = Date.now() - OBJECT_TTL_MS;
    activeObjects.forEach(function (e, id) {
      if (e.lastSeen < cutoff) activeObjects.delete(id);
    });
  }, 1500);

  // ---------- demo (sem broker) ----------
  var demoTimer = null;
  function demoEvent() {
    var names = authorizedList().length ? authorizedList() : ["gabriel"];
    var pick = Math.random();
    if (pick < 0.45) {
      var n = names[Math.floor(Math.random() * names.length)];
      var id = "demo-" + Date.now();
      var obj = {
        id: id,
        camera: cfg.camera,
        label: "person",
        sub_label: [n, 0.9],
        score: 0.9,
        box: [420, 200, 620, 640],
      };
      activeObjects.set(id, { obj: obj, before: {}, lastSeen: Date.now() });
      showPerson(n, 0.92, cfg.camera);
      logEvent(
        "✅ <b>" +
          escapeHtml(n) +
          "</b> (autorizado, 92%) — abertura automática (demo).",
        "ok",
      );
      setGate(true, "demo");
      setTimeout(function () {
        setGate(false, "demo");
      }, 5000);
    } else if (pick < 0.75) {
      var id2 = "demo-" + Date.now();
      activeObjects.set(id2, {
        obj: {
          id: id2,
          camera: cfg.camera,
          label: "person",
          score: 0.81,
          box: [700, 260, 880, 660],
        },
        before: {},
        lastSeen: Date.now(),
      });
      showUnknown(0.81, cfg.camera);
      logEvent(
        "⚠️ Pessoa <b>não identificada</b> (demo) — use ABRIR manualmente se for visita.",
        "warn",
      );
    } else {
      var plate = ["ABC1D23", "QWE4F56", "XYZ9G88"][
        Math.floor(Math.random() * 3)
      ];
      showPlate(plate, 0.95, cfg.camera);
      var id3 = "demo-" + Date.now();
      activeObjects.set(id3, {
        obj: {
          id: id3,
          camera: cfg.camera,
          label: "license_plate",
          sub_label: [plate, 0.95],
          score: 0.95,
          box: [760, 480, 980, 560],
        },
        before: {},
        lastSeen: Date.now(),
      });
    }
  }

  // ---------- wiring ----------
  function fillInputs() {
    els.frigateHost.value = cfg.frigateHost;
    els.cameraInput.value = cfg.camera;
    els.streamInput.value = cfg.stream;
    els.modeSelect.value = cfg.videoMode;
    els.beepToggle.checked = cfg.beep !== false;
    els.camLabel.textContent = cfg.camera + " · " + cfg.stream;
  }
  function fillDialog() {
    els.cfgBroker.value = cfg.broker;
    els.cfgWsPort.value = cfg.wsPort;
    els.cfgUser.value = cfg.username || "";
    els.cfgPass.value = cfg.password || "";
    els.cfgTopicStatus.value = cfg.topicStatus;
    els.cfgTopicCommand.value = cfg.topicCommand;
    els.cfgTopicFrigate.value = cfg.topicFrigate;
    els.cfgExtra.value = cfg.extraTopics || "";
    els.cfgFrigatePort.value = cfg.frigatePort;
    els.cfgAuth.value = cfg.authorized || "";
  }
  els.videoBtn.addEventListener("click", connectVideo);
  els.snapBtn.addEventListener("click", function () {
    window.open(videoUrls().snap, "_blank");
  });
  els.openBtn.addEventListener("click", function () {
    sendCommand("1", "ABRIR");
  });
  els.closeBtn.addEventListener("click", function () {
    sendCommand("0", "FECHAR");
  });
  els.beepToggle.addEventListener("change", function () {
    cfg.beep = els.beepToggle.checked;
    saveConfig();
  });
  els.clearBtn.addEventListener("click", function () {
    els.eventLog.innerHTML = "";
  });
  els.clearMqttBtn.addEventListener("click", function () {
    els.mqttLog.innerHTML = "";
    mqttSeen = 0;
    els.mqttCount.textContent = "";
  });
  els.exportBtn.addEventListener("click", function () {
    var txt = Array.prototype.map
      .call(els.eventLog.children, function (li) {
        return li.textContent;
      })
      .join("\n");
    var blob = new Blob([txt], { type: "text/plain" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "portaria-log.txt";
    a.click();
  });
  els.configBtn.addEventListener("click", function () {
    fillDialog();
    els.configDialog.showModal();
  });
  els.saveConfigBtn.addEventListener("click", function () {
    cfg.broker = els.cfgBroker.value.trim() || DEFAULTS.broker;
    cfg.wsPort = els.cfgWsPort.value.trim() || DEFAULTS.wsPort;
    cfg.username = els.cfgUser.value.trim();
    cfg.password = els.cfgPass.value;
    cfg.topicStatus = els.cfgTopicStatus.value.trim() || DEFAULTS.topicStatus;
    cfg.topicCommand =
      els.cfgTopicCommand.value.trim() || DEFAULTS.topicCommand;
    cfg.topicFrigate =
      els.cfgTopicFrigate.value.trim() || DEFAULTS.topicFrigate;
    cfg.extraTopics = els.cfgExtra.value.trim();
    cfg.frigatePort = els.cfgFrigatePort.value.trim() || DEFAULTS.frigatePort;
    cfg.authorized = els.cfgAuth.value.trim();
    saveConfig();
    fillInputs();
    logEvent("⚙ Config salva. Reconectando MQTT…");
    connectMQTT();
  });
  els.demoBtn.addEventListener("click", function () {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
      els.demoBtn.textContent = "▶ Demo";
      logEvent("⏹ Demo interrompido.");
      return;
    }
    els.demoBtn.textContent = "⏹ Parar demo";
    logEvent("▶ Modo demo: simulando identificações a cada 4 s (sem broker).");
    demoEvent();
    demoTimer = setInterval(demoEvent, 4000);
  });

  // query params: ?broker=&wsPort=&frigate=&camera=&stream=
  (function () {
    try {
      var q = new URLSearchParams(location.search);
      [
        "broker",
        "wsPort",
        "frigateHost",
        "frigatePort",
        "camera",
        "stream",
      ].forEach(function (k) {
        if (q.get(k)) cfg[k] = q.get(k);
      });
    } catch (e) {}
  })();

  // ---------- boot ----------
  fillInputs();
  setGate(null, "boot", true);
  els.gateSub.textContent = "Último evento: nenhum — conecte o MQTT";
  logEvent(
    "👋 Painel iniciado. Câmera padrão <span class='mono'>" +
      escapeHtml(cfg.camera) +
      "</span>, stream <span class='mono'>" +
      escapeHtml(cfg.stream) +
      "</span>.",
  );
  logEvent("⚠️ Sem backend? Use <b>▶ Demo</b> para testar a tela.");
  connectMQTT();
})();
