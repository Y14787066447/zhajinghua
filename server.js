const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

/* ============ 配置 ============ */
const START_CHIPS = 1000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
// 后台监控密钥，建议改成你自己的
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin888';

const GAME_TYPES = {
  zhajinhua: { name: '炸金花', cards: 3, ante: 10, maxRounds: 6 },
  niuniu:    { name: '斗牛',   cards: 5, ante: 10, maxRounds: 1 }
};

const rooms = new Map();
const adminSockets = new Set();

/* ============ 牌 ============ */
function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++)
    for (let r = 2; r <= 14; r++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function evalZJH(cards) {
  const v = cards.map(c => c.r).sort((a, b) => b - a);
  const flush = cards[0].s === cards[1].s && cards[1].s === cards[2].s;
  const a23 = v[0] === 14 && v[1] === 3 && v[2] === 2;
  const straight = a23 || (v[0] - v[1] === 1 && v[1] - v[2] === 1);
  const trip = v[0] === v[1] && v[1] === v[2];
  if (trip) return { t: 6, k: [v[0]], name: '豹子' };
  if (straight && flush) return { t: 5, k: [a23 ? 3 : v[0]], name: '顺金' };
  if (flush) return { t: 4, k: v, name: '金花' };
  if (straight) return { t: 3, k: [a23 ? 3 : v[0]], name: '顺子' };
  if (v[0] === v[1] || v[1] === v[2]) {
    const pair = v[0] === v[1] ? v[0] : v[1];
    const kick = v[0] === v[1] ? v[2] : v[0];
    return { t: 2, k: [pair, kick], name: '对子' };
  }
  return { t: 1, k: v, name: '单张' };
}

function evalNN(cards) {
  if (cards.length !== 5) return { t: 0, k: [0], name: '—' };
  const pts = cards.map(c => c.r === 14 ? 1 : (c.r > 10 ? 10 : c.r));
  const sortedRanks = cards.map(c => c.r).sort((a, b) => b - a);
  const rankCount = {};
  cards.forEach(c => rankCount[c.r] = (rankCount[c.r] || 0) + 1);
  const fourRank = Object.keys(rankCount).find(r => rankCount[r] >= 4);
  const allSmall = pts.every(v => v <= 5) && pts.reduce((a, b) => a + b, 0) <= 10;
  const allFace = cards.every(c => c.r >= 11 && c.r <= 13);

  let niuVal = 0;
  for (let i = 0; i < 3; i++)
    for (let j = i + 1; j < 4; j++)
      for (let k = j + 1; k < 5; k++) {
        if ((pts[i] + pts[j] + pts[k]) % 10 === 0) {
          const rest = [0, 1, 2, 3, 4].filter(x => x !== i && x !== j && x !== k);
          const s2 = (pts[rest[0]] + pts[rest[1]]) % 10;
          const v = s2 === 0 ? 10 : s2;
          if (v > niuVal) niuVal = v;
        }
      }

  if (allSmall) return { t: 6, k: [0, ...sortedRanks], name: '五小牛' };
  if (fourRank) return { t: 5, k: [Number(fourRank), ...sortedRanks], name: '炸弹' };
  if (allFace) return { t: 4, k: [0, ...sortedRanks], name: '五花牛' };
  if (niuVal === 10) return { t: 3, k: [10, ...sortedRanks], name: '牛牛' };
  if (niuVal > 0) return { t: 2, k: [niuVal, ...sortedRanks], name: `牛${niuVal}` };
  return { t: 1, k: [0, ...sortedRanks], name: '无牛' };
}

function evaluate(room, cards) {
  return room.gameType === 'niuniu' ? evalNN(cards) : evalZJH(cards);
}

function cmpHand(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  const len = Math.max(a.k.length, b.k.length);
  for (let i = 0; i < len; i++) {
    const va = a.k[i] ?? 0, vb = b.k[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/* ============ 工具 ============ */
function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 5 }, () => chars[(Math.random() * chars.length) | 0]).join('');
  } while (rooms.has(id));
  return id;
}
const sanitize = s => String(s || '').trim().slice(0, 10).replace(/[<>]/g, '');
const getPlayer = (room, id) => room.players.find(p => p.id === id);

function log(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
}

