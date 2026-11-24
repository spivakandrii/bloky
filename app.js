'use strict';

// =====================================================================
//  Хто я. Окремий id для кожної вкладки, щоб після перезавантаження
//  повернутися в гру тим самим гравцем.
// =====================================================================
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function myId() {
  let id = sessionStorage.getItem('bloky-id');
  if (!id) {
    id = randomId();
    sessionStorage.setItem('bloky-id', id);
  }
  return id;
}

const me = { id: myId(), name: '' };

const ROLES = [
  { key: 'left', icon: '◀', label: 'Ліворуч' },
  { key: 'rotate', icon: '⟳', label: 'Поворот' },
  { key: 'right', icon: '▶', label: 'Праворуч' },
  { key: 'down', icon: '▼', label: 'Вниз' }
];
// Роль без власника (або з власником не в мережі) — спільна: її кнопку тиснуть усі
const COLS = 10;
const ROWS = 20;
const FALL_START_MS = 800;      // падіння на першому рівні
const FALL_MIN_MS = 150;
const FALL_SPEEDUP = 0.9;       // кожен рівень — на 10% швидше
const LEVEL_EVERY_MS = 30000;   // новий рівень кожні 30 секунд
const REPEAT_DELAY_MS = 220;    // затиснута кнопка: перший повтор
const REPEAT_EVERY_MS = 110;    // і далі кожні
const LINE_POINTS = [0, 100, 300, 500, 800];

const HELLO_EVERY_MS = 3000;
const HOST_BEAT_MS = 2000;
const OFFLINE_AFTER_MS = 9000;
const HOST_LOST_AFTER_MS = 10000;
const ELECTION_WAIT_MS = 4500;

const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]]
};
const PIECE_TYPES = Object.keys(SHAPES);
const COLORS = { I: '#3fd0e0', O: '#ffd23f', T: '#b06cff', S: '#46d17a', Z: '#ff5a5f', J: '#4a7dff', L: '#ff9f43' };
const EMPTY = '.';

let room = null;
let isHost = false;
let state = null;
let lastSeq = {};
let liveHostSeenAt = 0;
let bag = [];              // лише в ведучого
let nextFallAt = 0;        // лише в ведучого
let nextLevelAt = 0;       // лише в ведучого
const lastSeen = {};       // лише в ведучого

// =====================================================================
//  Фігури і поле. Поле — рядок COLS×ROWS: '.' порожньо, літера — колір фігури.
// =====================================================================
function rotated(matrix) {
  const n = matrix.length;
  return matrix.map((row, y) => row.map((_, x) => matrix[n - 1 - x][y]));
}

function pieceCells(piece) {
  let matrix = SHAPES[piece.t];
  for (let i = 0; i < piece.r; i++) {
    matrix = rotated(matrix);
  }
  const cells = [];
  matrix.forEach((row, dy) => row.forEach((filled, dx) => {
    if (filled) {
      cells.push([piece.x + dx, piece.y + dy]);
    }
  }));
  return cells;
}

function fits(board, piece) {
  return pieceCells(piece).every(([x, y]) =>
    x >= 0 && x < COLS && y < ROWS && (y < 0 || board[y * COLS + x] === EMPTY));
}

function landingY(board, piece) {
  const ghost = Object.assign({}, piece);
  while (fits(board, Object.assign({}, ghost, { y: ghost.y + 1 }))) {
    ghost.y++;
  }
  return ghost.y;
}

// =====================================================================
//  Ведучий: рахує гру і розсилає стан усім
// =====================================================================
function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function newGame() {
  return {
    hostId: me.id,
    seq: 0,
    phase: 'lobby',
    players: [],
    roles: { left: null, rotate: null, right: null, down: null },
    board: EMPTY.repeat(COLS * ROWS),
    piece: null,
    next: null,
    score: 0,
    lines: 0,
    level: 1,
    best: 0,
    lastMove: null
  };
}

// «Мішок» із семи фігур: кожна випадає раз на сім, без довгих серій однакових
function takeFromBag() {
  if (bag.length === 0) {
    bag = shuffled(PIECE_TYPES);
  }
  return bag.pop();
}

function endGame() {
  state.phase = 'over';
  state.best = Math.max(state.best, state.score);
}

function spawnPiece() {
  const type = state.next || takeFromBag();
  state.next = takeFromBag();
  state.pieces = (state.pieces || 0) + 1;
  const size = SHAPES[type].length;
  state.piece = { t: type, r: 0, x: Math.floor((COLS - size) / 2), y: 0 };
  if (!fits(state.board, state.piece)) {
    endGame();
  }
}

