'use strict';

const path = require('path');
const http = require('http');
const { randomInt } = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');

const PORT = process.env.PORT || 3000;
const GRACE_MS = 45000; // tiempo para reconectar antes de perder el puesto de jugador
const REACTION_KEYS = ['mala', 'comer', 'tortuga', 'suerte', 'aplauso', 'fuego', 'shock', 'payaso'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L

const app = express();
// Versión plana: todos los archivos están en la misma carpeta.
const sendPublic = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', sendPublic('index.html'));
app.get('/style.css', sendPublic('style.css'));
app.get('/client.js', sendPublic('client.js'));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

/** rooms: code -> room */
const rooms = new Map();

/* ----------------------------- utilidades ----------------------------- */

function genCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

const cleanName = (s) =>
  String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanText = (s) =>
  String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const isCell = (a) =>
  Array.isArray(a) && a.length === 2 && Number.isInteger(a[0]) && Number.isInteger(a[1]);

function createRoom(code) {
  const room = {
    code,
    users: new Map(), // clientId -> { id, name, socketId, connected, timer }
    players: { w: null, b: null }, // clientId
    game: game.waitingGame(),
    rematch: new Set(),
    chat: [],
  };
  rooms.set(code, room);
  return room;
}

const colorOf = (room, id) => (room.players.w === id ? 'w' : room.players.b === id ? 'b' : null);

function namesOf(room) {
  const n = (c) => {
    const u = room.users.get(room.players[c]);
    return u ? u.name : '';
  };
  return { w: n('w'), b: n('b') };
}

function publicState(room) {
  const users = [...room.users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    role: colorOf(room, u.id) || 'spec',
    connected: u.connected,
  }));
  const rank = { w: 0, b: 1, spec: 2 };
  users.sort((a, b) => rank[a.role] - rank[b.role]); // sort estable: espectadores en orden de llegada
  const g = room.game;
  return {
    code: room.code,
    users,
    rematch: [...room.rematch],
    game: {
      id: g.id,
      status: g.status,
      board: g.board,
      turn: g.turn,
      chain: g.chain,
      legal: g.legal,
      winner: g.winner,
      reason: g.reason,
      lastMove: g.lastMove,
      names: g.names,
    },
  };
}

const broadcast = (room) => io.to(room.code).emit('state', publicState(room));

function addChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > 60) room.chat.shift();
  io.to(room.code).emit('chat', msg);
}
const sys = (room, text) => addChat(room, { sys: true, text, t: Date.now() });

/* ------------------------------- salas -------------------------------- */

function seat(room, user) {
  if (!room.players.w) room.players.w = user.id;
  else if (!room.players.b) room.players.b = user.id;
  else return false;
  return true;
}

function startNew(room, swap) {
  if (swap) {
    const t = room.players.w;
    room.players.w = room.players.b;
    room.players.b = t;
  }
  room.game = game.createGame();
  room.game.names = namesOf(room);
  room.rematch.clear();
}

function maybeStart(room) {
  if (room.game.status === 'waiting' && room.players.w && room.players.b) {
    startNew(room, false);
    sys(room, '¡Empieza la partida! Blancas mueven primero.');
  }
}

function promote(room) {
  for (const u of room.users.values()) {
    if (room.players.w && room.players.b) break;
    if (u.connected && !colorOf(room, u.id)) {
      seat(room, u);
      sys(room, `${u.name} pasa a jugar.`);
    }
  }
}

function announceResult(room) {
  const g = room.game;
  if (g.status !== 'over') return;
  if (g.winner) sys(room, `🏆 Ganó ${g.names[g.winner] || 'un jugador'}.`);
  else sys(room, '🤝 Tablas.');
}

function removeUser(room, id) {
  const user = room.users.get(id);
  if (!user) return;
  if (user.timer) clearTimeout(user.timer);
  const color = colorOf(room, id);
  room.users.delete(id);

  if (color) {
    room.players[color] = null;
    room.rematch.clear();
    if (room.game.status === 'playing') {
      game.finish(room.game, game.other(color), 'abandono');
      sys(room, `${user.name} abandonó la partida.`);
      announceResult(room);
    } else {
      sys(room, `${user.name} salió de la sala.`);
    }
    promote(room);
  } else {
    sys(room, `${user.name} dejó de mirar.`);
  }

  if (room.users.size === 0) {
    rooms.delete(room.code);
    return;
  }
  maybeStart(room);
  broadcast(room);
}

function ctxOf(socket) {
  const { code, clientId } = socket.data || {};
  if (!code) return null;
  const room = rooms.get(code);
  if (!room) return null;
  const user = room.users.get(clientId);
  if (!user || user.socketId !== socket.id) return null;
  return { room, user, color: colorOf(room, clientId) };
}

function leaveCurrent(socket) {
  const c = ctxOf(socket);
  const code = socket.data && socket.data.code;
  if (code) socket.leave(code);
  socket.data = {};
  if (c) removeUser(c.room, c.user.id);
}

/* ------------------------------ sockets ------------------------------- */

