'use strict';
/* ===== Adım 1: PeerJS Host/Client iskeleti + Lobi ===== */

const PREFIX = 'vampirkoy-';          // Public PeerJS sunucusunda çakışmayı azaltır
const $ = (id) => document.getElementById(id);
const DAY_MS = 120 * 1000;               // gündüz tartışma süresi (test için düşürebilirsin)
const buzz = (ms = 20) => { if (navigator.vibrate) navigator.vibrate(ms); };

// Güvenli rastgelelik: crypto.getRandomValues (yoksa Math.random'a düşer). [0,1) aralığında 53 bit
function secureRandom() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return ((a[0] >>> 5) * 67108864 + (a[1] >>> 6)) / 9007199254740992;
  } catch (e) { return Math.random(); }
}
// Önyargısız Fisher-Yates karıştırma
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(secureRandom() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const REPEAT_WEIGHT = 0.35;   // aynı özel rolün üst üste gelme çarpanı (streak başına)
const DROUGHT_BONUS = 0.35;   // üst üste köylü kalan oyuncuya özel rol ağırlık bonusu

// --- Kalıcı kimlik (Adım 4'te reconnect için kullanılacak) ---
/* ===== Rol tanımları ===== */
const SPECIAL_ROLES = ['vampire', 'forger', 'doctor', 'bodyguard', 'vigilante', 'medium', 'investigator', 'tracker', 'jester'];
const VAMP_TEAM = ['vampire', 'forger'];
const TOWN_TEAM = ['villager', 'doctor', 'bodyguard', 'vigilante', 'medium', 'investigator', 'tracker'];
// Gece davranış türü: 'fake' = gerçek yeteneği yok, ekranda sahte tahmin listesi görür (anti-meta)
const ROLE_KIND = { vampire: 'kill', forger: 'forge', doctor: 'heal', bodyguard: 'guard', vigilante: 'shoot',
  medium: 'fake', investigator: 'investigate', tracker: 'track', villager: 'fake', jester: 'fake' };
const REAL_KINDS = ['kill', 'forge', 'heal', 'guard', 'shoot', 'investigate', 'track'];
const ROLE_LABEL = { vampire: '🧛 VAMPİR', forger: '🖋️ SAHTECİ', doctor: '🩺 DOKTOR', bodyguard: '🛡️ KORUMA',
  vigilante: '🔫 İNFAZCI', medium: '🔮 MEDYUM', investigator: '🔍 ARAŞTIRMACI', tracker: '👣 İZ SÜRÜCÜ',
  jester: '🃏 SOYTARI', villager: '🧑‍🌾 KÖYLÜ' };
const ROLE_NAME = { vampire: 'Vampir', forger: 'Sahteci', doctor: 'Doktor', bodyguard: 'Koruma', vigilante: 'İnfazcı',
  medium: 'Medyum', investigator: 'Araştırmacı', tracker: 'İz Sürücü', jester: 'Soytarı', villager: 'Köylü' };
const ROLE_DESC = {
  vampire: 'Her gece vampir takımıyla birlikte bir kişiyi öldür. Takımın, kasabadan fazla veya eşit olunca kazanırsın.',
  forger: 'Vampir takımındasın ama öldüremezsin. Gece bir hedef seç ve onun için sahte vasiyetname yaz. Hedef o gece ölürse kasaba senin yazdığını okur.',
  doctor: 'Her gece birini koru (kendini de). Üst üste iki gece aynı kişiyi koruyamazsın.',
  bodyguard: 'Gece birini koru (kendini koruyamazsın). Hedefe saldırı olursa saldıranı öldürür, sen de ölürsün.',
  vigilante: 'Gece birini gizlice vurabilirsin (sınırlı mermi). Masum bir kasabalıyı öldürürsen ertesi gün vicdan azabından intihar edersin.',
  medium: 'Geceleri Mezarlık sohbetinde ölülerle konuş, öğrendiklerini gündüz kasabaya aktar.',
  investigator: 'Gece bir hedef seç; sabah hedefin hangi 3 rolden biri olabileceğini öğren.',
  tracker: 'Gece bir hedef seç; sabah hedefin o gece kimi ziyaret ettiğini öğren.',
  jester: 'Amacın gündüz infaz oylamasında asılmak. Asılırsan tek başına kazanırsın; gece öldürülürsen kaybedersin.',
  villager: 'Özel yeteneğin yok. Tartış, oy kullan ve kasabayı vampirlerden kurtar.',
};

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
  $('cfg-view').textContent = SPECIAL_ROLES.concat('villager').filter(r => state.cfg[r] > 0).map(r => `${ROLE_LABEL[r]}: ${state.cfg[r]}`).join(' · ') + (state.cfg.vigilante > 0 ? ` · 🔫 Mermi: ${state.cfg.bullets}` : '');
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
    this.cfg = { vampire: 1, forger: 0, doctor: 0, bodyguard: 0, vigilante: 0, medium: 0, investigator: 0,
      tracker: 0, jester: 0, villager: 2, bullets: 1 };
    this.roleHistory = new Map();    // oyuncu id -> { lastRole, streak, villagerStreak }
    this.lastProtected = new Map();  // doktor id -> bir önceki gece koruduğu kişi (üst üste aynı kişi yasak)
    // --- Oyun motoru durumu (roller yalnızca burada, asla broadcast edilmez) ---
    this.phase = 'LOBBY';
    this.gameStarted = false;
    this.roles = new Map();     // playerId -> rol anahtarı (ROLE_LABEL)
    this.alive = new Set();
    this.ready = new Set();
    this.round = 0;
    this.nightChoices = new Map();   // pid -> hedef
    this.nightTexts = new Map();     // pid -> metin (Sahteci'nin sahte vasiyeti)
    this.trialVotes = new Map();     // pid -> true/false
    this.execVotes = new Map();      // pid -> hedef
    this.eventText = null;           // son olay duyurusu (rol İÇERMEZ)
    this.deathWills = [];            // sabah/infaz sonrası yayınlanan vasiyetnameler [{name,text}]
    this.wills = new Map();          // pid -> gerçek vasiyetname
    this.notes = new Map();          // pid -> özel bilgi notları (Araştırmacı, İz Sürücü)
    this.bullets = new Map();        // infazcı id -> kalan mermi
    this.guilty = new Set();         // masum vuran, bir sonraki gece intihar edecek infazcılar
    this.invGroup = new Map();       // hedef id -> Araştırmacı'ya gösterilen 3 rol (tutarlı kalsın diye saklanır)
    this.graveChat = [];             // Mezarlık sohbeti [{from,text,dead}]
    this.winner = null;
    this.nightDead = new Set();      // yalnızca bu gece ölenlere ölüm animasyonu gösterilir
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
        const norm = (s) => String(s || '').trim().toLocaleLowerCase('tr');
        if (!existing && [...this.players.values()].some(p => norm(p.name) === norm(msg.name))) {
          return conn && conn.send({ t: 'joinError', reason: 'Bu isim odada zaten kullanılıyor. Başka bir isim seç.' });
        }
        if (existing) { existing.online = true; }
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
        if (typeof msg.text === 'string') this.nightTexts.set(pid, msg.text.slice(0, 300));
        if (this.allActed(this.nightChoices)) this.resolveNight(); else this.broadcastState();
        break;
      case 'will':                                    // vasiyetname: yalnızca hayattayken, her an düzenlenebilir
        if (!this.gameStarted || this.phase === 'GAME_OVER' || !this.alive.has(pid)) return;
        this.wills.set(pid, String(msg.text || '').slice(0, 400));
        this.sendState(pid);
        break;
      case 'grave': {                                 // Mezarlık sohbeti: yalnızca geceleri, ölüler ve canlı Medyum
        if (this.phase !== 'NIGHT') return;
        const isAlive = this.alive.has(pid);
        if (isAlive && this.roles.get(pid) !== 'medium') return;   // sahte panel: mesaj yutulur
        const text = String(msg.text || '').trim().slice(0, 120);
        if (!text) return;
        this.graveChat.push({ from: isAlive ? 'Medyum' : this.nameOf(pid), text, dead: !isAlive });
        if (this.graveChat.length > 200) this.graveChat.shift();
        this.broadcastState();
        break;
      }
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
        if (!SPECIAL_ROLES.includes(msg.role) && msg.role !== 'bullets') return;
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
    if (to === 'NIGHT') { this.round++; this.nightChoices.clear(); this.nightTexts.clear(); this.nightDead.clear(); }
    else if (to === 'DAY') {
      this.dayEnd = Date.now() + DAY_MS;
      this.timer = setTimeout(() => this.transition('VOTE_TRIAL'), DAY_MS);
    }
    else if (to === 'VOTE_TRIAL') this.trialVotes.clear();
    else if (to === 'VOTE_EXECUTE') this.execVotes.clear();
    this.broadcastState();
  }

  /* ---------- Oyun kuralları ---------- */
  isVamp(id) { return VAMP_TEAM.includes(this.roles.get(id)); }          // vampir takımı (Vampir + Sahteci)
  isKiller(id) { return this.roles.get(id) === 'vampire'; }              // öldürme yetkisi olan
  isDoctor(id) { return this.roles.get(id) === 'doctor'; }
  isTown(id) { return TOWN_TEAM.includes(this.roles.get(id)); }
  nameOf(id) { return this.players.get(id).name; }
  allActed(map) { return [...this.alive].every(id => map.has(id)); }

  // Gece davranışı: mermisi biten infazcı artık "sahte" kullanıcıdır
  kindOf(id) {
    const k = ROLE_KIND[this.roles.get(id)] || 'fake';
    return (k === 'shoot' && !(this.bullets.get(id) > 0)) ? 'fake' : k;
  }

  // Bu oyuncunun gece seçebileceği hedefler (hem arayüz hem çözücü aynı kuralı kullanır)
  targetsFor(id) {
    const alive = [...this.alive];
    switch (this.kindOf(id)) {
      case 'kill': case 'forge': return alive.filter(x => !this.isVamp(x));
      case 'heal': return alive.filter(x => this.lastProtected.get(id) !== x);   // kendini de koruyabilir
      default: return alive.filter(x => x !== id);                               // koruma, infazcı, araştırmacı, iz sürücü, sahte
    }
  }

  addNote(pid, text) {
    if (!this.notes.has(pid)) this.notes.set(pid, []);
    this.notes.get(pid).push(`Gece ${this.round}: ${text}`);
  }

  // Araştırmacı: gerçek rol + 2 sahte rolden oluşan 3'lü grup (hedef başına sabit)
  groupFor(t) {
    if (!this.invGroup.has(t)) {
      const truth = this.roles.get(t);
      let others = shuffle([...new Set(this.roles.values())].filter(r => r !== truth));
      if (others.length < 2) others = others.concat(shuffle(Object.keys(ROLE_NAME).filter(r => r !== truth && !others.includes(r))));
      this.invGroup.set(t, shuffle([truth, ...others.slice(0, 2)]));
    }
    return this.invGroup.get(t);
  }

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

  /* Gece çözümü (öncelik sırası):
   *  1) İz Sürücü izler  2) Koruma/Doktor korur  3) Vampir & İnfazcı saldırır
   *  4) Sahteci sahte vasiyeti kurbana enjekte eder  5) Ölümler + vasiyetnameler sabaha yansır */
  resolveNight() {
    const aliveIds = [...this.alive];
    const withKind = (k) => aliveIds.filter(id => this.kindOf(id) === k);
    const deaths = new Map();                       // id -> sebep

    // Önceki gece masum vuran infazcılar vicdan azabından intihar eder
    this.guilty.forEach(id => { if (this.alive.has(id)) deaths.set(id, 'guilt'); });
    this.guilty.clear();

    // 0) Geçerli gerçek hamleler (hedef kuralları sunucuda yeniden doğrulanır; sahte seçimler atılır)
    const act = new Map();
    aliveIds.forEach(id => {
      if (!REAL_KINDS.includes(this.kindOf(id))) return;
      const t = this.nightChoices.get(id);
      if (t && this.targetsFor(id).includes(t)) act.set(id, t);
    });
    withKind('heal').forEach(id => {                // Doktor: üst üste aynı kişi yasağı
      if (act.has(id)) this.lastProtected.set(id, act.get(id)); else this.lastProtected.delete(id);
    });

    // 1) İz Sürücü + Araştırmacı bilgileri
    withKind('track').forEach(id => {
      if (!act.has(id)) return;
      const t = act.get(id), visited = act.get(t);
      this.addNote(id, visited
        ? `${this.nameOf(t)} dün gece ${this.nameOf(visited)} oyuncusunu ziyaret etti.`
        : `${this.nameOf(t)} dün gece kimseyi ziyaret etmedi.`);
    });
    withKind('investigate').forEach(id => {
      if (!act.has(id)) return;
      const t = act.get(id), g = this.groupFor(t).map(r => ROLE_NAME[r]);
      this.addNote(id, `${this.nameOf(t)} şunlardan biri olabilir: ${g.slice(0, -1).join(', ')} veya ${g[g.length - 1]}.`);
    });

    // 2) Koruma (Bodyguard) ve Doktor
    const guards = withKind('guard').filter(id => act.has(id)).map(id => ({ id, t: act.get(id), used: false }));
    const healed = new Set(withKind('heal').filter(id => act.has(id)).map(id => act.get(id)));

    // 3) Saldırılar: Vampir (ortak tek kurban) + İnfazcılar
    const attacks = [];
    const killers = withKind('kill');
    if (killers.length) {
      const votes = killers.filter(id => act.has(id)).map(id => act.get(id));
      let pool = this.tally(votes)[0];
      if (!pool.length) pool = aliveIds.filter(id => !this.isVamp(id));          // kimse seçmediyse rastgele
      if (pool.length) {
        const victim = pool[Math.floor(secureRandom() * pool.length)];
        const voters = killers.filter(id => act.get(id) === victim);
        const src = voters.length ? voters : killers;
        attacks.push({ attacker: src[Math.floor(secureRandom() * src.length)], target: victim, kind: 'kill' });
      }
    }
    withKind('shoot').forEach(id => {
      if (!act.has(id)) return;
      attacks.push({ attacker: id, target: act.get(id), kind: 'shoot' });
      this.bullets.set(id, (this.bullets.get(id) || 0) - 1);
    });
    const guiltNew = [];
    attacks.forEach(a => {
      const g = guards.find(x => !x.used && x.t === a.target && !deaths.has(x.id));
      if (g) {                                       // Koruma saldıranı öldürür, kendisi de şehit olur
        g.used = true;
        if (!deaths.has(a.attacker)) deaths.set(a.attacker, 'bg');
        if (!deaths.has(g.id)) deaths.set(g.id, 'bg');
        return;
      }
      if (healed.has(a.target)) return;              // Doktor kurtardı
      if (!deaths.has(a.target)) deaths.set(a.target, 'attack');
      if (a.kind === 'shoot' && this.isTown(a.target)) guiltNew.push(a.attacker);
    });
    guiltNew.forEach(id => { if (!deaths.has(id)) this.guilty.add(id); });

    // 4) Sahteci: hedefi o gece ölürse gerçek vasiyet yerine sahte metin yayınlanır
    const forged = new Map();
    withKind('forge').forEach(id => {
      if (!act.has(id)) return;
      const t = act.get(id), text = (this.nightTexts.get(id) || '').trim();
      if (text && deaths.has(t) && !forged.has(t)) forged.set(t, text);
    });

    // 5) Ölümleri uygula, vasiyetnameleri yayınla (ölüm sırası karıştırılır: kimin kimi öldürdüğü sızmasın)
    this.nightDead = new Set(deaths.keys());
    this.deathWills = [];
    const lines = [];
    shuffle([...deaths.keys()]).forEach(id => {
      this.alive.delete(id);
      const nm = this.nameOf(id);
      lines.push(deaths.get(id) === 'guilt' ? `💔 ${nm} vicdan azabından intihar etti.` : `🌙 Bu gece ${nm} öldürüldü.`);
      this.deathWills.push({ name: nm, text: forged.has(id) ? forged.get(id) : (this.wills.get(id) || '') });
    });
    this.eventText = lines.length ? lines.join('\n') : '🌙 Bu gece kimse ölmedi.';
    if (!this.checkWin()) this.transition('DAY');
  }

  resolveTrial() {
    let yes = 0, no = 0;
    this.trialVotes.forEach(v => v ? yes++ : no++);
    this.deathWills = [];
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
    this.deathWills = [];
    if (top.length !== 1 || n === 0) {
      this.eventText = '⚖️ Oylar eşit çıktı, kimse asılmadı.' + lines;
      return this.transition('NIGHT');
    }
    const id = top[0];
    this.alive.delete(id);
    this.eventText = `⚖️ ${this.nameOf(id)} kasabadan asıldı.` + lines;      // rol açıklanmaz
    this.deathWills = [{ name: this.nameOf(id), text: this.wills.get(id) || '' }];
    if (this.roles.get(id) === 'jester') {          // Soytarı asıldı: tek başına kazanır
      this.winner = 'jester';
      return this.transition('GAME_OVER');
    }
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

  clearGameState() {
    this.roles.clear(); this.alive.clear(); this.ready.clear();
    this.nightChoices.clear(); this.nightTexts.clear(); this.trialVotes.clear(); this.execVotes.clear();
    this.lastProtected.clear(); this.wills.clear(); this.notes.clear(); this.bullets.clear();
    this.guilty.clear(); this.invGroup.clear(); this.graveChat = []; this.nightDead.clear(); this.deathWills = [];
    this.round = 0; this.eventText = null; this.winner = null;
  }

  // Oyun bitti → herkesi aynı odanın lobisine döndür (bağlantısı kopanlar listeden çıkar)
  resetToLobby() {
    clearTimeout(this.timer);
    [...this.players].forEach(([id, p]) => { if (!p.online) this.players.delete(id); });
    this.phase = 'LOBBY';
    this.gameStarted = false;
    this.clearGameState();
    this.normalizeCfg(true);
    document.body.className = '';
    sessionStorage.removeItem('vk_role'); myRole = null;
    showScreen('screen-lobby');
    $('host-config').classList.remove('hidden');
    $('client-wait').classList.add('hidden');
    this.broadcastLobby();
  }

  startGame() {
    this.normalizeCfg(false);
    const n = this.total(), cfg = this.cfg;
    const sum = SPECIAL_ROLES.reduce((a, r) => a + cfg[r], 0), team = cfg.vampire + cfg.forger;
    if (n < 3 || cfg.vampire < 1 || sum > n || team >= n - team) return;
    const ids = [...this.players.keys()];
    this.clearGameState();
    // Rol dağıtımı: kriptografik rastgelelik + seri önleme + köylü kuraklığı telafisi.
    // Aynı özel rolün üst üste gelme olasılığı katlanarak düşer (asla 0 olmaz, tahmin edilemez).
    // Üst üste köylü kalan oyuncuların özel rol alma ağırlığı artar.
    const assigned = new Map();
    const pool = shuffle([...ids]);
    const draw = (role, count) => {
      for (let k = 0; k < count && pool.length; k++) {
        const w = pool.map(id => {
          const h = this.roleHistory.get(id);
          if (!h) return 1;
          if (h.lastRole === role) return Math.pow(REPEAT_WEIGHT, h.streak);
          if (h.lastRole === 'villager') return 1 + DROUGHT_BONUS * h.villagerStreak;
          return 0.75; // geçen el başka bir özel roldeydi
        });
        let r = secureRandom() * w.reduce((a, b) => a + b, 0), idx = 0;
        while (idx < w.length - 1 && r >= w[idx]) { r -= w[idx]; idx++; }
        assigned.set(pool[idx], role);
        pool.splice(idx, 1);
      }
    };
    shuffle(SPECIAL_ROLES.filter(r => cfg[r] > 0).map(r => [r, cfg[r]])).forEach(([role, cnt]) => draw(role, cnt));
    pool.forEach(id => assigned.set(id, 'villager'));
    shuffle(ids).forEach(id => {
      const role = assigned.get(id);
      this.roles.set(id, role);
      this.alive.add(id);
      if (role === 'vigilante') this.bullets.set(id, cfg.bullets);
      const prev = this.roleHistory.get(id);
      this.roleHistory.set(id, {
        lastRole: role,
        streak: prev && prev.lastRole === role ? prev.streak + 1 : 1,
        villagerStreak: role === 'villager' ? ((prev ? prev.villagerStreak : 0) + 1) : 0,
      });
    });
    this.gameStarted = true;
    this.transition('ROLE_REVEAL');
  }

  // Her oyuncuya YALNIZCA kendi rolünü içeren görünüm gönderilir
  viewFor(pid) {
    const role = this.roles.get(pid) || null;
    const iAmVamp = !!role && VAMP_TEAM.includes(role);
    const meAlive = this.alive.has(pid);
    const alive = [...this.players.values()].filter(p => this.alive.has(p.id));
    let candidates = [], acted = false, actedCount = 0, kind = null, skip = false, needsText = false;
    if (this.phase === 'NIGHT') {
      // Gerçek yeteneği olanlar gerçek hedef listesi, diğerleri sahte "kim ölecek?" listesi görür (anti-meta)
      if (meAlive) {
        kind = this.kindOf(pid);
        candidates = this.targetsFor(pid).map(id => ({ id, name: this.nameOf(id) }));
        skip = kind === 'fake' || kind === 'shoot';
        needsText = kind === 'forge';
      }
      acted = this.nightChoices.has(pid); actedCount = this.nightChoices.size;
    } else if (this.phase === 'VOTE_TRIAL') {
      acted = this.trialVotes.has(pid); actedCount = this.trialVotes.size;
    } else if (this.phase === 'VOTE_EXECUTE') {
      candidates = alive.filter(p => p.id !== pid).map(p => ({ id: p.id, name: p.name }));
      acted = this.execVotes.has(pid); actedCount = this.execVotes.size;
    }
    // Mezarlık: ölüler ve canlı Medyum gerçek sohbeti görür; diğerleri için null (sahte panel)
    let graveChat = null, graveCanPost = false;
    if (this.gameStarted && (!meAlive || role === 'medium')) {
      graveChat = this.graveChat.slice(-100);
      graveCanPost = this.phase === 'NIGHT';
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
        ally: iAmVamp && this.isVamp(p.id),              // vampir takımı birbirini bilir
      })),
      candidates, kind, skip, needsText,
      bullets: this.bullets.get(pid) || 0,
      acted, actedCount, needed: this.alive.size,
      eventText: this.eventText,
      deathWills: this.deathWills.map(w => ({ ...w })),
      myWill: this.wills.get(pid) || '',
      notes: (this.notes.get(pid) || []).slice(),
      graveChat, graveCanPost,
      diedTonight: this.nightDead.has(pid),        // yalnızca gece ölen oyuncuda true
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

  // Rol sayıları oyuncu sayısını aşmasın; Köylü = kalan (otomatik)
  normalizeCfg(initial) {
    const n = this.total(), cfg = this.cfg;
    if (initial) { SPECIAL_ROLES.forEach(r => cfg[r] = 0); cfg.vampire = 1; cfg.bullets = 1; }
    SPECIAL_ROLES.forEach(r => cfg[r] = Math.max(0, Math.floor(+cfg[r] || 0)));
    cfg.vampire = Math.max(1, cfg.vampire);
    cfg.bullets = cfg.bullets >= 2 ? 2 : 1;
    let over = SPECIAL_ROLES.reduce((a, r) => a + cfg[r], 0) - n;
    for (let i = SPECIAL_ROLES.length - 1; over > 0 && i >= 0; i--) {
      const r = SPECIAL_ROLES[i], cut = Math.min(over, cfg[r] - (r === 'vampire' ? 1 : 0));
      cfg[r] -= cut; over -= cut;
    }
    cfg.villager = Math.max(0, n - SPECIAL_ROLES.reduce((a, r) => a + cfg[r], 0));
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

// Lobi: her özel rol için +/- satırı (Köylü otomatik hesaplanır)
function buildRoleSteppers() {
  const box = $('role-steppers'); box.innerHTML = '';
  const mkRow = (role, label, buttons) => {
    const d = el('div', null, 'stepper-row');
    d.appendChild(el('label', label));
    if (buttons) { const m = el('button', '−', 'step'); m.dataset.role = role; m.dataset.d = '-1'; d.appendChild(m); }
    const s = el('span', '0'); s.id = 'cnt-' + role; d.appendChild(s);
    if (buttons) { const p = el('button', '+', 'step'); p.dataset.role = role; p.dataset.d = '1'; d.appendChild(p); }
    return d;
  };
  SPECIAL_ROLES.forEach(r => box.appendChild(mkRow(r, ROLE_LABEL[r], true)));
  const b = mkRow('bullets', '🔫 İnfazcı mermisi', true); b.id = 'row-bullets'; box.appendChild(b);
  box.appendChild(mkRow('villager', ROLE_LABEL.villager + ' (kalan)', false));
}

function updateHostControls(state) {
  const n = state.players.length, cfg = state.cfg;
  const sum = SPECIAL_ROLES.reduce((a, r) => a + cfg[r], 0), team = cfg.vampire + cfg.forger;
  SPECIAL_ROLES.concat(['villager', 'bullets']).forEach(r => { const e = $('cnt-' + r); if (e) e.textContent = cfg[r]; });
  $('row-bullets').classList.toggle('hidden', cfg.vigilante < 1);
  document.querySelectorAll('.step').forEach(b => {
    const role = b.dataset.role, d = +b.dataset.d, cur = cfg[role];
    if (role === 'bullets') b.disabled = d < 0 ? cur <= 1 : cur >= 2;
    else b.disabled = d < 0 ? cur <= (role === 'vampire' ? 1 : 0) : sum >= n;
  });
  const valid = n >= 3 && cfg.vampire >= 1 && sum <= n && team < n - team;
  $('btn-start').disabled = !valid;
  $('cfg-hint').textContent =
    n < 3 ? 'En az 3 oyuncu gerekli.' :
    team >= n - team ? 'Vampir takımı (Vampir + Sahteci) diğer oyunculardan az olmalı.' :
    `Hazır! (${cfg.villager} köylü)`;
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
    sessionStorage.removeItem('vk_phase');
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

// Gece (hilal) / sabah (güneş) geçiş animasyonu: ~1 sn ekranda kalır
function playPhaseAnimation(kind) {
  const old = document.getElementById('phase-overlay'); if (old) old.remove();
  const o = document.createElement('div');
  o.id = 'phase-overlay'; o.className = kind;
  o.innerHTML = '<div class="phase-icon">' + (kind === 'moon' ? '🌙' : '☀️') + '</div>';
  document.body.appendChild(o);
  const done = () => o.remove();
  o.addEventListener('animationend', done, { once: true });
  setTimeout(done, 2500);                   // emniyet
}

let lastView = null, forgeDraft = '';

function renderGame(v) {
  showScreen('screen-game');
  lastView = v;
  if (v.diedTonight && sessionStorage.getItem('vk_death') !== String(v.round)) {
    sessionStorage.setItem('vk_death', String(v.round));    // aynı tur için tekrar oynatma (reconnect/yenileme)
    playDeathAnimation();
  }
  const meAlive = (v.players.find(p => p.id === session.id) || {}).alive;
  const phaseKey = v.phase + ':' + v.round;
  if ((v.phase === 'NIGHT' || (v.phase === 'DAY' && meAlive && !v.diedTonight)) && sessionStorage.getItem('vk_phase') !== phaseKey) {
    sessionStorage.setItem('vk_phase', phaseKey);                // aynı faz için tekrar oynatma (reconnect/yenileme)
    playPhaseAnimation(v.phase === 'NIGHT' ? 'moon' : 'sun');
  }
  const key = v.phase + ':' + v.round;
  if (key !== selKey) { selKey = key; selected = null; forgeDraft = ''; }
  document.body.className = v.phase === 'NIGHT' ? 'night' : (['DAY', 'VOTE_TRIAL', 'VOTE_EXECUTE'].includes(v.phase) ? 'day' : '');
  $('phase-title').textContent = (PHASE_LABEL[v.phase] || v.phase) + (v.round ? ` · ${v.round}. tur` : '');
  $('game-info').textContent = '';
  const me = v.players.find(p => p.id === session.id);
  updateTools(v, me);
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
  // Olay duyurusu + ölenlerin vasiyetnameleri (herkese açık)
  const banner = () => {
    if (v.eventText) body.appendChild(el('p', v.eventText, 'banner'));
    v.deathWills.forEach(w => {
      const c = el('div', null, 'will-card');
      c.appendChild(el('h3', `📜 ${w.name} — Vasiyetname`));
      c.appendChild(el('p', w.text.trim() || 'Vasiyetname bırakmadı.'));
      body.appendChild(c);
    });
  };
  // Özel bilgiler (Araştırmacı / İz Sürücü sonuçları) yalnızca sahibine gelir
  const notes = () => {
    if (!v.notes.length) return;
    const c = el('div', null, 'notes-card');
    c.appendChild(el('h3', '🔎 Bilgilerim'));
    v.notes.forEach(n => c.appendChild(el('p', n)));
    body.appendChild(c);
  };

  // Seçim listesi + onay butonu (gece ve infaz için ortak)
  const picker = (title, btnText, onConfirm, opts = {}) => {
    body.appendChild(el('h2', title));
    const ul = el('div', null, 'pick-list');
    const list = opts.skip ? v.candidates.concat([{ id: 'skip', name: '🚫 Kimse' }]) : v.candidates;
    list.forEach(c => {
      const b = el('button', c.name, 'btn pick' + (selected === c.id ? ' sel' : ''));
      b.onclick = () => { selected = c.id; buzz(); renderGame(v); };
      ul.appendChild(b);
    });
    body.appendChild(ul);
    const ok = button(btnText, 'primary', () => { buzz([30, 40, 30]); onConfirm(selected); });
    const refresh = () => { ok.disabled = !selected || (opts.text && !forgeDraft.trim()); };
    if (opts.text) {                                     // Sahteci: sahte vasiyetname metni
      body.appendChild(el('h2', 'Sahte vasiyetname'));
      const ta = document.createElement('textarea');
      ta.id = 'forge-text'; ta.maxLength = 300; ta.placeholder = 'Kurban ölürse kasabanın okuyacağı metin…';
      ta.value = forgeDraft;
      ta.oninput = () => { forgeDraft = ta.value; refresh(); };
      body.appendChild(ta);
    }
    refresh();
    body.appendChild(ok);
  };

  if (v.phase === 'NIGHT') {
    banner();
    if (!me.alive) body.appendChild(el('p', '💀 Öldün. Gece geçiyor…', 'msg'));
    else if (v.acted) { body.appendChild(el('p', '💤 Uyudun.', 'big')); waiting(); }
    else {
      const titles = {
        kill: 'Kimi öldüreceksin?', forge: 'Kimin vasiyetini sahteleyeceksin?', heal: 'Kimi koruyacaksın?',
        guard: 'Kimi korumak için canını vereceksin?', shoot: `Kimi vuracaksın? (Mermi: ${v.bullets})`,
        investigate: 'Kimi araştıracaksın?', track: 'Kimi izleyeceksin?', fake: 'Sence bu gece kim ölecek?',
      };
      // Yeteneği olmayanların seçimi sahtedir; host gerçek hamle olarak saymaz
      picker(titles[v.kind] || titles.fake, 'Onayla ve Uyu',
        (t) => sendToHost({ t: 'nightConfirm', target: t, text: v.needsText ? forgeDraft : undefined }),
        { skip: v.skip, text: v.needsText });
    }
  }
  else if (v.phase === 'DAY') {
    banner();
    notes();
    body.appendChild(el('p', 'Serbest tartışma', 'msg'));
    body.appendChild(el('div', '', 'timer')).id = 'timer';
    deadline = Date.now() + v.timeLeft * 1000;
    if (host) body.appendChild(button('Tartışmayı Bitir', '', () => sendToHost({ t: 'skipDay' })));
  }
  else if (v.phase === 'VOTE_TRIAL') {
    notes();
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
    banner();
    notes();
    if (!me.alive) body.appendChild(el('p', '💀 Ölüler oy kullanamaz.', 'msg'));
    else if (v.acted) { body.appendChild(el('p', 'Oyun alındı ✔', 'big')); waiting(); }
    else picker('Kimi asalım?', 'Oyu Onayla', (t) => sendToHost({ t: 'execVote', target: t }));
    showVotes();
  }
  else if (v.phase === 'GAME_OVER') {
    banner();
    body.appendChild(el('p',
      v.winner === 'villager' ? '🎉 Köylüler kazandı!' :
      v.winner === 'jester' ? '🃏 Soytarı kazandı! Kasaba onu astı.' : '🧛 Vampirler kazandı!', 'big'));
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

/* ===== Vasiyetname + Mezarlık arayüzü ===== */
function openPanel(id) { $(id).classList.remove('hidden'); }
function closePanel(id) { $(id).classList.add('hidden'); }

/* ===== Hakkında paneli: oyun özeti, kurallar, rol rehberi ===== */
const ABOUT_TEXT = [
  ['🎯 Amaç', 'Kasaba, vampirleri bulup asmaya çalışır. Vampir takımı (Vampir + Sahteci) sayıca kasabaya eşitlenince kazanır. Soytarı\'nın tek amacı asılmaktır.'],
  ['🔁 Oyun akışı', 'Gece herkes ekranına dokunur (yeteneği olmayanlar sahte liste görür, böylece kimin yetenek kullandığı anlaşılmaz). Sabah ölenler ve vasiyetleri açıklanır, ardından tartışma, yargılama ve infaz oylaması yapılır. Ölenlerin rolü oyun bitene kadar gizli kalır.'],
  ['📝 Vasiyetname', 'Hayattayken istediğin an yazıp güncelleyebilirsin. Öldüğünde herkese açık gösterilir. (Sahteci bunu değiştirebilir.)'],
  ['⚰️ Mezarlık', 'Medyum geceleri ölülerle yazışır. Diğer oyuncular geceleri bu panele bakabilir ama kimse yanıt vermez.'],
];
function openAbout() {
  const b = $('about-body'); b.innerHTML = '';
  ABOUT_TEXT.forEach(([h, t]) => { b.appendChild(el('h3', h, 'about-h')); b.appendChild(el('p', t, 'about-p')); });
  b.appendChild(el('h3', '🎭 Roller', 'about-h'));
  const team = (title, roles) => {
    b.appendChild(el('p', title, 'about-team'));
    roles.forEach(r => {
      const c = el('div', null, 'about-role');
      c.appendChild(el('strong', ROLE_LABEL[r]));
      c.appendChild(el('p', ROLE_DESC[r]));
      b.appendChild(c);
    });
  };
  team('Kasaba', TOWN_TEAM);
  team('Vampir takımı', VAMP_TEAM);
  team('Tarafsız', ['jester']);
  openPanel('about-panel');
}
$('btn-about').onclick = openAbout;
$('btn-about-lobby').onclick = openAbout;
$('about-close').onclick = () => closePanel('about-panel');

function saveWill() {
  sendToHost({ t: 'will', text: $('will-text').value });
  $('will-msg').textContent = 'Kaydedildi ✔';
}

// Araç çubuğu: Vasiyetname her an (hayattayken), Mezarlık ölüler + Medyum için; canlı herkese geceleri SAHTE panel (anti-meta)
function updateTools(v, me) {
  const over = v.phase === 'GAME_OVER', alive = !!(me && me.alive);
  $('btn-will').classList.toggle('hidden', !alive || over);
  const graveVisible = !over && (!alive || v.role === 'medium' || v.phase === 'NIGHT');
  $('btn-grave').classList.toggle('hidden', !graveVisible);
  if (!alive || over) closePanel('will-panel');
  if (!graveVisible) closePanel('grave-panel');
  if ($('will-panel').classList.contains('hidden')) $('will-text').value = v.myWill;
  const real = v.graveChat !== null;
  const log = $('grave-log'); log.innerHTML = '';
  if (!real || !v.graveChat.length) log.appendChild(el('p', real ? 'Henüz kimse konuşmadı.' : 'Mezarlık sessiz… kimse yanıt vermiyor.', 'msg'));
  if (real) v.graveChat.forEach(m => log.appendChild(el('p', `${m.from}: ${m.text}`, 'grave-msg' + (m.dead ? ' dead' : ''))));
  log.scrollTop = log.scrollHeight;
  const canPost = real ? v.graveCanPost : v.phase === 'NIGHT';
  $('grave-input').disabled = !canPost; $('grave-send').disabled = !canPost;
  if (real) $('grave-hint').textContent = canPost ? (alive ? 'Ölülerle konuşuyorsun.' : 'Medyum seni duyabilir.') : 'Yalnızca geceleri konuşulabilir.';
}

$('btn-will').onclick = () => { $('will-msg').textContent = ''; openPanel('will-panel'); };
$('will-save').onclick = saveWill;
$('will-close').onclick = () => { saveWill(); closePanel('will-panel'); };
$('btn-grave').onclick = () => openPanel('grave-panel');
$('grave-close').onclick = () => closePanel('grave-panel');
function sendGrave() {
  const inp = $('grave-input'), t = inp.value.trim();
  if (!t) return;
  sendToHost({ t: 'grave', text: t });
  inp.value = '';
  if (lastView && lastView.graveChat === null) $('grave-hint').textContent = 'Kimse yanıt vermedi…';   // sahte panel
}
$('grave-send').onclick = sendGrave;
$('grave-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendGrave(); });

// Basılı tutunca rolü göster (rol + kısa açıklama), bırakınca gizle
function holdToReveal(cardId, textId, hiddenText) {
  const card = $(cardId), txt = $(textId);
  const show = (e) => {
    e.preventDefault(); if (!myRole) return;
    txt.textContent = '';
    txt.appendChild(document.createTextNode(ROLE_LABEL[myRole]));
    txt.appendChild(el('small', ROLE_DESC[myRole], 'role-desc'));
    card.classList.add('show', myRole);
  };
  const hide = () => { txt.textContent = hiddenText; card.classList.remove('show', ...Object.keys(ROLE_LABEL)); };
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

buildRoleSteppers();
// Host'un kendi hamleleri: WebRTC yok, doğrudan motora
document.querySelectorAll('.step').forEach(b => b.onclick = () => {
  const role = b.dataset.role;
  host.handleMessage(session.id, { t: 'setCfg', role, value: host.cfg[role] + (+b.dataset.d) });
});
$('btn-start').onclick = () => host.handleMessage(session.id, { t: 'startGame' });