function startGame() {
  state.board = EMPTY.repeat(COLS * ROWS);
  state.score = 0;
  state.lines = 0;
  state.level = 1;
  state.next = null;
  state.lastMove = null;
  bag = [];
  state.phase = 'play';
  spawnPiece();
  nextFallAt = Date.now() + fallMs();
  nextLevelAt = Date.now() + LEVEL_EVERY_MS;
}

function fallMs() {
  return Math.max(FALL_MIN_MS, Math.round(FALL_START_MS * Math.pow(FALL_SPEEDUP, state.level - 1)));
}

function lockPiece() {
  const board = state.board.split('');
  for (const [x, y] of pieceCells(state.piece)) {
    board[y * COLS + x] = state.piece.t;
  }
  const rows = [];
  for (let y = 0; y < ROWS; y++) {
    rows.push(board.slice(y * COLS, (y + 1) * COLS).join(''));
  }
  const kept = rows.filter(row => row.includes(EMPTY));
  const cleared = ROWS - kept.length;
  state.board = Array(cleared).fill(EMPTY.repeat(COLS)).concat(kept).join('');
  state.lines += cleared;
  state.score += LINE_POINTS[cleared];
  spawnPiece();
}

function fallStep() {
  const lower = Object.assign({}, state.piece, { y: state.piece.y + 1 });
  if (fits(state.board, lower)) {
    state.piece = lower;
  } else {
    lockPiece();
  }
}

function tryMove(dir) {
  const piece = state.piece;
  if (dir === 'down') {
    const lower = Object.assign({}, piece, { y: piece.y + 1 });
    if (!fits(state.board, lower)) {
      return false;
    }
    state.piece = lower;
    return true;
  }
  if (dir === 'left' || dir === 'right') {
    const moved = Object.assign({}, piece, { x: piece.x + (dir === 'left' ? -1 : 1) });
    if (!fits(state.board, moved)) {
      return false;
    }
    state.piece = moved;
    return true;
  }
  // Поворот біля стіни: пробуємо трохи зсунути фігуру
  const turned = Object.assign({}, piece, { r: (piece.r + 1) % 4 });
  for (const kick of [0, -1, 1, -2, 2]) {
    const candidate = Object.assign({}, turned, { x: turned.x + kick });
    if (fits(state.board, candidate)) {
      state.piece = candidate;
      return true;
    }
  }
  return false;
}

function isOnline(id) {
  const player = state.players.find(p => p.id === id);
  return Boolean(player && player.online);
}

function isShared(key) {
  const holder = state.roles[key];
  return !holder || !isOnline(holder);
}

function holdsRole(id) {
  return ROLES.some(role => state.roles[role.key] === id);
}

function canPress(id, key) {
  return state.roles[key] === id || isShared(key);
}

function startHint() {
  const shared = ROLES.filter(role => isShared(role.key));
  if (shared.length === 0) {
    return 'Усі ролі розібрано!';
  }
  return 'Без власника, тиснуть усі: ' + shared.map(role => role.icon).join(' ');
}

function upsertPlayer(id, name) {
  lastSeen[id] = Date.now();
  const player = state.players.find(p => p.id === id);
  if (player) {
    player.name = name;
    player.online = true;
    return;
  }
  state.players.push({ id, name, online: true });
}

function handleAction(a) {
  if (!state) {
    return;
  }
  const player = state.players.find(p => p.id === a.from);
  if (!player) {
    return;
  }
  const fromHost = a.from === state.hostId;
  const isRole = ROLES.some(role => role.key === a.role);
  const isDir = ROLES.some(role => role.key === a.dir);

  if (a.type === 'role' && isRole && state.phase === 'lobby') {
    if (state.roles[a.role] === a.from) {
      state.roles[a.role] = null;
    } else if (isShared(a.role)) {
      state.roles[a.role] = a.from;
    } else {
      return;
    }
  } else if (a.type === 'role' && isRole && state.phase === 'play' && isShared(a.role) && !holdsRole(a.from)) {
    // Хто зайшов під час гри, бере одну вільну роль
    state.roles[a.role] = a.from;
  } else if (a.type === 'start' && fromHost && state.phase !== 'play') {
    startGame();
  } else if (a.type === 'lobby' && fromHost && state.phase === 'over') {
    state.phase = 'lobby';
  } else if (a.type === 'move' && isDir && state.phase === 'play' && canPress(a.from, a.dir)) {
    if (!tryMove(a.dir)) {
      return;
    }
    state.lastMove = { dir: a.dir, n: (state.lastMove ? state.lastMove.n : 0) + 1 };
  } else {
    return;
  }
  publishState();
}

