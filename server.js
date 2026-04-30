const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/html';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generateColors(count = 5) {
  const colors = [];
  for (let i = 0; i < count; i++) {
    colors.push({
      h: Math.floor(Math.random() * 360),
      s: Math.floor(Math.random() * 60) + 30,
      b: Math.floor(Math.random() * 50) + 30
    });
  }
  return colors;
}

function hsbToHex(h, s, b) {
  s /= 100; b /= 100;
  const k = (n) => (n + h / 60) % 6;
  const f = (n) => b - b * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  const r = Math.round(f(5) * 255);
  const g = Math.round(f(3) * 255);
  const bl = Math.round(f(1) * 255);
  return '#' + [r, g, bl].map(x => x.toString(16).padStart(2, '0')).join('');
}

function calcScore(original, guess) {
  const dh = Math.min(Math.abs(original.h - guess.h), 360 - Math.abs(original.h - guess.h));
  const ds = Math.abs(original.s - guess.s);
  const db = Math.abs(original.b - guess.b);
  const maxDist = Math.sqrt(180 * 180 + 100 * 100 + 100 * 100);
  const dist = Math.sqrt(dh * dh + ds * ds + db * db);
  return Math.max(0, Math.round((1 - dist / maxDist) * 100));
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function getRoomState(room) {
  return {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      ready: p.ready,
      finished: p.finished,
      isHost: p.isHost
    })),
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds
  };
}

function startRound(room) {
  room.phase = 'show';
  room.colors = generateColors(5);
  room.guesses = new Map();
  room.players.forEach(p => { p.finished = false; p.roundScore = 0; });

  broadcast(room, {
    type: 'round_start',
    round: room.round,
    totalRounds: room.totalRounds,
    colors: room.colors
  });

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.phase = 'guess';
    broadcast(room, { type: 'guess_phase' });
  }, 4000);
}

function checkAllFinished(room) {
  const allDone = room.players.every(p => p.finished);
  if (!allDone) return;

  room.phase = 'results';
  const results = room.players.map(p => ({
    id: p.id,
    name: p.name,
    roundScore: p.roundScore,
    totalScore: p.score,
    colorScores: p.colorScores || []
  }));

  broadcast(room, {
    type: 'round_results',
    results,
    colors: room.colors,
    guesses: Object.fromEntries(
      [...room.guesses.entries()].map(([id, g]) => [id, g])
    )
  });

  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    room.round++;
    if (room.round > room.totalRounds) {
      room.phase = 'finished';
      const finalResults = room.players
        .map(p => ({ id: p.id, name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
      broadcast(room, { type: 'game_over', results: finalResults });
    } else {
      room.players.forEach(p => { p.ready = false; });
      broadcast(room, { type: 'next_round_countdown', round: room.round });
      setTimeout(() => {
        if (!rooms.has(room.code)) return;
        startRound(room);
      }, 3000);
    }
  }, 6000);
}

wss.on('connection', (ws) => {
  let playerId = Math.random().toString(36).substring(2, 10);
  let currentRoom = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'create_room') {
      const code = generateRoomCode();
      const room = {
        code,
        players: [],
        phase: 'lobby',
        round: 1,
        totalRounds: msg.rounds || 3,
        colors: [],
        guesses: new Map()
      };
      rooms.set(code, room);
      const player = { id: playerId, name: msg.name, ws, score: 0, ready: false, finished: false, isHost: true };
      room.players.push(player);
      currentRoom = room;
      ws.send(JSON.stringify({ type: 'room_created', code, playerId, state: getRoomState(room) }));
    }

    else if (msg.type === 'join_room') {
      const room = rooms.get(msg.code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Raum nicht gefunden' })); return; }
      if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', msg: 'Spiel läuft bereits' })); return; }
      if (room.players.length >= 8) { ws.send(JSON.stringify({ type: 'error', msg: 'Raum ist voll' })); return; }
      const player = { id: playerId, name: msg.name, ws, score: 0, ready: false, finished: false, isHost: false };
      room.players.push(player);
      currentRoom = room;
      ws.send(JSON.stringify({ type: 'room_joined', code: room.code, playerId, state: getRoomState(room) }));
      broadcast(room, { type: 'player_joined', state: getRoomState(room) });
    }

    else if (msg.type === 'start_game') {
      if (!currentRoom) return;
      const room = currentRoom;
      const host = room.players.find(p => p.id === playerId);
      if (!host || !host.isHost) return;
      if (room.players.length < 2) { ws.send(JSON.stringify({ type: 'error', msg: 'Mindestens 2 Spieler benötigt' })); return; }
      room.phase = 'playing';
      room.round = 1;
      room.players.forEach(p => { p.score = 0; });
      broadcast(room, { type: 'game_started', state: getRoomState(room) });
      setTimeout(() => startRound(room), 1000);
    }

    else if (msg.type === 'submit_guesses') {
      if (!currentRoom) return;
      const room = currentRoom;
      const player = room.players.find(p => p.id === playerId);
      if (!player || player.finished || room.phase !== 'guess') return;

      const guesses = msg.guesses;
      let roundScore = 0;
      const colorScores = guesses.map((g, i) => {
        const s = calcScore(room.colors[i], g);
        roundScore += s;
        return s;
      });

      player.finished = true;
      player.roundScore = Math.round(roundScore / guesses.length);
      player.score += player.roundScore;
      player.colorScores = colorScores;
      room.guesses.set(playerId, guesses);

      broadcast(room, {
        type: 'player_finished',
        playerId,
        playerName: player.name,
        finished: room.players.filter(p => p.finished).length,
        total: room.players.length
      });

      checkAllFinished(room);
    }

    else if (msg.type === 'play_again') {
      if (!currentRoom) return;
      const room = currentRoom;
      const host = room.players.find(p => p.id === playerId);
      if (!host || !host.isHost) return;
      room.phase = 'lobby';
      room.round = 1;
      room.players.forEach(p => { p.score = 0; p.ready = false; p.finished = false; });
      broadcast(room, { type: 'back_to_lobby', state: getRoomState(room) });
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      const wasHost = room.players[idx].isHost;
      const name = room.players[idx].name;
      room.players.splice(idx, 1);
      if (room.players.length === 0) {
        rooms.delete(room.code);
        return;
      }
      if (wasHost && room.players.length > 0) {
        room.players[0].isHost = true;
      }
      broadcast(room, { type: 'player_left', playerName: name, state: getRoomState(room) });
      if (room.phase === 'guess') checkAllFinished(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