io.on('connection', (socket) => {
  socket.data = {};
  let lastChat = 0;
  let lastReaction = 0;

  socket.on('join', (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    data = data || {};
    const name = cleanName(data.name);
    const clientId = String(data.clientId || '').slice(0, 64);
    if (!name) return reply({ ok: false, error: 'Escribe un apodo.' });
    if (!clientId) return reply({ ok: false, error: 'Falta el identificador del cliente.' });

    let room;
    if (data.create) {
      room = createRoom(genCode());
    } else {
      const code = String(data.code || '').trim().toUpperCase().slice(0, 8);
      room = rooms.get(code);
      if (!room) return reply({ ok: false, error: 'Esa sala no existe. Revisa el código.' });
    }

    const prev = socket.data && socket.data.code;
    if (prev && (prev !== room.code || socket.data.clientId !== clientId)) leaveCurrent(socket);

    let user = room.users.get(clientId);
    let isNew = false;
    if (user) {
      // Reconexión (o segunda pestaña con el mismo id)
      if (user.timer) {
        clearTimeout(user.timer);
        user.timer = null;
      }
      if (user.socketId && user.socketId !== socket.id) {
        const old = io.sockets.sockets.get(user.socketId);
        if (old) old.data = {};
      }
      user.socketId = socket.id;
      user.connected = true;
      user.name = name;
    } else {
      isNew = true;
      user = { id: clientId, name, socketId: socket.id, connected: true, timer: null };
      room.users.set(clientId, user);
      seat(room, user);
    }

    socket.data = { code: room.code, clientId };
    socket.join(room.code);
    socket.emit('chatHistory', room.chat);

    if (isNew) {
      const color = colorOf(room, clientId);
      const role =
        color === 'w' ? 'Jugador 1 (Blancas)' : color === 'b' ? 'Jugador 2 (Negras)' : 'espectador';
      sys(room, `${name} se unió como ${role}.`);
    }
    maybeStart(room);
    broadcast(room);
    reply({ ok: true, code: room.code });
  });

  socket.on('move', (data) => {
    const c = ctxOf(socket);
    if (!c || !c.color || !data) return;
    const g = c.room.game;
    if (g.status !== 'playing' || g.turn !== c.color) return;
    if (!isCell(data.from) || !isCell(data.to)) return;
    const res = game.playMove(g, data.from, data.to);
    if (!res.ok) return;
    announceResult(c.room);
    broadcast(c.room);
  });

  socket.on('resign', () => {
    const c = ctxOf(socket);
    if (!c || !c.color) return;
    if (game.resign(c.room.game, c.color)) {
      sys(c.room, `${c.user.name} se rindió.`);
      announceResult(c.room);
      broadcast(c.room);
    }
  });

  socket.on('rematch', () => {
    const c = ctxOf(socket);
    if (!c || !c.color) return;
    const { room } = c;
    if (room.game.status !== 'over' || !room.players.w || !room.players.b) return;
    room.rematch.add(c.user.id);
    if (room.rematch.has(room.players.w) && room.rematch.has(room.players.b)) {
      startNew(room, true); // se intercambian los colores
      sys(room, '🔁 ¡Revancha! Se intercambiaron los colores.');
    }
    broadcast(room);
  });

  socket.on('rotate', () => {
    const c = ctxOf(socket);
    if (!c || !c.color) return;
    const { room } = c;
    if (room.game.status !== 'over') return;
    const spec = [...room.users.values()].find((u) => u.connected && !colorOf(room, u.id));
    if (!spec) return socket.emit('toast', 'No hay espectadores esperando para entrar.');

    // Pierde el puesto quien perdió; en tablas, quien pidió la rotación.
    const loserColor = room.game.winner ? game.other(room.game.winner) : c.color;
    const loser = room.users.get(room.players[loserColor]);
    room.players[loserColor] = spec.id;
    if (loser) {
      room.users.delete(loser.id); // vuelve al final de la cola de espectadores
      room.users.set(loser.id, loser);
    }
    startNew(room, true);
    sys(room, `🔄 ${spec.name} entra a jugar. ${loser ? loser.name : 'El jugador'} pasa a mirar.`);
    broadcast(room);
  });

  socket.on('chat', (data) => {
    const c = ctxOf(socket);
    if (!c || !data) return;
    const now = Date.now();
    if (now - lastChat < 400) return;
    const text = cleanText(data.text);
    if (!text) return;
    lastChat = now;
    addChat(c.room, { name: c.user.name, role: c.color || 'spec', text, t: now });
  });

  socket.on('reaction', (data) => {
    const c = ctxOf(socket);
    if (!c || !data || !REACTION_KEYS.includes(data.key)) return;
    const now = Date.now();
    if (now - lastReaction < 700) return;
    lastReaction = now;
    io.to(c.room.code).emit('reaction', { key: data.key, name: c.user.name, role: c.color || 'spec' });
  });

  socket.on('leave', () => leaveCurrent(socket));

  socket.on('disconnect', () => {
    const c = ctxOf(socket);
    if (!c) return;
    const { room, user, color } = c;
    user.connected = false;
    user.socketId = null;
    if (color) {
      // Los jugadores tienen un margen para reconectar (p. ej. celular bloqueado).
      user.timer = setTimeout(() => {
        if (!user.connected) removeUser(room, user.id);
      }, GRACE_MS);
      broadcast(room);
    } else {
      removeUser(room, user.id);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`♟  Damas escuchando en http://localhost:${PORT}`);
});