function hostTick() {
  if (!isHost || !state) {
    return;
  }
  lastSeen[me.id] = Date.now();
  const now = Date.now();
  for (const p of state.players) {
    p.online = now - (lastSeen[p.id] || 0) < OFFLINE_AFTER_MS;
  }
  if (state.phase === 'lobby') {
    state.players = state.players.filter(p => p.online || now - (lastSeen[p.id] || 0) < 3 * OFFLINE_AFTER_MS);
    for (const role of ROLES) {
      if (!state.players.some(p => p.id === state.roles[role.key])) {
        state.roles[role.key] = null;
      }
    }
  }
  publishState();
}

function hostGameTick() {
  if (!isHost || !state || state.phase !== 'play') {
    return;
  }
  if (Date.now() >= nextLevelAt) {
    state.level++;
    nextLevelAt = Date.now() + LEVEL_EVERY_MS;
  }
  if (Date.now() < nextFallAt) {
    return;
  }
  fallStep();
  nextFallAt = Date.now() + fallMs();
  publishState();
}

function publishState() {
  state.seq++;
  room.send('state', { state }, true);
  render();
}

function becomeHost(fromState) {
  isHost = true;
  bag = [];
  if (fromState) {
    state = Object.assign({}, fromState, { hostId: me.id });
    for (const p of state.players) {
      lastSeen[p.id] = p.online && p.id !== fromState.hostId ? Date.now() : 0;
    }
  } else {
    state = newGame();
  }
  nextFallAt = Date.now() + fallMs();
  nextLevelAt = Date.now() + LEVEL_EVERY_MS;
  lastSeq = {};
  upsertPlayer(me.id, me.name);
  publishState();
}

// =====================================================================
//  Повідомлення з кімнати
// =====================================================================
let electionDone = false;

function onNetMessage(channel, message, retained) {
  if (channel === 'state' && message.state) {
    const incoming = message.state;
    if (isHost) {
      // Два ведучих одночасно: лишається той, у кого менший id
      if (incoming.hostId !== me.id && !retained && incoming.hostId < me.id) {
        isHost = false;
      } else {
        return;
      }
    }
    if ((lastSeq[incoming.hostId] || -1) >= incoming.seq) {
      return;
    }
    lastSeq[incoming.hostId] = incoming.seq;
    if (retained) {
      return;
    }
    liveHostSeenAt = Date.now();
    state = incoming;
    if (electionDone) {
      render();
    }
  } else if (channel === 'hello' && isHost && message.from && message.name) {
    const known = state.players.some(p => p.id === message.from);
    upsertPlayer(message.from, String(message.name).slice(0, 20));
    if (!known) {
      publishState();
    }
  } else if (channel === 'action' && isHost && message.a) {
    handleAction(message.a);
  }
}

function act(type, extra) {
  const a = Object.assign({ type, from: me.id }, extra);
  if (isHost) {
    handleAction(a);
  } else {
    room.send('action', { a });
  }
}

function watchHost() {
  if (isHost || !state || !electionDone) {
    return;
  }
  if (Date.now() - liveHostSeenAt < HOST_LOST_AFTER_MS) {
    $('netInfo').textContent = '';
    return;
  }
  // Ведучий зник: його місце займає гравець з найменшим id
  const candidates = state.players.filter(p => p.online && p.id !== state.hostId).map(p => p.id).sort();
  if (candidates[0] === me.id) {
    becomeHost(state);
  } else {
    $('netInfo').textContent = 'Звʼязок з ведучим втрачено, чекаємо…';
  }
}

async function joinRoom(name, roomName, password) {
  me.name = name;
  room = new Room(onNetMessage);
  await room.join(roomName, password);
  $('roomBadge').textContent = 'кімната ' + room.code;
  $('roomBadge').hidden = false;

  const hello = () => room.send('hello', { from: me.id, name: me.name });
  hello();
  setInterval(hello, HELLO_EVERY_MS);

  // Чекаємо живого ведучого; нема — стаємо ним самі
  await sleep(ELECTION_WAIT_MS);
  electionDone = true;
  if (!isHost && Date.now() - liveHostSeenAt > ELECTION_WAIT_MS) {
    becomeHost(null);
  }
  render();

  setInterval(hostTick, HOST_BEAT_MS);
  setInterval(watchHost, HOST_BEAT_MS);
  setInterval(hostGameTick, 50);
}