/* ============ 房间 ============ */
function newRoom(hostId, hostName, gameType) {
  const cfg = GAME_TYPES[gameType] || GAME_TYPES.zhajinhua;
  const room = {
    id: genRoomId(),
    hostId,
    players: [],
    pot: 0,
    currentBet: cfg.ante,
    round: 0,
    maxRounds: cfg.maxRounds,
    state: 'waiting',
    turnPlayerId: null,
    log: [],
    gameType: gameType || 'zhajinhua',
    createdAt: Date.now()
  };
  room.players.push(newPlayer(hostId, hostName));
  rooms.set(room.id, room);
  return room;
}

function newPlayer(id, name) {
  return {
    id, name,
    chips: START_CHIPS,
    cards: [],
    folded: false,
    looked: false,
    hasActed: false,
    connected: true,
    betAmount: 0
  };
}

function callAmount(room, p) {
  if (!p) return 0;
  if (room.gameType === 'niuniu') return room.currentBet;
  return p.looked ? room.currentBet * 2 : room.currentBet;
}

function buildState(room, forId) {
  const cfg = GAME_TYPES[room.gameType];
  const me = getPlayer(room, forId);
  return {
    roomId: room.id,
    hostId: room.hostId,
    gameType: room.gameType,
    gameName: cfg.name,
    ante: cfg.ante,
    me: me ? {
      id: me.id,
      name: me.name,
      chips: me.chips,
      cards: me.cards,
      folded: me.folded,
      looked: me.looked,
      isTurn: room.turnPlayerId === me.id && room.state === 'playing',
      callAmount: callAmount(room, me)
    } : null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      folded: p.folded,
      looked: p.looked,
      isTurn: room.turnPlayerId === p.id && room.state === 'playing',
      isHost: room.hostId === p.id,
      handName: room.state === 'ended' && !p.folded && p.cards.length
        ? evaluate(room, p.cards).name : null,
      cards: p.id === forId || (room.state === 'ended' && !p.folded) ? p.cards : null
    })),
    pot: room.pot,
    currentBet: room.currentBet,
    round: room.round,
    maxRounds: room.maxRounds,
    state: room.state,
    log: room.log.slice(-20)
  };
}

/* ============ 后台监控 ============ */
function adminSnapshot() {
  const list = [...rooms.values()].map(room => {
    const cfg = GAME_TYPES[room.gameType];
    return {
      id: room.id,
      gameType: room.gameType,
      gameName: cfg.name,
      state: room.state,
      pot: room.pot,
      currentBet: room.currentBet,
      round: room.round,
      maxRounds: room.maxRounds,
      hostId: room.hostId,
      players: room.players.map(p => {
        let handName = null;
        if (p.cards && p.cards.length === cfg.cards) {
          handName = evaluate(room, p.cards).name;
        }
        return {
          id: p.id,
          name: p.name,
          chips: p.chips,
          folded: p.folded,
          looked: p.looked,
          connected: p.connected,
          isTurn: room.turnPlayerId === p.id && room.state === 'playing',
          isHost: room.hostId === p.id,
          cards: p.cards || [],
          handName
        };
      })
    };
  });
  return { rooms: list, updatedAt: Date.now() };
}

function pushAdmin() {
  if (!adminSockets.size) return;
  const snap = adminSnapshot();
  adminSockets.forEach(s => {
    if (s.connected) s.emit('admin:state', snap);
  });
}

function broadcast(room) {
  room.players.forEach(p => {
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('state', buildState(room, p.id));
  });
  pushAdmin();
}

/* ============ 游戏流程 ============ */
function startGame(room) {
  const cfg = GAME_TYPES[room.gameType];
  const alive = room.players.filter(p => p.connected);
  if (alive.length < MIN_PLAYERS) return { ok: false, msg: '至少需要 2 名在线玩家' };

  room.state = 'playing';
  room.pot = 0;
  room.round = 0;
  room.currentBet = cfg.ante;
  room.log = [];

  const deck = makeDeck();

  room.players.forEach(p => {
    if (!p.connected) { p.folded = true; return; }
    if (p.chips < cfg.ante) {
      p.chips = START_CHIPS;
      log(room, `${p.name} 筹码不足补充至 ${START_CHIPS}`);
    }
    p.cards = [];
    for (let i = 0; i < cfg.cards; i++) p.cards.push(deck.pop());
    p.folded = false;
    p.looked = false;
    p.hasActed = false;
    p.betAmount = cfg.ante;
    p.chips -= cfg.ante;
    room.pot += cfg.ante;
  });

  const first = room.players.find(p => !p.folded);
  room.turnPlayerId = first ? first.id : null;
  log(room, `${cfg.name} 开始！每人底注 ${cfg.ante}`);
  broadcast(room);
  return { ok: true };
}

