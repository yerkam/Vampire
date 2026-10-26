'use strict';
/* ===== Adım 1: PeerJS Host/Client iskeleti + Lobi ===== */

const PREFIX = 'vampirkoy-';          // Public PeerJS sunucusunda çakışmayı azaltır
const $ = (id) => document.getElementById(id);
const DAY_MS = 120 * 1000;               // gündüz tartışma süresi (test için düşürebilirsin)
const buzz = (ms = 20) => { if (navigator.vibrate) navigator.vibrate(ms); };

// --- Kalıcı kimlik (Adım 4'te reconnect için kullanılacak) ---
const session = {
  get id() {
    let v = sessionStorage.getItem('vk_pid');
    if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('vk_pid', v); }
    return v;
  },
  get name() { return sessionStorage.getItem('vk_name') || ''; },
  set name(v) { sessionStorage.setItem('vk_name', v); },
};

// --- UI yardımcıları ---
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
function homeMsg(t, err = true) { const m = $('home-msg'); m.textContent = t; m.classList.toggle('err', err); }

function renderLobby(state) {
  $('room-code').textContent = state.code;
  $('player-count').textContent = state.players.length;
  $('player-list').innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.host ? ' 👑' : '') + (p.id === session.id ? ' (sen)' : '') + (p.online ? '' : ' — bağlantı yok');
    if (!p.online) li.classList.add('off');
    $('player-list').appendChild(li);
  });
  $('cfg-view').textContent = `Vampir: ${state.cfg.vampire} · Köylü: ${state.cfg.villager}`;
}

/* =====================================================
 *  HOST: oyun motoru (ileride State Machine) + PeerJS
 *  Host'un kendi hamleleri WebRTC'ye girmeden doğrudan
 *  handleMessage(session.id, msg) ile motora iletilir.
 * ===================================================== */
class Host {
  constructor(name) {
    this.name = name;
    this.code = null;
    this.peer = null;
    this.conns = new Map();     // playerId -> DataConnection
    this.players = new Map();   // playerId -> {id,name,host,online}
    this.cfg = { vampire: 1, villager: 2 };
    // --- Oyun motoru durumu (roller yalnızca burada, asla broadcast edilmez) ---
    this.phase = 'LOBBY';
    this.gameStarted = false;
    this.roles = new Map();     // playerId -> 'vampire' | 'villager'
    this.alive = new Set();
    this.ready = new Set();
    this.round = 0;
    this.nightChoices = new Map();   // pid -> hedef
    this.trialVotes = new Map();     // pid -> true/false
    this.execVotes = new Map();      // pid -> hedef
    this.eventText = null;           // son olay duyurusu (rol İÇERMEZ)
    this.winner = null;
    this.nightVictim = null;
    this.timer = null;
    this.dayEnd = 0;
    this.players.set(session.id, { id: session.id, name, host: true, online: true });
  }