// =====================================================================
//  Екран
// =====================================================================
function showScreen(id) {
  for (const s of ['joinScreen', 'lobbyScreen', 'gameScreen', 'settingsScreen']) {
    $(s).hidden = s !== id;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function playerName(id) {
  const p = state.players.find(x => x.id === id);
  return p ? p.name : '';
}

function render() {
  if (!state || settingsOpen) {
    return;
  }
  if (state.phase === 'lobby') {
    showScreen('lobbyScreen');
    renderLobby();
  } else {
    showScreen('gameScreen');
    renderGame();
  }
  updateWakeLock();
  signals();
}

function renderLobby() {
  const cards = $('roleCards');
  cards.innerHTML = '';
  for (const role of ROLES) {
    const holder = state.roles[role.key];
    const card = el('button', 'role-card' + (holder ? ' taken' : '') + (holder === me.id ? ' mine' : ''));
    card.append(el('span', 'icon', role.icon), el('span', null, role.label));
    let who = 'усі';
    if (holder) {
      who = playerName(holder) + (holder === me.id ? ' (ви)' : '');
    }
    card.append(el('span', 'who', who));
    card.addEventListener('click', () => act('role', { role: role.key }));
    cards.append(card);
  }

  const list = $('playerList');
  list.innerHTML = '';
  for (const p of state.players) {
    const roles = ROLES.filter(role => state.roles[role.key] === p.id).map(role => role.icon).join(' ');
    const line = (p.id === state.hostId ? '★ ' : '') + p.name + (p.id === me.id ? ' (ви)' : '') + (roles ? '  ' + roles : '');
    list.append(el('li', p.online ? '' : 'offline', line));
  }

  $('hostControls').hidden = !isHost;
  $('lobbyWait').hidden = isHost;
  if (isHost) {
    $('startHint').textContent = startHint();
  }
}

// ---------- Поле ----------
let cell = 24;

function layoutBoard() {
  const width = Math.min(window.innerWidth, 560) - 32;
  const height = window.innerHeight - 330;
  cell = Math.max(14, Math.floor(Math.min(width / COLS, height / ROWS)));
  setupCanvas($('boardCanvas'), cell * COLS, cell * ROWS);
  setupCanvas($('nextCanvas'), 48, 28);
}

function setupCanvas(canvas, width, height) {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
}

function drawBlock(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(x * size + 1, y * size + 1, size - 2, Math.max(2, size * 0.18));
}

function drawBoard() {
  const ctx = $('boardCanvas').getContext('2d');
  ctx.fillStyle = '#0a1024';
  ctx.fillRect(0, 0, cell * COLS, cell * ROWS);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 1; x < COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, cell * ROWS);
    ctx.stroke();
  }
  for (let y = 1; y < ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(cell * COLS, y * cell + 0.5);
    ctx.stroke();
  }

  for (let i = 0; i < state.board.length; i++) {
    const type = state.board[i];
    if (type !== EMPTY) {
      drawBlock(ctx, i % COLS, Math.floor(i / COLS), cell, COLORS[type]);
    }
  }

  if (!state.piece) {
    return;
  }
  if (state.phase === 'play') {
    // Тінь: куди фігура впаде
    const ghost = Object.assign({}, state.piece, { y: landingY(state.board, state.piece) });
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2;
    for (const [x, y] of pieceCells(ghost)) {
      ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  for (const [x, y] of pieceCells(state.piece)) {
    drawBlock(ctx, x, y, cell, COLORS[state.piece.t]);
  }
}

function drawNext() {
  const ctx = $('nextCanvas').getContext('2d');
  ctx.clearRect(0, 0, 48, 28);
  if (!state.next) {
    return;
  }
  const size = 11;
  const cells = pieceCells({ t: state.next, r: 0, x: 0, y: 0 });
  const minX = Math.min(...cells.map(c => c[0]));
  const maxX = Math.max(...cells.map(c => c[0]));
  const minY = Math.min(...cells.map(c => c[1]));
  const maxY = Math.max(...cells.map(c => c[1]));
  const offsetX = (48 - (maxX - minX + 1) * size) / 2;
  const offsetY = (28 - (maxY - minY + 1) * size) / 2;
  ctx.save();
  ctx.translate(offsetX - minX * size, offsetY - minY * size);
  for (const [x, y] of cells) {
    drawBlock(ctx, x, y, size, COLORS[state.next]);
  }
  ctx.restore();
}

function renderControls() {
  for (const role of ROLES) {
    const button = $('ctrl-' + role.key);
    const holder = state.roles[role.key];
    const shared = isShared(role.key);
    button.classList.toggle('mine', holder === me.id);
    button.classList.toggle('shared', shared);
    let who = playerName(holder);
    if (shared) {
      who = 'усі';
    } else if (holder === me.id) {
      who = 'ви';
    }
    button.querySelector('.who').textContent = who;
  }

  const free = ROLES.filter(role => isShared(role.key));
  const offer = state.phase === 'play' && !holdsRole(me.id) && free.length > 0;
  $('pickRole').hidden = !offer;
  const picks = $('pickButtons');
  picks.innerHTML = '';
  if (offer) {
    for (const role of free) {
      const pick = el('button', 'pick', role.icon);
      pick.title = role.label;
      pick.addEventListener('click', () => act('role', { role: role.key }));
      picks.append(pick);
    }
  }
}

function plural(n, one, few, many) {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) {
    return n + ' ' + one;
  }
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) {
    return n + ' ' + few;
  }
  return n + ' ' + many;
}

