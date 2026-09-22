// ==UserScript==
// @name         GeoFS Radio Addon
// @namespace    https://github.com/YOUR_USERNAME/geofs-radio
// @version      1.0.0
// @description  שלושה מכשירי רדיו לדיבור קולי בין שחקנים ב-GeoFS
// @author       YOUR_NAME
// @match        https://www.geo-fs.com/*
// @match        https://geo-fs.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ISHAISAMET/GEO-FS-RADIO/main/geofs-radio.user.js
// @downloadURL  https://raw.githubusercontent.com/ISHAISAMET/GEO-FS-RADIO/main/geofs-radio.user.js
// ==/UserScript==

(function () {
  'use strict';

  const SERVER_URL = 'wss://geo-fs-radio-1.onrender.com';

  const BANDS = [
    { min: 108.00, max: 135.90, step: 0.05 },
    { min: 1100.00, max: 3900.90, step: 0.10 }
  ];

  const STORAGE_KEY = 'geofsRadioSettings';

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      radios: [
        { id: 1, frequency: 118.00, mode: 1, power: false },
        { id: 2, frequency: 121.50, mode: 1, power: false },
        { id: 3, frequency: 1100.00, mode: 1, power: false }
      ],
      keyBindings: {},
      joystickBindings: {}
    };
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const state = loadSettings();
  let listeningForBind = null; // id של מכשיר שממתין ללחיצת מקש
  let micStream = null;
  const peerConnectionsByDevice = { 1: {}, 2: {}, 3: {} }; // deviceId -> { peerId: RTCPeerConnection }
  const micClonesByDevice = {};
  let ws = null;
  let myId = null;

  // ============================================================
  // עזרי תדר
  // ============================================================
  function clampFrequency(f) {
    for (const b of BANDS) {
      if (f >= b.min - 1e-9 && f <= b.max + 1e-9) return true;
    }
    return false;
  }

  function stepFrequency(radio, direction) {
    const band = BANDS.find(b => radio.frequency >= b.min - 1e-9 && radio.frequency <= b.max + 1e-9) || BANDS[0];
    let next = +(radio.frequency + direction * band.step).toFixed(2);
    if (next < band.min) next = band.max;
    if (next > band.max) next = band.min;
    radio.frequency = next;
    saveSettings();
    render();
    rejoinChannel(radio);
  }

  function cycleMode(radio) {
    radio.mode = (radio.mode % 4) + 1;
    saveSettings();
    render();
    rejoinChannel(radio);
  }

  function togglePower(radio) {
    radio.power = !radio.power;
    if (!radio.power) setPTT(radio.id, false);
    saveSettings();
    render();
    if (radio.power) rejoinChannel(radio); else leaveChannel(radio);
  }

  function channelKey(radio) {
    return `${radio.frequency.toFixed(2)}_${radio.mode}`;
  }

  // ============================================================
  // ממשק גרפי
  // ============================================================
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #geofs-radio-panel {
        position: fixed; bottom: 10px; left: 10px; z-index: 999999;
        display: flex; gap: 8px; font-family: monospace;
      }
      .geofs-radio-unit {
        width: 150px; background: #2b2b2b; border: 2px solid #555;
        border-radius: 8px; padding: 8px; color: #0f0; user-select: none;
      }
      .geofs-radio-screen {
        background: #001a00; padding: 6px; text-align: center;
        font-size: 18px; border-radius: 4px; margin-bottom: 6px; letter-spacing: 1px;
      }
      .geofs-radio-row { display: flex; gap: 4px; margin-bottom: 4px; }
      .geofs-radio-row button {
        flex: 1; background: #444; color: #0f0; border: 1px solid #666;
        border-radius: 4px; cursor: pointer; font-family: monospace; padding: 4px 0;
      }
      .geofs-radio-row button:hover { background: #555; }
      .geofs-power-btn.on { background: #2ecc40 !important; color: #000 !important; }
      .geofs-power-btn.off { background: #663333 !important; color: #ccc !important; }
      .geofs-ptt-dot {
        width: 10px; height: 10px; border-radius: 50%; background: #333;
        margin: 4px auto 0; transition: background 0.1s;
      }
      .geofs-ptt-dot.active { background: red; box-shadow: 0 0 6px red; }
      .geofs-bind-btn { font-size: 10px !important; }
    `;
    document.head.appendChild(style);
  }

  function injectPanel() {
    const panel = document.createElement('div');
    panel.id = 'geofs-radio-panel';
    document.body.appendChild(panel);
    render();
  }

  function render() {
    const panel = document.getElementById('geofs-radio-panel');
    if (!panel) return;
    panel.innerHTML = '';
    state.radios.forEach(radio => {
      const unit = document.createElement('div');
      unit.className = 'geofs-radio-unit';
      unit.innerHTML = `
        <div class="geofs-radio-screen">${radio.frequency.toFixed(2)}</div>
        <div class="geofs-radio-row">
          <button data-action="down">▼</button>
          <button data-action="up">▲</button>
        </div>
        <div class="geofs-radio-row">
          <button data-action="mode">מצב ${radio.mode}</button>
        </div>
        <div class="geofs-radio-row">
          <button data-action="power" class="geofs-power-btn ${radio.power ? 'on' : 'off'}">
            ${radio.power ? 'פועל' : 'כבוי'}
          </button>
        </div>
        <div class="geofs-radio-row">
          <button data-action="bindKey" class="geofs-bind-btn">מקש: ${state.keyBindings[radio.id] || '—'}</button>
        </div>
        <div class="geofs-ptt-dot" data-dot></div>
      `;
      unit.querySelector('[data-action="down"]').onclick = () => stepFrequency(radio, -1);
      unit.querySelector('[data-action="up"]').onclick = () => stepFrequency(radio, 1);
      unit.querySelector('[data-action="mode"]').onclick = () => cycleMode(radio);
      unit.querySelector('[data-action="power"]').onclick = () => togglePower(radio);
      unit.querySelector('[data-action="bindKey"]').onclick = () => {
        listeningForBind = radio.id;
        unit.querySelector('[data-action="bindKey"]').textContent = 'לחץ מקש...';
      };
      panel.appendChild(unit);
    });
  }

  function setPttDot(deviceId, active) {
    const panel = document.getElementById('geofs-radio-panel');
    if (!panel) return;
    const units = panel.querySelectorAll('.geofs-radio-unit');
    const idx = state.radios.findIndex(r => r.id === deviceId);
    if (idx === -1) return;
    const dot = units[idx]?.querySelector('[data-dot]');
    if (dot) dot.classList.toggle('active', active);
  }

  // ============================================================
  // מקלדת
  // ============================================================
  window.addEventListener('keydown', e => {
    if (listeningForBind) {
      state.keyBindings[listeningForBind] = e.code;
      saveSettings();
      listeningForBind = null;
      render();
      return;
    }
    const devId = Object.keys(state.keyBindings).find(id => state.keyBindings[id] === e.code);
    if (devId) setPTT(+devId, true);
  });

  window.addEventListener('keyup', e => {
    const devId = Object.keys(state.keyBindings).find(id => state.keyBindings[id] === e.code);
    if (devId) setPTT(+devId, false);
  });

  // ============================================================
  // ג'ויסטיק / סטיק (Gamepad API) - פולינג
  // ============================================================
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[0];
    if (gp) {
      Object.entries(state.joystickBindings).forEach(([deviceId, buttonIndex]) => {
        const pressed = !!gp.buttons[buttonIndex]?.pressed;
        setPTT(+deviceId, pressed);
      });
    }
    requestAnimationFrame(pollGamepad);
  }

  // ============================================================
  // PTT בפועל - מדליק/מכבה שידור למכשיר ספציפי
  // ============================================================
  function setPTT(deviceId, pressed) {
    const radio = state.radios.find(r => r.id === deviceId);
    if (!radio || !radio.power) return; // מכשיר כבוי - אין דיבור
    const clone = micClonesByDevice[deviceId];
    if (clone) clone.enabled = pressed;
    setPttDot(deviceId, pressed);
  }

  // ============================================================
  // מיקרופון
  // ============================================================
  async function initMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error('GeoFS Radio: לא ניתן לגשת למיקרופון', e);
    }
  }

  function getMicCloneForDevice(deviceId) {
    if (!micClonesByDevice[deviceId] && micStream) {
      const track = micStream.getAudioTracks()[0].clone();
      track.enabled = false; // מושתק עד ל-PTT
      micClonesByDevice[deviceId] = track;
    }
    return micClonesByDevice[deviceId];
  }

  // ============================================================
  // חיבור לשרת ה-signaling + WebRTC
  // ============================================================
  function connectSocket() {
    ws = new WebSocket(SERVER_URL);
    ws.onopen = () => {
      // מצטרפים לכל ערוץ שהמכשיר כבר דלוק עליו
      state.radios.forEach(r => { if (r.power) rejoinChannel(r); });
    };
    ws.onmessage = evt => {
      const msg = JSON.parse(evt.data);
      handleServerMessage(msg);
    };
    ws.onclose = () => {
      setTimeout(connectSocket, 3000); // ניסיון חיבור מחדש
    };
  }

  function handleServerMessage(msg) {
    if (msg.type === 'welcome') {
      myId = msg.id;
    }
    if (msg.type === 'peers') {
      // אני החדש בערוץ - אני יוזם offer לכל מי שכבר שם
      msg.peers.forEach(peerId => createOffer(msg.deviceId, peerId));
    }
    if (msg.type === 'peer-left') {
      // מחפשים את ה-peer בכל מכשירי המקומיים (לא יודעים מראש איזה מכשיר שלנו החזיק אותו)
      Object.keys(peerConnectionsByDevice).forEach(devId => {
        const pc = peerConnectionsByDevice[devId][msg.id];
        if (pc) { pc.close(); delete peerConnectionsByDevice[devId][msg.id]; }
      });
    }
    if (msg.type === 'signal') {
      handleSignal(msg);
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function rejoinChannel(radio) {
    if (!radio.power) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // עוזבים ערוץ קודם (אם קיים) לפני הצטרפות לחדש
    Object.keys(peerConnectionsByDevice[radio.id]).forEach(peerId => {
      peerConnectionsByDevice[radio.id][peerId].close();
      delete peerConnectionsByDevice[radio.id][peerId];
    });
    send({ type: 'join', deviceId: radio.id, channel: channelKey(radio) });
  }

  function leaveChannel(radio) {
    Object.keys(peerConnectionsByDevice[radio.id]).forEach(peerId => {
      peerConnectionsByDevice[radio.id][peerId].close();
      delete peerConnectionsByDevice[radio.id][peerId];
    });
    send({ type: 'leave', deviceId: radio.id });
  }

  function createPeerConnection(deviceId, peerId) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const clone = getMicCloneForDevice(deviceId);
    if (clone) pc.addTrack(clone, micStream);
    pc.onicecandidate = e => {
      if (e.candidate) send({ type: 'signal', deviceId, to: peerId, data: { candidate: e.candidate } });
    };
    pc.ontrack = e => {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.srcObject = e.streams[0];
      document.body.appendChild(audio);
    };
    peerConnectionsByDevice[deviceId][peerId] = pc;
    return pc;
  }

  async function createOffer(deviceId, peerId) {
    const pc = createPeerConnection(deviceId, peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', deviceId, to: peerId, data: { sdp: offer } });
  }

  async function handleSignal(msg) {
    const { deviceId, from, data } = msg;
    let pc = peerConnectionsByDevice[deviceId][from];
    if (data.sdp && data.sdp.type === 'offer') {
      if (!pc) pc = createPeerConnection(deviceId, from);
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', deviceId, to: from, data: { sdp: answer } });
    } else if (data.sdp && data.sdp.type === 'answer') {
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.candidate) {
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  // ============================================================
  // אתחול
  // ============================================================
  async function init() {
    injectStyles();
    injectPanel();
    await initMic();
    connectSocket();
    requestAnimationFrame(pollGamepad);
  }

  window.addEventListener('load', () => setTimeout(init, 2000));
})();