  start(attempt = 0) {
    this.code = String(Math.floor(10000 + Math.random() * 90000));   // 5 haneli
    this.peer = new Peer(PREFIX + this.code);
    this.peer.on('open', () => {
      this.normalizeCfg(true);
      showScreen('screen-lobby');
      $('host-config').classList.remove('hidden');
      $('client-wait').classList.add('hidden');
      this.broadcastLobby();
    });
    this.peer.on('connection', (conn) => this.onConnection(conn));
    this.peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && attempt < 5) { this.peer.destroy(); this.start(attempt + 1); }
      else homeMsg('Bağlantı hatası: ' + e.type);
    });
  }

  onConnection(conn) {
    let pid = null;
    conn.on('data', (msg) => {
      if (msg && msg.t === 'join') pid = msg.id;
      this.handleMessage(msg.id || pid, msg, conn);
    });
    conn.on('close', () => {
      if (pid && this.conns.get(pid) === conn) {
        this.conns.delete(pid);
        const p = this.players.get(pid);
        if (p) { p.online = false; if (!this.gameStarted) this.players.delete(pid); }
        this.normalizeCfg(false);
        this.broadcastLobby();
      }
    });
  }

  // Tek giriş noktası: hem WebRTC hem yerel host olayları buraya gelir
  handleMessage(pid, msg, conn) {
    switch (msg.t) {
      case 'join': {
        if (this.gameStarted && !this.players.has(msg.id)) {
          return conn && conn.send({ t: 'joinError', reason: 'Oyun zaten başladı.' });
        }
        const existing = this.players.get(msg.id);
        if (existing) { existing.online = true; existing.name = msg.name; }
        else this.players.set(msg.id, { id: msg.id, name: msg.name, host: false, online: true });
        this.conns.set(msg.id, conn);
        if (this.gameStarted) { this.sendState(msg.id); this.broadcastState(); break; }
        this.normalizeCfg(false);
        this.broadcastLobby();
        break;
      }
      case 'ready':                                   // rol ekranı onayı
        if (this.phase !== 'ROLE_REVEAL') return;
        this.ready.add(pid);
        if ([...this.players.keys()].every(id => this.ready.has(id))) this.transition('NIGHT');
        else this.broadcastState();
        break;
      case 'nightConfirm':
        if (this.phase !== 'NIGHT' || !this.alive.has(pid)) return;
        this.nightChoices.set(pid, msg.target);
        if (this.allActed(this.nightChoices)) this.resolveNight(); else this.broadcastState();
        break;
      case 'trialVote':
        if (this.phase !== 'VOTE_TRIAL' || !this.alive.has(pid)) return;
        this.trialVotes.set(pid, !!msg.vote);
        if (this.allActed(this.trialVotes)) this.resolveTrial(); else this.broadcastState();
        break;
      case 'execVote':
        if (this.phase !== 'VOTE_EXECUTE' || !this.alive.has(pid) || !this.alive.has(msg.target) || msg.target === pid) return;
        this.execVotes.set(pid, msg.target);
        if (this.allActed(this.execVotes)) this.resolveExec(); else this.broadcastState();
        break;
      case 'skipDay':                                 // sadece host
        if (pid === session.id && this.phase === 'DAY') this.transition('VOTE_TRIAL');
        break;
      case 'force':                                   // sadece host: bekleyenleri atla
        if (pid !== session.id) return;
        if (this.phase === 'NIGHT') this.resolveNight();
        else if (this.phase === 'VOTE_TRIAL') this.resolveTrial();
        else if (this.phase === 'VOTE_EXECUTE') this.resolveExec();
        break;
      case 'backToLobby':                             // sadece host, yalnızca oyun bitince
        if (pid === session.id && this.phase === 'GAME_OVER') this.resetToLobby();
        break;
      case 'leave': {                                 // oyuncu odadan ayrıldı (lobi/oyun sonu)
        if (pid === session.id || !['LOBBY', 'GAME_OVER'].includes(this.phase)) return;
        const c = this.conns.get(pid);
        this.conns.delete(pid);                       // close olayı oyuncuyu tekrar işlemesin
        if (c) try { c.close(); } catch (e) {}
        this.players.delete(pid); this.alive.delete(pid); this.ready.delete(pid);
        if (this.phase === 'LOBBY') { this.normalizeCfg(false); this.broadcastLobby(); }
        else this.broadcastState();
        break;
      }
      case 'setCfg':                                  // sadece host
        if (pid !== session.id) return;
        this.cfg[msg.role] = msg.value;
        this.normalizeCfg(false);
        this.broadcastLobby();
        break;
      case 'startGame':
        if (pid !== session.id || this.phase !== 'LOBBY') return;
        this.startGame();
        break;
    }
  }

  /* ---------- State Machine ---------- */
  // Geçerli geçişler (Adım 3'te NIGHT/DAY/VOTE fazları doldurulacak)
  static TRANSITIONS = {
    LOBBY: ['ROLE_REVEAL'],
    ROLE_REVEAL: ['NIGHT'],
    NIGHT: ['DAY', 'GAME_OVER'],
    DAY: ['VOTE_TRIAL', 'NIGHT', 'GAME_OVER'],
    VOTE_TRIAL: ['VOTE_EXECUTE', 'NIGHT'],
    VOTE_EXECUTE: ['NIGHT', 'GAME_OVER'],
    GAME_OVER: [],
  };

  transition(to) {
    if (!Host.TRANSITIONS[this.phase].includes(to)) { console.warn('Geçersiz geçiş', this.phase, to); return; }
    clearTimeout(this.timer);
    this.phase = to;
    if (to === 'NIGHT') { this.round++; this.nightChoices.clear(); this.nightVictim = null; }
    else if (to === 'DAY') {
      this.dayEnd = Date.now() + DAY_MS;
      this.timer = setTimeout(() => this.transition('VOTE_TRIAL'), DAY_MS);
    }
    else if (to === 'VOTE_TRIAL') this.trialVotes.clear();
    else if (to === 'VOTE_EXECUTE') this.execVotes.clear();
    this.broadcastState();
  }

  /* ---------- Oyun kuralları ---------- */
  isVamp(id) { return this.roles.get(id) === 'vampire'; }
  nameOf(id) { return this.players.get(id).name; }
  allActed(map) { return [...this.alive].every(id => map.has(id)); }

  // En çok oy alan(lar): [kazananlar, oy sayısı]
  tally(votes) {
    const c = new Map();
    votes.forEach(t => c.set(t, (c.get(t) || 0) + 1));
    const max = Math.max(0, ...c.values());
    return [[...c].filter(([, n]) => n === max).map(([id]) => id), max];
  }

  checkWin() {
    const v = [...this.alive].filter(id => this.isVamp(id)).length;
    const k = this.alive.size - v;
    if (v === 0) this.winner = 'villager';
    else if (v >= k) this.winner = 'vampire';
    else return false;
    this.transition('GAME_OVER');
    return true;
  }

  resolveNight() {
    // Yalnızca yaşayan vampirlerin geçerli oyları sayılır; köylü seçimleri sahtedir ve atılır
    const votes = [];
    this.nightChoices.forEach((t, id) => {
      if (this.isVamp(id) && this.alive.has(t) && !this.isVamp(t)) votes.push(t);
    });
    let pool = this.tally(votes)[0];
    if (!pool.length) pool = [...this.alive].filter(id => !this.isVamp(id));   // kimse seçmediyse rastgele
    const victim = pool[Math.floor(Math.random() * pool.length)];
    this.alive.delete(victim);
    this.nightVictim = victim;                                        // yalnızca bu oyuncuya ölüm animasyonu gösterilir
    this.eventText = `🌙 Bu gece ${this.nameOf(victim)} öldürüldü.`;      // rol açıklanmaz
    if (!this.checkWin()) this.transition('DAY');
  }

  resolveTrial() {
    let yes = 0, no = 0;
    this.trialVotes.forEach(v => v ? yes++ : no++);
    if (yes > no) {
      this.eventText = `⚖️ Yargılama kabul edildi (Evet ${yes} – Hayır ${no}).\n` + this.voteLines().join('\n');
      this.transition('VOTE_EXECUTE');
    }
    else {
      this.eventText = `⚖️ Yargılama yapılmadı (Evet ${yes} – Hayır ${no}). Kimse asılmadı.\n` + this.voteLines().join('\n');
      this.transition('NIGHT');
    }
  }

  resolveExec() {
    const [top, n] = this.tally(this.execVotes);
    const lines = '\n' + this.voteLines().join('\n');
    if (top.length !== 1 || n === 0) {
      this.eventText = '⚖️ Oylar eşit çıktı, kimse asılmadı.' + lines;
      return this.transition('NIGHT');
    }
    this.alive.delete(top[0]);
    this.eventText = `⚖️ ${this.nameOf(top[0])} kasabadan asıldı.` + lines;      // rol açıklanmaz
    if (!this.checkWin()) this.transition('NIGHT');
  }

  // Açık oylama: kim kime/ne oy verdi (gece oyları HARİÇ)
  voteLines() {
    if (this.phase === 'VOTE_TRIAL')
      return [...this.trialVotes].map(([id, v]) => `${this.nameOf(id)}: ${v ? '✅ Evet' : '❌ Hayır'}`);
    if (this.phase === 'VOTE_EXECUTE')
      return [...this.execVotes].map(([id, t]) => `${this.nameOf(id)} → ${this.nameOf(t)}`);
    return [];
  }

  // Oyun bitti → herkesi aynı odanın lobisine döndür (bağlantısı kopanlar listeden çıkar)
  resetToLobby() {
    clearTimeout(this.timer);
    [...this.players].forEach(([id, p]) => { if (!p.online) this.players.delete(id); });
    this.phase = 'LOBBY';
    this.gameStarted = false;
    this.roles.clear(); this.alive.clear(); this.ready.clear();
    this.nightChoices.clear(); this.trialVotes.clear(); this.execVotes.clear();
    this.round = 0; this.eventText = null; this.winner = null; this.nightVictim = null;
    this.normalizeCfg(true);
    document.body.className = '';
    sessionStorage.removeItem('vk_role'); myRole = null;
    showScreen('screen-lobby');
    $('host-config').classList.remove('hidden');
    $('client-wait').classList.add('hidden');
    this.broadcastLobby();
  }

  startGame() {
    const n = this.total(), { vampire, villager } = this.cfg;
    if (n < 3 || vampire + villager !== n || vampire >= villager) return;
    const ids = [...this.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {          // Fisher-Yates
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.roles.clear(); this.alive.clear(); this.ready.clear();
    ids.forEach((id, i) => { this.roles.set(id, i < vampire ? 'vampire' : 'villager'); this.alive.add(id); });
    this.gameStarted = true;
    this.transition('ROLE_REVEAL');
  }

  // Her oyuncuya YALNIZCA kendi rolünü içeren görünüm gönderilir
  viewFor(pid) {
    const role = this.roles.get(pid) || null;
    const iAmVamp = role === 'vampire';
    const alive = [...this.players.values()].filter(p => this.alive.has(p.id));
    let candidates = [], acted = false, actedCount = 0;
    if (this.phase === 'NIGHT') {
      // Vampire: gerçek hedefler. Köylüler: sahte "kim ölecek?" listesi
      candidates = alive.filter(p => iAmVamp ? !this.isVamp(p.id) : p.id !== pid);
      acted = this.nightChoices.has(pid); actedCount = this.nightChoices.size;
    } else if (this.phase === 'VOTE_TRIAL') {
      acted = this.trialVotes.has(pid); actedCount = this.trialVotes.size;
    } else if (this.phase === 'VOTE_EXECUTE') {
      candidates = alive.filter(p => p.id !== pid);
      acted = this.execVotes.has(pid); actedCount = this.execVotes.size;
    }
    return {
      phase: this.phase,
      role,
      round: this.round,
      ready: this.ready.has(pid),
      readyCount: this.ready.size,
      total: this.total(),
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, alive: this.alive.has(p.id), ready: this.ready.has(p.id),
        ally: iAmVamp && this.isVamp(p.id),              // vampirler birbirini bilir
      })),
      candidates: candidates.map(p => ({ id: p.id, name: p.name })),
      acted, actedCount, needed: this.alive.size,
      eventText: this.eventText,
      diedTonight: this.nightVictim === pid,       // gece vampirce öldürüldüyse yalnızca bu oyuncuda true
      votes: this.voteLines(),
      timeLeft: this.phase === 'DAY' ? Math.max(0, Math.round((this.dayEnd - Date.now()) / 1000)) : 0,
      winner: this.winner,
      // Roller yalnızca oyun BİTİNCE açıklanır
      roles: this.phase === 'GAME_OVER' ? Object.fromEntries(this.roles) : null,
    };
  }

  // Host için yerel çağrı, diğerleri için WebRTC
  send(pid, msg) {
    if (pid === session.id) onServerMessage(msg);
    else { const c = this.conns.get(pid); if (c && c.open) c.send(msg); }
  }
  sendState(pid) { this.send(pid, { t: 'state', view: this.viewFor(pid) }); }
  broadcastState() { this.players.forEach((_, id) => this.sendState(id)); }

  total() { return this.players.size; }

  // Vampir+Köylü toplam oyuncuyu aşmasın
  normalizeCfg(initial) {
    const n = this.total();
    if (initial) {
      this.cfg.vampire = 1;
      this.cfg.villager = Math.max(0, n - 1);
    }
    this.cfg.vampire = Math.max(1, Math.min(this.cfg.vampire, Math.max(1, n)));
    this.cfg.villager = Math.max(0, Math.min(this.cfg.villager, n - this.cfg.vampire));
  }

  lobbyState() {
    return { code: this.code, players: [...this.players.values()], cfg: { ...this.cfg } };
  }

  broadcastLobby() {
    const state = this.lobbyState();
    renderLobby(state);
    updateHostControls(state);
    this.conns.forEach(c => c.open && c.send({ t: 'lobby', state }));
  }
}