function renderGame() {
  $('scoreView').textContent = state.score;
  $('linesView').textContent = state.lines;
  $('levelView').textContent = state.level;
  drawBoard();
  drawNext();
  renderControls();

  const over = state.phase === 'over';
  $('overPanel').hidden = !over;
  if (over) {
    $('overScore').textContent = plural(state.score, 'очко', 'очки', 'очок') + ' · ' + plural(state.lines, 'лінія', 'лінії', 'ліній');
    $('overBest').textContent = 'Рівень ' + state.level + ' · рекорд кімнати ' + state.best;
    $('overHost').hidden = !isHost;
    $('overWait').hidden = isHost;
  }
}

// ---------- Підсвітка ходів, вібрація, екран не гасне ----------
let seenMove = 0;
let seenLines = 0;
let seenPhase = null;
let seenLevel = 1;
let seenPieces = 0;

function signals() {
  const move = state.lastMove;
  if (move && move.n !== seenMove) {
    seenMove = move.n;
    const button = $('ctrl-' + move.dir);
    button.classList.remove('pulse');
    void button.offsetWidth;
    button.classList.add('pulse');
    playEffect(move.dir);
  }
  const playing = state.phase === 'play' && seenPhase === 'play';
  if (state.lines > seenLines) {
    vibrate(80);
    playEffect('line');
  } else if (playing && state.pieces > seenPieces) {
    playEffect('land');
  }
  if (playing && state.level > seenLevel) {
    playEffect('level');
  }
  if (state.phase === 'over' && seenPhase === 'play') {
    vibrate([300, 100, 300]);
    playEffect('over');
  }
  seenLines = state.lines;
  seenLevel = state.level;
  seenPieces = state.pieces || 0;
  seenPhase = state.phase;
  updateMusic();
}

// =====================================================================
//  Звуки і музика: синтезуються Web Audio, файлів не потрібно.
//  Музика — приспів «Калинки» (народна пісня), темп росте з рівнем.
// =====================================================================
const SOUND_KEY = 'bloky-sound';
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// [нота, тривалість у восьмих]; 32 восьмі = один прохід приспіву
const KALINKA = [
  ['E5', 1], ['D5', 1], ['C5', 2], ['D5', 1], ['C5', 1], ['B4', 2],
  ['C5', 1], ['B4', 1], ['A4', 1], ['B4', 1], ['E4', 4],
  ['A5', 1], ['A5', 1], ['G5', 1], ['F5', 1], ['E5', 1], ['D5', 1], ['C5', 2],
  ['D5', 1], ['C5', 1], ['B4', 1], ['G#4', 1], ['A4', 4]
];
// Бас: акорд на кожні 4 восьмі (корінь і квінта по черзі)
const KALINKA_BASS = [['A2', 'E3'], ['E2', 'B2'], ['A2', 'E3'], ['E2', 'B2'], ['D2', 'A2'], ['A2', 'E3'], ['E2', 'B2'], ['A2', 'E3']];
const KALINKA_EIGHTHS = 32;

let sound = loadSound();
let audio = null;
let master = null;
let musicTimer = null;
let musicStep = 0;
let musicNextAt = 0;
const melodyAt = {};
{
  let step = 0;
  for (const [note, length] of KALINKA) {
    melodyAt[step] = [note, length];
    step += length;
  }
}