function finishRound(room, winners) {
  room.state = 'ended';
  if (winners && winners.length) {
    const share = Math.floor(room.pot / winners.length);
    winners.forEach(w => { w.chips += share; });
    const remain = room.pot - share * winners.length;
    if (remain > 0 && winners[0]) winners[0].chips += remain;
    log(room, `🏆 ${winners.map(w => w.name).join('、')} 赢得底池 ${room.pot}`);
  }
  room.pot = 0;
  room.turnPlayerId = null;
  broadcast(room);
}

function showdownZJH(room) {
  const active = room.players.filter(p => !p.folded);
  let bestEval = null;
  active.forEach(p => {
    const ev = evalZJH(p.cards);
    if (!bestEval || cmpHand(ev, bestEval) > 0) bestEval = ev;
  });
  const winners = active.filter(p => cmpHand(evalZJH(p.cards), bestEval) === 0);
  log(room, '—— 摊牌 ——');
  active.forEach(p => log(room, `${p.name}：${evalZJH(p.cards).name}`));
  finishRound(room, winners);
}

function showdownNN(room) {
  const active = room.players.filter(p => !p.folded);
  let bestEval = null;
  active.forEach(p => {
    const ev = evalNN(p.cards);
    if (!bestEval || cmpHand(ev, bestEval) > 0) bestEval = ev;
  });
  const winners = active.filter(p => cmpHand(evalNN(p.cards), bestEval) === 0);
  log(room, '—— 摊牌 ——');
  active.forEach(p => log(room, `${p.name}：${evalNN(p.cards).name}`));
  finishRound(room, winners);
}

function advanceTurn(room) {
  const cur = getPlayer(room, room.turnPlayerId);
  if (cur) cur.hasActed = true;

  const active = room.players.filter(p => !p.folded);
  if (active.length <= 1) return finishRound(room, active);

  if (active.every(p => p.hasActed)) {
    if (room.gameType === 'niuniu') return showdownNN(room);
    room.round++;
    if (room.round >= room.maxRounds) return showdownZJH(room);
    active.forEach(p => p.hasActed = false);
    log(room, `—— 第 ${room.round + 1} 轮 ——`);
  }

  const idx = room.players.findIndex(p => p.id === room.turnPlayerId);
  const n = room.players.length;
  let nextId = null;
  for (let i = 1; i <= n; i++) {
    const p = room.players[(idx + i) % n];
    if (!p.folded) { nextId = p.id; break; }
  }
  room.turnPlayerId = nextId;
  broadcast(room);
}

/* ============ 操作 ============ */
function handleAction(room, playerId, action) {
  if (room.state !== 'playing') return { ok: false, msg: '游戏未进行' };
  if (room.turnPlayerId !== playerId) return { ok: false, msg: '还没轮到你' };
  const p = getPlayer(room, playerId);
  if (!p || p.folded) return { ok: false, msg: '你已弃牌' };

  if (action.type === 'look') {
    if (p.looked) return { ok: false, msg: '已经看过牌了' };
    p.looked = true;
    log(room, `${p.name} 看牌`);
    broadcast(room);
    return { ok: true };
  }
  if (action.type === 'fold') {
    p.folded = true;
    log(room, `${p.name} 弃牌`);
    advanceTurn(room);
    return { ok: true };
  }

  if (room.gameType === 'niuniu') return nnAction(room, p, action);
  return zjhAction(room, p, action);
}

function zjhAction(room, p, action) {
  if (action.type === 'call') {
    const amt = callAmount(room, p);
    if (p.chips < amt) return { ok: false, msg: '筹码不足' };
    p.chips -= amt;
    room.pot += amt;
    log(room, `${p.name} 跟注 ${amt}`);
    advanceTurn(room);
    return { ok: true };
  }
  if (action.type === 'raise') {
    const newBet = Number(action.amount);
    if (!newBet || newBet <= room.currentBet) return { ok: false, msg: '加注额必须大于当前注' };
    const amt = newBet * (p.looked ? 2 : 1);
    if (p.chips < amt) return { ok: false, msg: '筹码不足' };
    room.currentBet = newBet;
    p.chips -= amt;
    room.pot += amt;
    log(room, `${p.name} 加注到 ${newBet}（支付 ${amt}）`);
    advanceTurn(room);
    return { ok: true };
  }
  if (action.type === 'compare') {
    const target = getPlayer(room, action.targetId);
    if (!target || target.folded) return { ok: false, msg: '目标无效' };
    const amt = callAmount(room, p) * 2;
    if (p.chips < amt) return { ok: false, msg: '筹码不足' };
    p.chips -= amt;
    room.pot += amt;
    const myEval = evalZJH(p.cards);
    const tEval = evalZJH(target.cards);
    if (cmpHand(myEval, tEval) > 0) {
      target.folded = true;
      log(room, `${p.name} 比牌胜 ${target.name}（${myEval.name} vs ${tEval.name}）`);
    } else {
      p.folded = true;
      log(room, `${p.name} 比牌负 ${target.name}（${myEval.name} vs ${tEval.name}）`);
    }
    advanceTurn(room);
    return { ok: true };
  }
  return { ok: false, msg: '未知操作' };
}