function updateHostControls(state) {
  const n = state.players.length, { vampire, villager } = state.cfg, sum = vampire + villager;
  $('cnt-vampire').textContent = vampire;
  $('cnt-villager').textContent = villager;
  document.querySelectorAll('.step').forEach(b => {
    const role = b.dataset.role, d = +b.dataset.d, cur = state.cfg[role];
    b.disabled = d < 0 ? cur <= (role === 'vampire' ? 1 : 0) : sum >= n;
  });
  const valid = n >= 3 && sum === n && vampire < villager;
  $('btn-start').disabled = !valid;
  $('cfg-hint').textContent =
    n < 3 ? 'En az 3 oyuncu gerekli.' :
    sum !== n ? `Toplam ${n} oyuncu: ${n - sum} rol daha dağıtmalısın.` :
    vampire >= villager ? 'Vampir sayısı Köylüden az olmalı.' : 'Hazır!';
}

/* =====================================================
 *  CLIENT
 * ===================================================== */
class Client {
  constructor(name, code, resume = false) {
    this.name = name; this.code = code;
    this.joined = resume;        // resume: sayfa yenilendi / sekmeye dönüldü, oyuna geri bağlanıyoruz
    this.gaveUp = false;
    this.retries = 0;
    this.lastData = 0;
    this.retryTimer = null;
    this.connTimer = null;
  }