function loadSound() {
  try {
    return Object.assign({ music: true, effects: true }, JSON.parse(localStorage.getItem(SOUND_KEY)));
  } catch {
    return { music: true, effects: true };
  }
}

function saveSound() {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(sound));
  } catch {
    // не збереглося — діятиме до перезавантаження
  }
}

// Браузер дозволяє звук лише після дотику чи натискання клавіші
function unlockAudio() {
  if (!audio) {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      return;
    }
    audio = new Context();
    master = audio.createGain();
    master.gain.value = 0.7;
    master.connect(audio.destination);
  }
  if (audio.state === 'suspended') {
    audio.resume();
  }
}

document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function noteFreq(name) {
  const match = /^([A-G])(#?)(\d)$/.exec(name);
  const midi = (Number(match[3]) + 1) * 12 + SEMITONES[match[1]] + (match[2] ? 1 : 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function tone(freq, at, duration, type, volume) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(master);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

function playEffect(name) {
  if (!sound.effects || !audio || audio.state !== 'running') {
    return;
  }
  const now = audio.currentTime;
  if (name === 'left' || name === 'right') {
    tone(520, now, 0.04, 'square', 0.05);
  } else if (name === 'rotate') {
    tone(780, now, 0.05, 'square', 0.05);
  } else if (name === 'down') {
    tone(360, now, 0.04, 'square', 0.04);
  } else if (name === 'land') {
    tone(110, now, 0.12, 'triangle', 0.25);
  } else if (name === 'line') {
    ['C6', 'E6', 'G6', 'C7'].forEach((note, i) => tone(noteFreq(note), now + i * 0.06, 0.12, 'square', 0.07));
  } else if (name === 'level') {
    ['G5', 'C6'].forEach((note, i) => tone(noteFreq(note), now + i * 0.1, 0.18, 'triangle', 0.15));
  } else if (name === 'over') {
    ['E5', 'C5', 'A4', 'E4'].forEach((note, i) => tone(noteFreq(note), now + i * 0.22, 0.3, 'triangle', 0.2));
  }
}

function musicBpm() {
  return Math.min(240, 120 + (state.level - 1) * 10);
}

function scheduleMusic() {
  const eighth = 60 / musicBpm() / 2;
  while (musicNextAt < audio.currentTime + 0.15) {
    const step = musicStep % KALINKA_EIGHTHS;
    const note = melodyAt[step];
    if (note) {
      tone(noteFreq(note[0]), musicNextAt, note[1] * eighth * 0.9, 'square', 0.045);
    }
    if (step % 2 === 0) {
      const chord = KALINKA_BASS[Math.floor(step / 4)];
      tone(noteFreq(chord[(step / 2) % 2]), musicNextAt, eighth * 1.6, 'triangle', 0.12);
    }
    musicNextAt += eighth;
    musicStep++;
  }
}

function updateMusic() {
  const want = sound.music && audio && audio.state === 'running' && state && state.phase === 'play' && !document.hidden;
  if (want && !musicTimer) {
    musicStep = 0;
    musicNextAt = audio.currentTime + 0.05;
    musicTimer = setInterval(scheduleMusic, 25);
  } else if (!want && musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}

document.addEventListener('visibilitychange', updateMusic);

// iPhone вібрацію з браузера не підтримує — там просто нічого не станеться
function vibrate(pattern) {
  if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) {
    navigator.vibrate(pattern);
  }
}

let wakeLock = null;

async function updateWakeLock() {
  const want = state && state.phase === 'play';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    wakeLock = null;
  }
}

// =====================================================================
//  Керування
// =====================================================================
function pressRole(key) {
  if (state && state.phase === 'play' && canPress(me.id, key)) {
    vibrate(15);
    act('move', { dir: key });
    return true;
  }
  return false;
}

for (const role of ROLES) {
  const button = $('ctrl-' + role.key);
  let delay = null;
  let repeat = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(repeat);
  };
  button.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!state) {
      return;
    }
    if (!pressRole(role.key) || role.key === 'rotate') {
      return;
    }
    stop();
    delay = setTimeout(() => {
      repeat = setInterval(() => pressRole(role.key), REPEAT_EVERY_MS);
    }, REPEAT_DELAY_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    button.addEventListener(type, stop);
  }
  button.addEventListener('contextmenu', e => e.preventDefault());
}

