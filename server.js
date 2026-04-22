'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'speaker-queue.html');
const STATE_FILE = path.join(__dirname, 'queue-state.json');

// ── State ──────────────────────────────────────────────────────────

function defaultState() {
  return {
    speakers: [],
    nextId: 1,
    durationSecs: 120,
    followUpSecs: 0,
    timer: { activeId: null, startedAt: null, pausedRemaining: 120, isPaused: false, phase: 'question' }
  };
}

let state = defaultState();
let doneTimeout = null;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.timer.activeId) {
        // Always restart in paused state so moderator consciously resumes
        state.timer.isPaused = true;
        state.timer.startedAt = null;
      }
    }
  } catch (e) {
    console.error('Could not load state:', e.message);
    state = defaultState();
  }
}

function saveState() {
  const snap = {
    speakers: state.speakers,
    nextId: state.nextId,
    durationSecs: state.durationSecs,
    followUpSecs: state.followUpSecs,
    timer: {
      activeId: state.timer.activeId,
      startedAt: null,
      pausedRemaining: computeRemaining(),
      isPaused: true,
      phase: state.timer.phase
    }
  };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2)); }
  catch (e) { console.error('Could not save state:', e.message); }
}

// ── Timer helpers ──────────────────────────────────────────────────

function computeRemaining() {
  const { timer, durationSecs } = state;
  if (!timer.activeId) return durationSecs;
  if (timer.isPaused) return timer.pausedRemaining;
  return Math.max(0, timer.pausedRemaining - Math.floor((Date.now() - timer.startedAt) / 1000));
}

function scheduleDone() {
  clearScheduledDone();
  if (!state.timer.activeId || state.timer.isPaused) return;
  doneTimeout = setTimeout(() => {
    if (state.timer.phase === 'question' && state.followUpSecs > 0) {
      state.timer.phase = 'followup';
      state.timer.pausedRemaining = state.followUpSecs;
      state.timer.isPaused = true;
      state.timer.startedAt = null;
      saveState();
    } else {
      doMarkDone();
    }
    broadcast();
  }, computeRemaining() * 1000);
}

function clearScheduledDone() {
  if (doneTimeout) { clearTimeout(doneTimeout); doneTimeout = null; }
}

// ── Action handlers ────────────────────────────────────────────────

function doAddSpeaker(name, topic) {
  name = String(name || '').trim().slice(0, 60);
  topic = String(topic || '').trim().slice(0, 120);
  if (!name) return;
  state.speakers.push({ id: state.nextId++, name, topic, status: 'waiting' });
  saveState();
}

function doRemoveSpeaker(id) {
  if (state.timer.activeId === id) {
    clearScheduledDone();
    state.timer.activeId = null;
    state.timer.isPaused = false;
    state.timer.startedAt = null;
    state.timer.pausedRemaining = state.durationSecs;
  }
  state.speakers = state.speakers.filter(s => s.id !== id);
  saveState();
}

function doMoveUp(id) {
  const waiting = state.speakers.filter(s => s.status === 'waiting');
  const idx = waiting.findIndex(s => s.id === id);
  if (idx <= 0) return;
  swapById(state.speakers, id, waiting[idx - 1].id);
  saveState();
}

function doMoveDown(id) {
  const waiting = state.speakers.filter(s => s.status === 'waiting');
  const idx = waiting.findIndex(s => s.id === id);
  if (idx >= waiting.length - 1) return;
  swapById(state.speakers, id, waiting[idx + 1].id);
  saveState();
}

function swapById(arr, id1, id2) {
  const i = arr.findIndex(s => s.id === id1);
  const j = arr.findIndex(s => s.id === id2);
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function doActivate(id) {
  clearScheduledDone();
  if (state.timer.activeId && state.timer.activeId !== id) {
    const prev = state.speakers.find(s => s.id === state.timer.activeId);
    if (prev && prev.status === 'active') prev.status = 'waiting';
  }
  state.timer.activeId = id;
  const sp = state.speakers.find(s => s.id === id);
  if (sp) sp.status = 'active';
  state.timer.phase = 'question';
  state.timer.pausedRemaining = state.durationSecs;
  state.timer.isPaused = false;
  state.timer.startedAt = Date.now();
  scheduleDone();
  saveState();
}

function doPause() {
  if (!state.timer.activeId || state.timer.isPaused) return;
  clearScheduledDone();
  state.timer.pausedRemaining = computeRemaining();
  state.timer.isPaused = true;
  state.timer.startedAt = null;
  saveState();
}

function doResume() {
  if (!state.timer.activeId || !state.timer.isPaused) return;
  state.timer.isPaused = false;
  state.timer.startedAt = Date.now();
  scheduleDone();
  saveState();
}

function doReset() {
  if (!state.timer.activeId) return;
  clearScheduledDone();
  state.timer.pausedRemaining = state.timer.phase === 'followup' ? state.followUpSecs : state.durationSecs;
  state.timer.isPaused = true;
  state.timer.startedAt = null;
  saveState();
}

function doMarkDone() {
  clearScheduledDone();
  const id = state.timer.activeId;
  if (!id) return;
  const sp = state.speakers.find(s => s.id === id);
  if (sp) {
    sp.status = 'done';
    state.speakers = state.speakers.filter(s => s.id !== id).concat(sp);
  }
  state.timer.activeId = null;
  state.timer.isPaused = false;
  state.timer.startedAt = null;
  state.timer.phase = 'question';
  state.timer.pausedRemaining = state.durationSecs;
  saveState();
}

function doSetDuration(secs) {
  secs = parseInt(secs) || 0;
  if (secs <= 0) return;
  state.durationSecs = secs;
  if (!state.timer.activeId) state.timer.pausedRemaining = secs;
  saveState();
}

function doSetFollowUpDuration(secs) {
  secs = parseInt(secs) || 0;
  if (secs < 0) return;
  state.followUpSecs = secs;
  saveState();
}

// ── HTTP server ────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Internal error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

// ── WebSocket server ───────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const clients = new Set();

function buildStateMsg() {
  return JSON.stringify({
    type: 'STATE',
    speakers: state.speakers,
    nextId: state.nextId,
    durationSecs: state.durationSecs,
    followUpSecs: state.followUpSecs,
    timer: { ...state.timer }
  });
}

function broadcast() {
  const msg = buildStateMsg();
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(buildStateMsg());

  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'ADD_SPEAKER':      doAddSpeaker(msg.name, msg.topic); break;
      case 'REMOVE_SPEAKER':   doRemoveSpeaker(msg.id); break;
      case 'MOVE_UP':          doMoveUp(msg.id); break;
      case 'MOVE_DOWN':        doMoveDown(msg.id); break;
      case 'ACTIVATE_SPEAKER': doActivate(msg.id); break;
      case 'PAUSE_TIMER':      doPause(); break;
      case 'RESUME_TIMER':     doResume(); break;
      case 'RESET_TIMER':      doReset(); break;
      case 'MARK_DONE':        doMarkDone(); break;
      case 'SET_DURATION':          doSetDuration(msg.secs); break;
      case 'SET_FOLLOWUP_DURATION': doSetFollowUpDuration(msg.secs); break;
      default: return;
    }
    broadcast();
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

loadState();
server.listen(PORT, () => console.log(`Speaker Queue → http://localhost:${PORT}`));