  start() { this.connect(); }

  // (Yeniden) bağlan: aynı kalıcı id + isim ile 'join' gönderilir, Host rolü/durumu geri yollar
  connect() {
    if (this.gaveUp) return;
    clearTimeout(this.retryTimer); clearTimeout(this.connTimer);
    try { this.conn && this.conn.close(); } catch (e) {}
    try { this.peer && this.peer.destroy(); } catch (e) {}
    const peer = this.peer = new Peer();
    this.connTimer = setTimeout(() => { if (!this.conn || !this.conn.open) this.lost('timeout'); }, 5000);
    peer.on('open', () => {
      if (this.peer !== peer) return;
      const conn = this.conn = peer.connect(PREFIX + this.code, { reliable: true });
      conn.on('open', () => {
        clearTimeout(this.connTimer);
        this.retries = 0;
        conn.send({ t: 'join', id: session.id, name: this.name });
      });
      conn.on('data', (m) => this.onData(m));
      conn.on('close', () => { if (this.conn === conn) this.lost('close'); });
    });
    peer.on('error', (e) => { if (this.peer === peer) this.lost(e.type); });
  }

  lost(reason) {
    if (this.gaveUp) return;
    clearTimeout(this.connTimer);
    if (!this.joined) {      // ilk katılma denemesi başarısız
      this.gaveUp = true;
      return homeMsg(reason === 'peer-unavailable' ? 'Oda bulunamadı.' : 'Odaya ulaşılamadı.');
    }
    setOverlay(true);
    // Oda artık yok (Host kapattı): beklemeden çık
    if (reason === 'peer-unavailable') return this.giveUp('Oda kapatıldı veya bulunamadı.');
    if (++this.retries > 6) return this.giveUp('Host ile bağlantı kurulamadı.');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), 2000);
  }

  giveUp(msg) {
    this.gaveUp = true;
    clearTimeout(this.retryTimer); clearTimeout(this.connTimer);
    try { this.conn && this.conn.close(); } catch (e) {}
    try { this.peer && this.peer.destroy(); } catch (e) {}
    sessionStorage.removeItem('vk_room'); sessionStorage.removeItem('vk_role');
    myRole = null;
    setOverlay(false);
    document.body.className = '';
    showScreen('screen-home');
    homeMsg(msg);
  }

  // Sekmeye dönünce: bağlantı ölü mü diye yokla, gerekirse yeniden bağlan
  probe() {
    if (this.gaveUp || !this.joined) return;
    if (!this.conn || !this.conn.open) return this.connect();
    const t = Date.now();
    try { this.conn.send({ t: 'join', id: session.id, name: this.name }); } catch (e) { return this.connect(); }
    setTimeout(() => { if (this.lastData < t && !this.gaveUp) this.connect(); }, 3000);
  }

  onData(m) {
    this.lastData = Date.now();
    if (m.t === 'lobby' || m.t === 'state') {
      this.joined = true;
      sessionStorage.setItem('vk_room', this.code);
      setOverlay(false);
    }
    if (m.t === 'lobby') {
      document.body.className = '';
      waitingLobby = false; myRole = null; sessionStorage.removeItem('vk_role');
      showScreen('screen-lobby');
      $('host-config').classList.add('hidden');
      $('client-wait').classList.remove('hidden');
      renderLobby(m.state);
    } else if (m.t === 'state') {
      onServerMessage(m);
    } else if (m.t === 'joinError') {
      this.giveUp(m.reason);
    }
  }
}