// =====================================================================
//  Налаштування керування: клавіша і кнопка геймпада для кожної дії.
//  Зберігаються лише в цьому браузері — у кожного гравця свої.
// =====================================================================
const BINDINGS_KEY = 'bloky-bindings';
const DEFAULT_BINDINGS = {
  left: { key: 'ArrowLeft', pad: 'b14' },
  rotate: { key: 'ArrowUp', pad: 'b0' },
  right: { key: 'ArrowRight', pad: 'b15' },
  down: { key: 'ArrowDown', pad: 'b13' }
};
// Назви кнопок стандартного геймпада (Xbox-розкладка; на PlayStation A = ✕, B = ○, X = □, Y = △)
const PAD_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L-стік', 'R-стік', 'Хрест ↑', 'Хрест ↓', 'Хрест ←', 'Хрест →'];
const KEY_NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Пробіл', Enter: 'Enter', ShiftLeft: 'Shift', ShiftRight: 'Shift (правий)', ControlLeft: 'Ctrl', ControlRight: 'Ctrl (правий)' };
const AXIS_THRESHOLD = 0.6;

let settingsOpen = false;
let capturing = null;        // { role, kind: 'key' | 'pad' } — чекаємо нову клавішу чи кнопку
let bindings = loadBindings();

function loadBindings() {
  const result = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  try {
    const saved = JSON.parse(localStorage.getItem(BINDINGS_KEY));
    for (const role of ROLES) {
      if (saved && saved[role.key]) {
        Object.assign(result[role.key], saved[role.key]);
      }
    }
  } catch {
    // нема збережених — лишаються стандартні
  }
  return result;
}

function saveBindings() {
  try {
    localStorage.setItem(BINDINGS_KEY, JSON.stringify(bindings));
  } catch {
    // не збереглося — діятиме до перезавантаження
  }
}

function keyName(code) {
  if (!code) {
    return '—';
  }
  if (KEY_NAMES[code]) {
    return KEY_NAMES[code];
  }
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
}

function padName(input) {
  if (!input) {
    return '—';
  }
  if (input[0] === 'b') {
    return PAD_BUTTONS[Number(input.slice(1))] || 'Кнопка ' + input.slice(1);
  }
  // Стік: a0 — горизонталь, a1 — вертикаль лівого стіка
  const axis = Number(input.slice(1, -1));
  const sign = input.slice(-1);
  const arrows = axis % 2 === 0 ? { '-': '←', '+': '→' } : { '-': '↑', '+': '↓' };
  return (axis < 2 ? 'Лівий' : 'Правий') + ' стік ' + arrows[sign];
}

function roleFor(kind, value) {
  const role = ROLES.find(r => bindings[r.key][kind] === value);
  return role ? role.key : null;
}

function startCapture(role, kind) {
  const same = capturing && capturing.role === role && capturing.kind === kind;
  capturing = same ? null : { role, kind };
  renderSettings();
}

function finishCapture(value) {
  const { role, kind } = capturing;
  // Та сама клавіша не може керувати двома діями
  for (const r of ROLES) {
    if (bindings[r.key][kind] === value) {
      bindings[r.key][kind] = null;
    }
  }
  bindings[role][kind] = value;
  capturing = null;
  saveBindings();
  renderSettings();
}

function renderSettings() {
  const rows = $('bindingRows');
  rows.innerHTML = '';
  for (const role of ROLES) {
    rows.append(el('span', 'binding-label', role.icon + ' ' + role.label));
    for (const kind of ['key', 'pad']) {
      const waiting = capturing && capturing.role === role.key && capturing.kind === kind;
      const value = bindings[role.key][kind];
      let text = kind === 'key' ? keyName(value) : padName(value);
      if (waiting) {
        text = kind === 'key' ? 'Натисніть клавішу…' : 'Натисніть на геймпаді…';
      }
      const slot = el('button', 'binding' + (waiting ? ' waiting' : ''), text);
      slot.addEventListener('click', () => startCapture(role.key, kind));
      rows.append(slot);
    }
  }
  $('musicInput').checked = sound.music;
  $('effectsInput').checked = sound.effects;
  const pads = connectedPads();
  $('padStatus').textContent = pads.length > 0
    ? 'Геймпад: ' + pads.map(p => p.id.replace(/\s*\(.*\)\s*$/, '')).join(', ')
    : 'Геймпад не знайдено. Підключіть його і натисніть будь-яку кнопку.';
}

function openSettings() {
  settingsOpen = true;
  capturing = null;
  renderSettings();
  showScreen('settingsScreen');
  startPadLoop();
}

