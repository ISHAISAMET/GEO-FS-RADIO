// ==UserScript==
// @name         GeoFS Radio Addon
// @namespace    https://github.com/ISHAISAMET/GEO-FS-RADIO
// @version      2.0.0
// @description  Voice radio addon for GeoFS - talk to other players who have the same addon
// @author       ISHAISAMET
// @match        https://www.geo-fs.com/*
// @match       https://www.geo-fs.com/geofs.php?v=3.9/*
// @match        https://geo-fs.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ISHAISAMET/GEO-FS-RADIO/main/geofs-radio.user.js
// @downloadURL  https://raw.githubusercontent.com/ISHAISAMET/GEO-FS-RADIO/main/geofs-radio.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // Basic config - the signaling server address.
  // ============================================================
  const SERVER_URL = 'wss://geo-fs-radio-1.onrender.com';

  // Allowed frequency ranges. Anything outside these is rejected.
  const BANDS = [
    { min: 108.00, max: 135.90, step: 0.05 },
    { min: 1100.00, max: 3900.90, step: 0.10 }
  ];

  const STORAGE_KEY = 'geofsRadioSettings';
  const DEFAULT_FREQUENCY = 118.00;

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    // Two radios by default. Both can still be tuned to either band
    // (108.00-135.90 or 1100.00-3900.90) - there's just no dedicated
    // third unit for now.
    return {
      radios: [
        { id: 1, frequency: DEFAULT_FREQUENCY, mode: 1, power: false },
        { id: 2, frequency: DEFAULT_FREQUENCY, mode: 1, power: false }
      ],
      keyBindings: {},
      joystickBindings: {},
      panelVisible: true
    };
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  const state = loadSettings();
  let listeningForBind = null;          // device id waiting for a keyboard key press
  let listeningForJoystickBind = null;  // device id waiting for a joystick button press
  let micStream = null;

  // deviceId -> { peerId: RTCPeerConnection }, built dynamically from state.radios
  const peerConnectionsByDevice = {};
  state.radios.forEach(r => { peerConnectionsByDevice[r.id] = {}; });

  const micClonesByDevice = {};
  let ws = null;
  let myId = null;

  // ============================================================
  // Frequency helpers
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

  function setFrequencyDirect(radio, value) {
    const f = parseFloat(value);
    if (isNaN(f) || !clampFrequency(f)) {
      render(); // revert display to the last valid value
      return;
    }
    radio.frequency = +f.toFixed(2);
    saveSettings();
    render();
    rejoinChannel(radio);
  }

  // ============================================================
  // Graphic interface
  // ============================================================
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #geofs-radio-panel {
        position: fixed; top: 50%; left: 34px; transform: translateY(-50%);
        z-index: 2147483647;
        display: flex; flex-direction: column; gap: 8px; font-family: monospace;
      }
      .geofs-radio-unit {
        position: relative;
        width: 150px; background: #2b2b2b; border: 2px solid #555;
        border-radius: 8px; padding: 8px; color: #0f0; user-select: none;
      }
      .geofs-radio-screen {
        background: #001a00; padding: 6px; text-align: center;
        font-size: 18px; border-radius: 4px; margin-bottom: 6px; letter-spacing: 1px;
        cursor: pointer;
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

      .geofs-gear-btn {
        position: absolute; top: 4px; right: 4px; width: 20px; height: 20px;
        background: #444; color: #0f0; border: 1px solid #666; border-radius: 4px;
        cursor: pointer; font-size: 12px; line-height: 18px; padding: 0;
      }
      .geofs-gear-btn:hover { background: #555; }
      .geofs-settings-menu {
        display: none;
        position: absolute; top: 26px; right: 4px; z-index: 10;
        background: #1c1c1c; border: 1px solid #666; border-radius: 6px;
        padding: 6px; flex-direction: column; gap: 4px; width: 150px;
      }
      .geofs-settings-menu.open { display: flex; }
      .geofs-settings-menu button {
        background: #444; color: #0f0; border: 1px solid #666; border-radius: 4px;
        cursor: pointer; font-family: monospace; font-size: 11px; padding: 4px;
      }

      #geofs-radio-toggle-tab {
        position: fixed; top: 50%; left: 0; transform: translateY(-50%);
        z-index: 2147483647;
        width: 24px; height: 60px; background: #2b2b2b; border: 2px solid #555;
        border-left: none; border-radius: 0 6px 6px 0; color: #0f0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; font-size: 14px; writing-mode: vertical-rl;
        font-family: monospace;
      }
      #geofs-radio-toggle-tab:hover { background: #3a3a3a; }
    `;
    document.head.appendChild(style);
  }

  function injectPanel() {
    if (!document.getElementById('geofs-radio-panel')) {
      const panel = document.createElement('div');
      panel.id = 'geofs-radio-panel';
      panel.style.display = state.panelVisible ? 'flex' : 'none';
      document.body.appendChild(panel);
    }
    render();
  }

  function injectToggleTab() {
    if (document.getElementById('geofs-radio-toggle-tab')) return;
    const tab = document.createElement('div');
    tab.id = 'geofs-radio-toggle-tab';
    tab.textContent = 'RADIO';
    tab.onclick = () => {
      state.panelVisible = !state.panelVisible;
      saveSettings();
      const panel = document.getElementById('geofs-radio-panel');
      if (panel) panel.style.display = state.panelVisible ? 'flex' : 'none';
    };
    document.body.appendChild(tab);
  }

  function render() {
    const panel = document.getElementById('geofs-radio-panel');
    if (!panel) return;
    panel.innerHTML = '';
    state.radios.forEach(radio => {
      const unit = document.createElement('div');
      unit.className = 'geofs-radio-unit';
      unit.innerHTML = `
        <button class="geofs-gear-btn" data-action="settingsToggle" title="Settings">&#9881;</button>
        <div class="geofs-settings-menu" data-menu>
          <button data-action="bindKey">Key: ${state.keyBindings[radio.id] || '-'}</button>
          <button data-action="bindJoystick">Joystick: ${state.joystickBindings[radio.id] !== undefined ? ('Button ' + state.joystickBindings[radio.id]) : '-'}</button>
        </div>
        <div class="geofs-radio-screen" data-action="freqClick">${radio.frequency.toFixed(2)}</div>
        <div class="geofs-radio-row">
          <button data-action="down">&#9660;</button>
          <button data-action="up">&#9650;</button>
        </div>
        <div class="geofs-radio-row">
          <button data-action="mode">Mode ${radio.mode}</button>
        </div>
        <div class="geofs-radio-row">
          <button data-action="power" class="geofs-power-btn ${radio.power ? 'on' : 'off'}">
            ${radio.power ? 'ON' : 'OFF'}
          </button>
        </div>
        <div class="geofs-ptt-dot" data-dot></div>
      `;

      const menu = unit.querySelector('[data-menu]');

      unit.querySelector('[data-action="settingsToggle"]').onclick = () => {
        menu.classList.toggle('open');
      };

      unit.querySelector('[data-action="freqClick"]').onclick = () => {
        const input = prompt('Enter frequency (e.g. 118.10):', radio.frequency.toFixed(2));
        if (input === null) return;
        const val = parseFloat(input.replace(',', '.'));
        if (!isNaN(val) && clampFrequency(val)) {
          setFrequencyDirect(radio, val);
        } else {
          alert('Invalid frequency. Must be within 108.00-135.90 or 1100.00-3900.90');
        }
      };

      unit.querySelector('[data-action="down"]').onclick = () => stepFrequency(radio, -1);
      unit.querySelector('[data-action="up"]').onclick = () => stepFrequency(radio, 1);
      unit.querySelector('[data-action="mode"]').onclick = () => cycleMode(radio);
      unit.querySelector('[data-action="power"]').onclick = () => togglePower(radio);

      unit.querySelector('[data-action="bindKey"]').onclick = () => {
        listeningForBind = radio.id;
        unit.querySelector('[data-action="bindKey"]').textContent = 'Press a key...';
      };
      unit.querySelector('[data-action="bindJoystick"]').onclick = () => {
        listeningForJoystickBind = radio.id;
        unit.querySelector('[data-action="bindJoystick"]').textContent = 'Press a joystick button...';
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
  // Keyboard
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
  // Joystick / HOTAS (Gamepad API) - polled every animation frame
  // ============================================================
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[0];
    if (gp) {
      if (listeningForJoystickBind) {
        const pressedIndex = gp.buttons.findIndex(b => b.pressed);
        if (pressedIndex !== -1) {
          state.joystickBindings[listeningForJoystickBind] = pressedIndex;
          saveSettings();
          listeningForJoystickBind = null;
          render();
        }
      } else {
        Object.entries(state.joystickBindings).forEach(([deviceId, buttonIndex]) => {
          const pressed = !!gp.buttons[buttonIndex]?.pressed;
          setPTT(+deviceId, pressed);
        });
      }
    }
    requestAnimationFrame(pollGamepad);
  }

  // ============================================================
  // PTT - enables/disables transmission for a specific device
  // ============================================================
  function setPTT(deviceId, pressed) {
    const radio = state.radios.find(r => r.id === deviceId);
    if (!radio || !radio.power) return; // device is off - no talking
    const clone = micClonesByDevice[deviceId];
    if (clone) clone.enabled = pressed;
    setPttDot(deviceId, pressed);
  }

  // ============================================================
  // Microphone
  // ============================================================
  async function initMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error('GeoFS Radio: could not access the microphone', e);
    }
  }

  function getMicCloneForDevice(deviceId) {
    if (!micClonesByDevice[deviceId] && micStream) {
      const track = micStream.getAudioTracks()[0].clone();
      track.enabled = false; // muted until PTT is pressed
      micClonesByDevice[deviceId] = track;
    }
    return micClonesByDevice[deviceId];
  }

  // ============================================================
  // Signaling server connection + WebRTC
  // ============================================================
  function connectSocket() {
    ws = new WebSocket(SERVER_URL);
    ws.onopen = () => {
      // join every channel whose device is already powered on
      state.radios.forEach(r => { if (r.power) rejoinChannel(r); });
    };
    ws.onmessage = evt => {
      const msg = JSON.parse(evt.data);
      handleServerMessage(msg);
    };
    ws.onclose = () => {
      setTimeout(connectSocket, 3000); // try to reconnect
    };
  }

  function handleServerMessage(msg) {
    if (msg.type === 'welcome') {
      myId = msg.id;
    }
    if (msg.type === 'peers') {
      // we're new in the channel - we initiate an offer to everyone already there
      msg.peers.forEach(peerId => createOffer(msg.deviceId, peerId));
    }
    if (msg.type === 'peer-left') {
      // search across all local devices for this peer (we don't know in advance which one held it)
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
    // leave the previous channel (if any) before joining the new one
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
  // Watchdog - checks every 2 seconds that the panel still exists.
  // If GeoFS wipes it while rebuilding its own UI, recreate it.
  // ============================================================
  function watchdog() {
    if (!document.getElementById('geofs-radio-panel')) injectPanel();
    if (!document.getElementById('geofs-radio-toggle-tab')) injectToggleTab();
    setTimeout(watchdog, 2000);
  }

  // ============================================================
  // Init
  // ============================================================
  let didInit = false;
  async function init() {
    if (didInit) return;
    didInit = true;
    injectStyles();
    injectPanel();
    injectToggleTab();
    watchdog();
    await initMic();
    connectSocket();
    requestAnimationFrame(pollGamepad);
  }

  // Run both immediately (if the page is already loaded) and on the
  // load event, so we never miss the right moment.
  if (document.readyState === 'complete') {
    setTimeout(init, 500);
  } else {
    window.addEventListener('load', () => setTimeout(init, 500));
  }
})();