/* ===== Mobil dayanıklılık: Wake Lock, beforeunload, overlay, haptik ===== */
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { console.warn('Wake Lock alınamadı:', e); }
}
function setOverlay(on) { $('reconnect-overlay').classList.toggle('hidden', !on); }

// Yanlışlıkla yenileme/kapatma uyarısı (yalnızca bir odadayken)
window.addEventListener('beforeunload', (e) => {
  if (host || (client && client.joined && !client.gaveUp)) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  acquireWakeLock();                       // sekme arka plana gidince kilit serbest kalır, geri al
  if (client) client.probe();              // bağlantı koptuysa otomatik yeniden bağlan
});
document.addEventListener('pointerdown', acquireWakeLock);   // bazı tarayıcılar kullanıcı etkileşimi ister
document.addEventListener('click', (e) => { if (e.target.closest('button')) buzz(15); });   // genel dokunma titreşimi

/* ===== Oyun durumu istemci tarafı (Host ve Client ortak kullanır) ===== */
const ROLE_LABEL = { vampire: '🧛 VAMPİR', villager: '🧑‍🌾 KÖYLÜ' };
const PHASE_LABEL = { ROLE_REVEAL: 'Roller dağıtıldı', NIGHT: '🌙 Gece', DAY: '☀️ Gündüz',
  VOTE_TRIAL: 'Yargılama oylaması', VOTE_EXECUTE: 'İnfaz oylaması', GAME_OVER: 'Oyun bitti' };