function closeSettings() {
  settingsOpen = false;
  capturing = null;
  if (state) {
    render();
  } else {
    showScreen('joinScreen');
  }
}

$('settingsBtn').addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
$('closeSettings').addEventListener('click', closeSettings);
$('musicInput').addEventListener('change', () => {
  sound.music = $('musicInput').checked;
  saveSound();
  updateMusic();
});
$('effectsInput').addEventListener('change', () => {
  sound.effects = $('effectsInput').checked;
  saveSound();
});
$('resetBindings').addEventListener('click', () => {
  bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  capturing = null;
  saveBindings();
  renderSettings();
});

// ---------- Клавіатура ----------
document.addEventListener('keydown', e => {
  if (capturing) {
    e.preventDefault();
    if (e.code === 'Escape') {
      capturing = null;
      renderSettings();
    } else if (capturing.kind === 'key') {
      finishCapture(e.code);
    }
    return;
  }
  if (settingsOpen || e.target.tagName === 'INPUT') {
    return;
  }
  const role = roleFor('key', e.code);
  if (!role || (role === 'rotate' && e.repeat)) {
    return;
  }
  if (pressRole(role)) {
    e.preventDefault();
  }
});

// ---------- Геймпад ----------
const padHeld = {};          // натиснуті зараз: вхід → коли повторити
let padLoopRunning = false;

function connectedPads() {
  return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
}

function activePadInputs() {
  const active = new Set();
  for (const pad of connectedPads()) {
    pad.buttons.forEach((button, i) => {
      if (button.pressed) {
        active.add('b' + i);
      }
    });
    pad.axes.forEach((value, i) => {
      if (value <= -AXIS_THRESHOLD) {
        active.add('a' + i + '-');
      } else if (value >= AXIS_THRESHOLD) {
        active.add('a' + i + '+');
      }
    });
  }
  return active;
}

function onPadPress(input) {
  if (capturing && capturing.kind === 'pad') {
    finishCapture(input);
    return;
  }
  if (settingsOpen) {
    return;
  }
  const role = roleFor('pad', input);
  if (role) {
    pressRole(role);
  }
}

function pollPads() {
  const now = performance.now();
  const active = activePadInputs();
  for (const input of active) {
    if (!padHeld[input]) {
      padHeld[input] = now + REPEAT_DELAY_MS;
      onPadPress(input);
      continue;
    }
    const role = roleFor('pad', input);
    if (now >= padHeld[input] && role && role !== 'rotate' && !settingsOpen) {
      padHeld[input] = now + REPEAT_EVERY_MS;
      pressRole(role);
    }
  }
  for (const input of Object.keys(padHeld)) {
    if (!active.has(input)) {
      delete padHeld[input];
    }
  }
}

// Геймпад не надсилає подій про натискання — опитуємо його 50 разів на секунду
function startPadLoop() {
  if (!padLoopRunning && navigator.getGamepads) {
    padLoopRunning = true;
    setInterval(pollPads, 20);
  }
}

window.addEventListener('gamepadconnected', () => {
  startPadLoop();
  if (settingsOpen) {
    renderSettings();
  }
});
window.addEventListener('gamepaddisconnected', () => {
  if (settingsOpen) {
    renderSettings();
  }
});

$('startBtn').addEventListener('click', () => act('start'));
$('againBtn').addEventListener('click', () => act('start'));
$('lobbyBtn').addEventListener('click', () => act('lobby'));

window.addEventListener('resize', () => {
  layoutBoard();
  if (state && state.phase !== 'lobby') {
    renderGame();
  }
});
layoutBoard();

try {
  $('nameInput').value = localStorage.getItem('bloky-name') || '';
  $('roomInput').value = localStorage.getItem('bloky-room') || '';
} catch {
  // сховище недоступне — поля просто порожні
}

$('joinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  const roomName = $('roomInput').value;
  try {
    localStorage.setItem('bloky-name', name);
    localStorage.setItem('bloky-room', roomName.trim());
  } catch {
    // не зберегли — не страшно
  }
  $('joinBtn').disabled = true;
  $('joinBtn').textContent = 'Підключення…';
  $('joinError').hidden = true;
  try {
    await joinRoom(name, roomName, $('passwordInput').value);
  } catch (err) {
    $('joinError').textContent = err.message;
    $('joinError').hidden = false;
    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Увійти в кімнату';
  }
});

// ---------- PWA ----------
let installPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('installBtn').hidden = false;
});

$('installBtn').addEventListener('click', async () => {
  $('installBtn').hidden = true;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js');
}
