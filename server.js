// שרת signaling פשוט - מחבר בין שחקנים שנמצאים על אותו "ערוץ"
// (ערוץ = תדר + מצב). השרת עצמו לא מעביר קול - רק "משדך" בין הדפדפנים,
// והקול עצמו זורם ישירות דפדפן-לדפדפן (WebRTC).

const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// channel (string) -> Map(peerKey -> ws)
const channels = new Map();
// ws -> Set of peerKeys שהלקוח הזה פתח (לניקוי כשמתנתקים)
const socketPeerKeys = new Map();

function peerKey(socketId, deviceId) {
  return `${socketId}:${deviceId}`;
}

function parsePeerKey(key) {
  const [socketId, deviceId] = key.split(':');
  return { socketId, deviceId: Number(deviceId) };
}

wss.on('connection', ws => {
  const socketId = randomUUID();
  socketPeerKeys.set(ws, new Set());
  ws.send(JSON.stringify({ type: 'welcome', id: socketId }));

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      const key = peerKey(socketId, msg.deviceId);
      if (!channels.has(msg.channel)) channels.set(msg.channel, new Map());
      const room = channels.get(msg.channel);

      // שולחים ללקוח החדש רשימת כל מי שכבר נמצא בערוץ
      ws.send(JSON.stringify({
        type: 'peers',
        deviceId: msg.deviceId,
        peers: [...room.keys()]
      }));

      room.set(key, ws);
      socketPeerKeys.get(ws).add(key + '|' + msg.channel);

      // מודיעים לכל מי שכבר שם שהצטרף מישהו חדש (אינפורמטיבי בלבד)
      room.forEach((clientWs, existingKey) => {
        if (existingKey !== key) {
          clientWs.send(JSON.stringify({ type: 'peer-joined', channel: msg.channel, id: key }));
        }
      });
    }

    if (msg.type === 'leave') {
      const key = peerKey(socketId, msg.deviceId);
      removePeer(key);
    }

    if (msg.type === 'signal') {
      // מעבירים את ה-offer/answer/ICE candidate ליעד הספציפי בלבד
      const targetKey = msg.to;
      const { deviceId: targetDeviceId } = parsePeerKey(targetKey);
      const fromKey = peerKey(socketId, msg.deviceId);
      // מוצאים את ה-ws של היעד מתוך אחד הערוצים
      for (const room of channels.values()) {
        const targetWs = room.get(targetKey);
        if (targetWs) {
          targetWs.send(JSON.stringify({
            type: 'signal',
            deviceId: targetDeviceId,
            from: fromKey,
            data: msg.data
          }));
          break;
        }
      }
    }
  });

  ws.on('close', () => {
    const keys = socketPeerKeys.get(ws) || new Set();
    keys.forEach(entry => {
      const [key] = entry.split('|');
      removePeer(key);
    });
    socketPeerKeys.delete(ws);
  });

  function removePeer(key) {
    channels.forEach((room, channelName) => {
      if (room.has(key)) {
        room.delete(key);
        room.forEach(clientWs => {
          clientWs.send(JSON.stringify({ type: 'peer-left', id: key }));
        });
        if (room.size === 0) channels.delete(channelName);
      }
    });
  }
});

console.log(`GeoFS Radio signaling server running on port ${PORT}`);