let myRole = sessionStorage.getItem('vk_role');   // önbellek; asıl kaynak Host'tur

let selKey = '', selected = null, deadline = 0, waitingLobby = false;

// Odadan ayrıl (lobi veya oyun sonu). Host ayrılırsa oda kapanır.
function leaveRoom() {
  if (host) {
    clearTimeout(host.timer);
    try { host.peer.destroy(); } catch (e) {}
    host = null;
    sessionStorage.removeItem('vk_role'); myRole = null; waitingLobby = false;
    document.body.className = '';
    showScreen('screen-home'); homeMsg('Odayı kapattın.', false);
  } else if (client) {
    const c = client;
    try { if (c.conn && c.conn.open) c.conn.send({ t: 'leave', id: session.id }); } catch (e) {}
    waitingLobby = false;
    setTimeout(() => c.giveUp('Odadan ayrıldın.'), 150);    // mesajın gitmesi için kısa bekleme
  }
}

function sendToHost(msg) {
  if (host) host.handleMessage(session.id, msg);
  else client.conn.send({ ...msg, id: session.id });
}

setInterval(() => {                      // gündüz sayacı
  const el = $('timer'); if (!el) return;
  const s = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 500);

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text != null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(text, cls, fn) { const b = el('button', text, 'btn ' + (cls || '')); b.onclick = fn; return b; }

function onServerMessage(m) {
  if (m.t !== 'state') return;
  const v = m.view;
  myRole = v.role;
  if (v.role) sessionStorage.setItem('vk_role', v.role);

  if (v.phase === 'ROLE_REVEAL') {
    sessionStorage.removeItem('vk_death');           // yeni oyun: animasyon kaydını sıfırla
    if (!v.ready) return showScreen('screen-role');
    showScreen('screen-wait');                       // onaylayanlar herkese görünür
    $('wait-count').textContent = `${v.readyCount}/${v.total} kişi onayladı`;
    $('wait-list').innerHTML = '';
    v.players.forEach(p => $('wait-list').appendChild(el('li', (p.ready ? '✅ ' : '⏳ ') + p.name)));
    return;
  }
  renderGame(v);
}

function playDeathAnimation() {
  if (document.getElementById('death-overlay')) return;
  const o = document.createElement('div');
  o.id = 'death-overlay';
  o.innerHTML = '<div class="death-bg"></div><div class="death-content"><div class="death-skull">💀</div><div class="death-text">ÖLDÜN</div></div>';
  document.body.appendChild(o);
  buzz([200, 80, 300]);
  const done = () => o.remove();
  o.querySelector('.death-content').addEventListener('animationend', done, { once: true });
  setTimeout(done, 3500);                   // emniyet: animationend gelmezse temizle
}

function renderGame(v) {
  showScreen('screen-game');
  if (v.diedTonight && sessionStorage.getItem('vk_death') !== String(v.round)) {
    sessionStorage.setItem('vk_death', String(v.round));    // aynı tur için tekrar oynatma (reconnect/yenileme)
    playDeathAnimation();
  }
  const key = v.phase + ':' + v.round;
  if (key !== selKey) { selKey = key; selected = null; }
  document.body.className = v.phase === 'NIGHT' ? 'night' : (['DAY', 'VOTE_TRIAL', 'VOTE_EXECUTE'].includes(v.phase) ? 'day' : '');
  $('phase-title').textContent = (PHASE_LABEL[v.phase] || v.phase) + (v.round ? ` · ${v.round}. tur` : '');
  $('game-info').textContent = '';
  const me = v.players.find(p => p.id === session.id);
  const body = $('game-body'); body.innerHTML = '';
  const waiting = () => {
    body.appendChild(el('p', `Diğerleri bekleniyor… (${v.actedCount}/${v.needed})`, 'msg'));
  };
  // Açık oylama akışı: kim kime oy verdi
  const showVotes = () => {
    if (!v.votes.length) return;
    body.appendChild(el('h2', 'Verilen oylar'));
    v.votes.forEach(t => body.appendChild(el('p', t, 'vote-line')));
  };

  // Seçim listesi + onay butonu (gece ve infaz için ortak)
  const picker = (title, btnText, onConfirm) => {
    body.appendChild(el('h2', title));
    const ul = el('div', null, 'pick-list');
    v.candidates.forEach(c => {
      const b = el('button', c.name, 'btn pick' + (selected === c.id ? ' sel' : ''));
      b.onclick = () => { selected = c.id; buzz(); renderGame(v); };
      ul.appendChild(b);
    });
    body.appendChild(ul);
    const ok = button(btnText, 'primary', () => { buzz([30, 40, 30]); onConfirm(selected); });
    ok.disabled = !selected;
    body.appendChild(ok);
  };

  if (v.phase === 'NIGHT') {
    if (v.eventText) body.appendChild(el('p', v.eventText, 'banner'));
    if (!me.alive) body.appendChild(el('p', '💀 Öldün. Gece geçiyor…', 'msg'));
    else if (v.acted) { body.appendChild(el('p', '💤 Uyudun.', 'big')); waiting(); }
    else picker(myRole === 'vampire' ? 'Kimi öldüreceksin?' : 'Sence bu gece kim ölecek?', 'Onayla ve Uyu',
      (t) => sendToHost({ t: 'nightConfirm', target: t }));    // köylü seçimi sahte, host atar
  }
  else if (v.phase === 'DAY') {
    if (v.eventText) body.appendChild(el('p', v.eventText, 'banner'));
    body.appendChild(el('p', 'Serbest tartışma', 'msg'));
    body.appendChild(el('div', '', 'timer')).id = 'timer';
    deadline = Date.now() + v.timeLeft * 1000;
    if (host) body.appendChild(button('Tartışmayı Bitir', '', () => sendToHost({ t: 'skipDay' })));
  }
  else if (v.phase === 'VOTE_TRIAL') {
    if (!me.alive) body.appendChild(el('p', '💀 Ölüler oy kullanamaz.', 'msg'));
    else if (v.acted) { body.appendChild(el('p', 'Oyun alındı ✔', 'big')); waiting(); }
    else {
      body.appendChild(el('p', 'Bugün kasabada yargılama yapılsın mı?', 'big'));
      body.appendChild(button('✅ Evet', 'primary', () => { buzz(); sendToHost({ t: 'trialVote', vote: true }); }));
      body.appendChild(button('❌ Hayır', '', () => { buzz(); sendToHost({ t: 'trialVote', vote: false }); }));
    }
    showVotes();
  }
  else if (v.phase === 'VOTE_EXECUTE') {
    if (v.eventText) body.appendChild(el('p', v.eventText, 'banner'));
    if (!me.alive) body.appendChild(el('p', '💀 Ölüler oy kullanamaz.', 'msg'));
    else if (v.acted) { body.appendChild(el('p', 'Oyun alındı ✔', 'big')); waiting(); }
    else picker('Kimi asalım?', 'Oyu Onayla', (t) => sendToHost({ t: 'execVote', target: t }));
    showVotes();
  }
  else if (v.phase === 'GAME_OVER') {
    if (v.eventText) body.appendChild(el('p', v.eventText, 'banner'));
    body.appendChild(el('p', v.winner === 'villager' ? '🎉 Köylüler kazandı!' : '🧛 Vampirler kazandı!', 'big'));
    v.players.forEach(p => body.appendChild(
      el('p', `${p.name}: ${ROLE_LABEL[v.roles[p.id]]}${p.alive ? '' : ' 💀'}`, 'msg')));
    // Oyun sonu: lobiye dön / odadan ayrıl
    if (host) body.appendChild(button('🏠 Lobiye Dön', 'primary', () => sendToHost({ t: 'backToLobby' })));
    else if (waitingLobby) body.appendChild(el('p', 'Host lobiyi açınca otomatik geçilecek…', 'msg'));
    else body.appendChild(button('🏠 Lobiye Dön', 'primary', () => { waitingLobby = true; renderGame(v); }));
    body.appendChild(button('🚪 Odadan Ayrıl', '', leaveRoom));
  }

  // Host: takılan oyuncuları atlama
  if (host && ['NIGHT', 'VOTE_TRIAL', 'VOTE_EXECUTE'].includes(v.phase) && v.actedCount < v.needed) {
    body.appendChild(button('Bekleyenleri atla (Host)', 'small', () => sendToHost({ t: 'force' })));
  }

  $('game-players').innerHTML = '';
  v.players.forEach(p => {
    // Ölenin rolü ASLA gösterilmez (yalnızca oyun bitince, yukarıda)
    const li = el('li', p.name + (p.ally ? ' 🧛' : '') + (p.alive ? '' : ' 💀'), p.alive ? '' : 'dead');
    $('game-players').appendChild(li);
  });
}

// Basılı tutunca rolü göster, bırakınca gizle
function holdToReveal(cardId, textId, hiddenText) {
  const card = $(cardId), txt = $(textId);
  const show = (e) => { e.preventDefault(); if (!myRole) return;
    txt.textContent = ROLE_LABEL[myRole]; card.classList.add('show', myRole); };
  const hide = () => { txt.textContent = hiddenText; card.classList.remove('show', 'vampire', 'villager'); };
  card.addEventListener('pointerdown', show);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => card.addEventListener(ev, hide));
  card.addEventListener('contextmenu', e => e.preventDefault());
}
holdToReveal('role-card', 'role-text', 'Görmek için basılı tut');
holdToReveal('role-card-mini', 'role-text-mini', 'Rolün için basılı tut');