function nnAction(room, p, action) {
  if (action.type === 'bet') {
    const mult = parseInt(action.amount, 10);
    if (!mult || mult < 1 || mult > 5) return { ok: false, msg: '倍数需在 1~5 之间' };
    const amt = mult * GAME_TYPES.niuniu.ante;
    if (p.chips < amt) return { ok: false, msg: '筹码不足' };
    p.chips -= amt;
    room.pot += amt;
    p.betAmount = amt;
    log(room, `${p.name} 下注 ${mult} 倍（${amt}）`);
    advanceTurn(room);
    return { ok: true };
  }
  return { ok: false, msg: '未知操作' };
}

/* ============ Socket ============ */
io.on('connection', socket => {
  socket.on('createRoom', ({ name, gameType }, cb) => {
    name = sanitize(name);
    if (!name) return cb({ ok: false, msg: '昵称不能为空' });
    if (!GAME_TYPES[gameType]) gameType = 'zhajinhua';
    const room = newRoom(socket.id, name, gameType);
    socket.data.roomId = room.id;
    socket.join(room.id);
    cb({ ok: true, roomId: room.id });
    broadcast(room);
  });

  socket.on('joinRoom', ({ name, roomId }, cb) => {
    name = sanitize(name);
    roomId = String(roomId || '').toUpperCase().trim();
    if (!name) return cb({ ok: false, msg: '昵称不能为空' });
    const room = rooms.get(roomId);
    if (!room) return cb({ ok: false, msg: '房间不存在' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, msg: '房间已满' });
    if (room.state === 'playing') return cb({ ok: false, msg: '游戏进行中，无法加入' });
    if (room.players.some(p => p.name === name)) return cb({ ok: false, msg: '昵称已被使用' });
    room.players.push(newPlayer(socket.id, name));
    socket.data.roomId = room.id;
    socket.join(room.id);
    log(room, `${name} 加入了房间`);
    cb({ ok: true, roomId: room.id });
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('toast', '只有房主可以开始');
    if (room.state === 'playing') return;
    const r = startGame(room);
    if (!r.ok) socket.emit('toast', r.msg);
  });

  socket.on('nextHand', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== 'ended') return;
    if (room.hostId !== socket.id) return socket.emit('toast', '只有房主可以开始下一局');
    startGame(room);
  });

  socket.on('action', action => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const r = handleAction(room, socket.id, action);
    if (!r.ok) socket.emit('toast', r.msg);
  });

  socket.on('admin:subscribe', ({ key } = {}, cb) => {
    if (key !== ADMIN_KEY) {
      if (cb) cb({ ok: false, msg: '密钥错误' });
      return;
    }
    adminSockets.add(socket);
    socket.data.isAdmin = true;
    if (cb) cb({ ok: true });
    socket.emit('admin:state', adminSnapshot());
  });

  socket.on('admin:unsubscribe', () => {
    adminSockets.delete(socket);
    socket.data.isAdmin = false;
  });

  socket.on('disconnect', () => {
    adminSockets.delete(socket);

    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = getPlayer(room, socket.id);
    if (!p) return;
    p.connected = false;
    p.folded = true;
    log(room, `${p.name} 离开房间`);

    if (room.hostId === socket.id) {
      const next = room.players.find(x => x.connected);
      if (next) { room.hostId = next.id; log(room, `房主转移给 ${next.name}`); }
    }

    if (room.state === 'playing') {
      const active = room.players.filter(x => !x.folded);
      if (active.length <= 1) finishRound(room, active);
      else if (room.turnPlayerId === socket.id) advanceTurn(room);
      else broadcast(room);
    } else {
      broadcast(room);
    }

    if (room.players.every(x => !x.connected)) {
      rooms.delete(room.id);
      pushAdmin();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器已启动：http://localhost:${PORT}`));