$('btn-ready').onclick = () => {
  $('role-text').textContent = 'Görmek için basılı tut';
  sendToHost({ t: 'ready' });
};

/* ===== UI bağlama ===== */
let host = null, client = null;

$('inp-name').value = session.name;

function getName() {
  const n = $('inp-name').value.trim();
  if (!n) { homeMsg('Lütfen isim gir.'); return null; }
  session.name = n;
  return n;
}

$('btn-create').onclick = () => {
  const n = getName(); if (!n) return;
  sessionStorage.removeItem('vk_room'); sessionStorage.removeItem('vk_role'); myRole = null;
  acquireWakeLock();
  homeMsg('Oda kuruluyor…', false);
  host = new Host(n); host.start();
};

$('btn-join').onclick = () => {
  const n = getName(); if (!n) return;
  const code = $('inp-code').value.trim();
  if (!/^\d{4,5}$/.test(code)) return homeMsg('Geçerli bir oda kodu gir (4-5 hane).');
  sessionStorage.removeItem('vk_role'); myRole = null;
  acquireWakeLock();
  homeMsg('Bağlanılıyor…', false);
  client = new Client(n, code); client.start();
};

$('btn-leave').onclick = () => { if (client) client.giveUp('Odadan ayrıldın.'); };
$('btn-leave-lobby').onclick = leaveRoom;

// Sayfa yenilendiyse / yeniden açıldıysa: aynı isim, id ve oda ile otomatik geri bağlan
(function autoResume() {
  const room = sessionStorage.getItem('vk_room');
  if (room && session.name) {
    setOverlay(true);
    client = new Client(session.name, room, true);
    client.start();
  }
})();

// Host'un kendi hamleleri: WebRTC yok, doğrudan motora
document.querySelectorAll('.step').forEach(b => b.onclick = () => {
  const role = b.dataset.role;
  host.handleMessage(session.id, { t: 'setCfg', role, value: host.cfg[role] + (+b.dataset.d) });
});
$('btn-start').onclick = () => host.handleMessage(session.id, { t: 'startGame' });

