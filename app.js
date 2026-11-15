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
// Test modu parametreleri (?dev=host|join&room=KOD&name=Ad); normal oyunda boştur
const DEV_Q = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : new URLSearchParams('');
const DEV_ROOM = DEV_Q.get('dev') && /^\d{5}$/.test(DEV_Q.get('room') || '') ? DEV_Q.get('room') : null;
if (DEV_ROOM && typeof sessionStorage !== 'undefined') {
  sessionStorage.removeItem('vk_room');
  sessionStorage.setItem('vk_pid', 'dev_' + (DEV_Q.get('name') || secureRandom().toString(36).slice(2, 8)));
}
const DROUGHT_BONUS = 0.35;   // üst üste köylü kalan oyuncuya özel rol ağırlık bonusu

// --- Kalıcı kimlik (Adım 4'te reconnect için kullanılacak) ---
/* ===== Rol tanımları ===== */
const SPECIAL_ROLES = ['vampire', 'forger', 'doctor', 'bodyguard', 'vigilante', 'medium', 'investigator', 'tracker', 'jester', 'amnesiac'];
const VAMP_TEAM = ['vampire', 'forger'];
const TOWN_TEAM = ['villager', 'doctor', 'bodyguard', 'vigilante', 'medium', 'investigator', 'tracker'];
// Gece davranış türü: 'fake' = gerçek yeteneği yok, ekranda sahte tahmin listesi görür (anti-meta)
const ROLE_KIND = { vampire: 'kill', forger: 'forge', doctor: 'heal', bodyguard: 'guard', vigilante: 'shoot',
  medium: 'fake', investigator: 'investigate', tracker: 'track', villager: 'fake', jester: 'fake', amnesiac: 'fake' };
const REAL_KINDS = ['kill', 'forge', 'heal', 'guard', 'shoot', 'investigate', 'track'];
const ROLE_LABEL = { vampire: '🧛 VAMPİR', forger: '🖋️ SAHTECİ', doctor: '🩺 DOKTOR', bodyguard: '🛡️ KORUMA',
  vigilante: '🔫 İNFAZCI', medium: '🔮 MEDYUM', investigator: '🔍 ARAŞTIRMACI', tracker: '👣 İZ SÜRÜCÜ',
  jester: '🃏 SOYTARI', amnesiac: '🧠 UNUTKAN', villager: '🧑‍🌾 KÖYLÜ' };
const ROLE_NAME = { vampire: 'Vampir', forger: 'Sahteci', doctor: 'Doktor', bodyguard: 'Koruma', vigilante: 'İnfazcı',
  medium: 'Medyum', investigator: 'Araştırmacı', tracker: 'İz Sürücü', jester: 'Soytarı', amnesiac: 'Unutkan', villager: 'Köylü' };
const ROLE_DESC = {
  vampire: 'Her gece vampir takımıyla birlikte bir kişiyi öldür. Takımın, kasabadan fazla veya eşit olunca kazanırsın.',
  forger: 'Vampir takımındasın ama öldüremezsin. Gece bir hedef seç ve onun için sahte vasiyetname yaz. Hedef o gece ölürse kasaba senin yazdığını okur.',
  doctor: 'Her gece birini koru (kendini de). Üst üste iki gece aynı kişiyi koruyamazsın.',
  bodyguard: 'Gece birini koru (kendini koruyamazsın). Hedefe saldırı olursa saldıranı öldürür, sen de ölürsün.',
  vigilante: 'Gece birini gizlice vurabilirsin (sınırlı mermi). Masum bir kasabalıyı öldürürsen sabahına vicdan azabından intihar edersin.',
  medium: 'Geceleri Mezarlık sohbetinde ölülerle konuş, öğrendiklerini gündüz kasabaya aktar.',
  investigator: 'Gece bir hedef seç; sabah hedefin hangi 3 rolden biri olabileceğini öğren.',
  tracker: 'Gece bir hedef seç; sabah hedefin o gece kimi ziyaret ettiğini öğren.',
  jester: 'Amacın gündüz infaz oylamasında asılmak. Asılırsan tek başına kazanırsın; gece öldürülürsen kaybedersin.',
  amnesiac: 'Hafızasını kaybetmiş tarafsız rol. Mezarlıkta en az 3 ölü olduğunda, takip eden gecenin başında ölülerden birinin rolünü rastgele hatırlayarak o role dönüşür. Dönüşemeden ölürse veya oyun biterse kaybeder.',
  villager: 'Özel yeteneğin yok. Tartış, oy kullan ve kasabayı vampirlerden kurtar.',
};

/* ===== Secret Hitler: State Taslağı ===== */
function createSecretHitlerState() {
  return {
    // 1. Oyuncu rolleri ve oturma/oyun durumu
    roles: new Map(),              // playerId -> 'liberal' | 'fascist' | 'hitler'
    alive: new Set(),              // hayattaki oyuncu id'leri (idam sonrası güncellenir)
    seatOrder: [],                 // başkanlık sırası için oyuncu id dizisi [pid1, pid2, ...]

    // 2. Oyun tahtası durumu (Board)
    board: {
      liberalPolicies: 0,          // kabul edilen Liberal yasa sayısı (0..5 — 5 olunca Liberaller kazanır)
      fascistPolicies: 0,          // kabul edilen Faşist yasa sayısı (0..6 — 6 olunca Faşistler kazanır)
      electionTracker: 0,          // başarısız hükümet oylaması sayacı (0..3 — 3 olunca kaos yasası açılır ve sıfırlanır)
      boardType: 'small',          // oyuncu sayısına göre tahta tipi: 'small' (5-6) | 'medium' (7-8) | 'large' (9-10)
      vetoUnlocked: false,         // 5. Faşist yasadan sonra açılan Veto yetkisi
    },

    // 3. Deste durumu (Deck: 6 Liberal + 11 Faşist = 17 kart)
    deck: {
      drawPile: [],                // çekilecek kartlar: ['liberal' | 'fascist', ...]
      discardPile: [],             // elenen / atılan kartlar: ['liberal' | 'fascist', ...]
      legislativeHand: [],         // yasama aşamasında Başkanın çektiği (3) veya Şansölyeye devrettiği (2) kartlar
    },

    // 4. Mevcut Başkan ve Şansölye adayları / Hükümet durumu
    government: {
      vetoRefused: false,          // bu yasama oturumunda Başkan vetoyu reddetti mi (Şansölye bir daha veto teklif edemez)
      presidentIdx: 0,             // seatOrder üzerindeki normal başkanlık sırası indeksi
      presidentCandidateId: null,  // mevcut turdaki Başkan adayı (playerId)
      chancellorCandidateId: null, // Başkan adayının önerdiği Şansölye adayı (playerId)
      presidentId: null,           // güvenoyu almış aktif Başkan (playerId)
      chancellorId: null,          // güvenoyu almış aktif Şansölye (playerId)
      termLimitedIds: [],          // bir önceki seçilmiş hükümet üyeleri (Şansölye adayı olamazlar)
      specialNextPresidentId: null,// Özel Seçim yetkisiyle sıradaki tur için atanan Başkan (playerId)
    },

    // 5. Faz, Oylama ve Başkanlık Yetkileri (Executive Actions)
    phase: 'LOBBY',                // 'LOBBY' | 'ROLE_REVEAL' | 'NOMINATE_CHANCELLOR' | 'VOTE_GOVERNMENT' | 'LEGISLATIVE_PRESIDENT' | 'LEGISLATIVE_CHANCELLOR' | 'VETO_CONFIRM' | 'EXECUTIVE_ACTION' | 'GAME_OVER'
    votes: new Map(),              // playerId -> true (Ja!) | false (Nein!)
    pendingPower: null,            // 'investigate' | 'special_election' | 'policy_peek' | 'execution' | null
    investigatedIds: new Set(),    // daha önce parti üyeliği incelenmiş oyuncular (tekrar incelenemez)
    winner: null,                  // 'liberal' | 'fascist' | null
    winReason: null,               // 'liberal_policies' | 'fascist_policies' | 'hitler_chancellor' | 'hitler_executed' | null

    // 6. Başkanlık güçleri ve animasyon olayları
    peekCards: [],                 // Yasa Gözetleme: yalnızca Başkan'a gönderilen en üstteki 3 kart
    executiveResult: null,         // Soruşturma sonucu { targetId, party } — yalnızca Başkan'a gönderilir
    events: [],                    // Herkese açık olay günlüğü (animasyon için): [{ seq, type, ... }]
    eventSeq: 0,
    notHitlerIds: [],              // 3. Faşist yasadan sonra Şansölye seçilip Hitler olmadığı ortaya çıkan oyuncular (herkese açık)
  };
}

const secretHitlerState = createSecretHitlerState();
// Host'un kendi ekranı için filtrelenmiş görünüm (gerçek state'in üzerine ASLA yazılmaz; yoksa diğer oyuncuların rolleri silinir)
const secretHitlerHostView = createSecretHitlerState();
// Arayüzün okuduğu state: Host'ta ayrı görünüm, Client'ta gelen senkron verisi
function getSecretHitlerView() { return host ? secretHitlerHostView : secretHitlerState; }

/* ===== Secret Hitler: Aşama 3 — Temel Oyun Mantığı ve Tahta UI ===== */

// 1. Oyunu başlatır: rolleri dağıtır, 17 kartlık desteyi ve oturma sırasını karıştırır, state'i sıfırlar
function initSecretHitler(playerIds) {
  const ids = [...playerIds];
  const n = ids.length;
  if (n < 5 || n > 10) {
    throw new Error('Secret Hitler 5 ile 10 oyuncu arasında oynanır.');
  }

  // Oyuncu sayısına göre Faşist sayısı ve tahta tipi (5-6: 1F+1H, 7-8: 2F+1H, 9-10: 3F+1H)
  const fascistCount = n <= 6 ? 1 : (n <= 8 ? 2 : 3);
  const boardType = n <= 6 ? 'small' : (n <= 8 ? 'medium' : 'large');
  const liberalCount = n - fascistCount - 1;

  const rolePool = shuffle([
    'hitler',
    ...Array(fascistCount).fill('fascist'),
    ...Array(liberalCount).fill('liberal'),
  ]);

  const shuffledPlayers = shuffle([...ids]);
  secretHitlerState.roles.clear();
  shuffledPlayers.forEach((pid, idx) => {
    secretHitlerState.roles.set(pid, rolePool[idx]);
  });

  secretHitlerState.alive = new Set(ids);
  secretHitlerState.seatOrder = shuffle([...ids]);

  // Tahta durumunu sıfırla
  secretHitlerState.board = {
    liberalPolicies: 0,
    fascistPolicies: 0,
    electionTracker: 0,
    boardType,
    vetoUnlocked: false,
  };

  // Başlangıç destesi: 6 Liberal + 11 Faşist = 17 yasa kartı
  secretHitlerState.deck = {
    drawPile: shuffle([
      ...Array(6).fill('liberal'),
      ...Array(11).fill('fascist'),
    ]),
    discardPile: [],
    legislativeHand: [],
  };

  // Hükümet ve aday bilgilerini sıfırla; ilk Başkan adayı seatOrder[0] olur
  secretHitlerState.government = {
    vetoRefused: false,
    presidentIdx: 0,

    presidentCandidateId: secretHitlerState.seatOrder[0] || null,
    chancellorCandidateId: null,
    presidentId: null,
    chancellorId: null,
    termLimitedIds: [],
    specialNextPresidentId: null,
  };

  // Faz ve diğer durumları sıfırla; ilk Başkan adayı Şansölye seçimi ile başlar
  secretHitlerState.phase = 'NOMINATE_CHANCELLOR';
  secretHitlerState.votes.clear();
  secretHitlerState.pendingPower = null;
  secretHitlerState.investigatedIds.clear();
  secretHitlerState.winner = null;
  secretHitlerState.winReason = null;
  secretHitlerState.peekCards = [];
  secretHitlerState.executiveResult = null;
  secretHitlerState.events = [];
  secretHitlerState.eventSeq = 0;
  secretHitlerState.notHitlerIds = [];

  return secretHitlerState;
}

// 2. Desteden count kadar (varsayılan 3) yasa kartı çeker; deste yetmezse çöp yığınını karıştırıp ekler
function drawPolicies(count = 3) {
  const { deck } = secretHitlerState;

  if (deck.drawPile.length < count) {
    deck.drawPile = shuffle([...deck.drawPile, ...deck.discardPile]);
    deck.discardPile = [];
  }

  const drawn = deck.drawPile.splice(0, count);
  deck.legislativeHand = [...drawn];
  return drawn;
}

// Herkese açık olay günlüğüne kayıt ekler; istemciler seq'i takip ederek animasyon oynatır
function pushShEvent(evt) {
  const s = secretHitlerState;
  s.eventSeq += 1;
  s.events.push({ ...evt, seq: s.eventSeq });
  if (s.events.length > 8) s.events.shift();
}

// Başkanlık gücünü kullanacak Başkan: normal hükümette presidentId ile aynıdır, kaos yasasında presidentId boş olduğu için aday kullanılır
function getExecutivePresidentId() {
  return secretHitlerState.government.presidentCandidateId;
}

// Başkanlık gücünü başlatır; Yasa Gözetleme'de en üstteki 3 kart Başkan için saklanır
function beginExecutivePower(power) {
  const s = secretHitlerState;
  s.pendingPower = power;
  s.phase = 'EXECUTIVE_ACTION';
  s.executiveResult = null;
  s.peekCards = [];
  if (power === 'policy_peek') {
    const { deck } = s;
    if (deck.drawPile.length < 3) {
      deck.drawPile = shuffle([...deck.drawPile, ...deck.discardPile]);
      deck.discardPile = [];
    }
    s.peekCards = deck.drawPile.slice(0, 3);
  }
}

// Bir yasayı yürürlüğe koyar (normal veya kaos). Oyun bittiyse ya da Başkanlık gücü beklemeye alındıysa true döner;
// bu durumda çağıran taraf advanceTurn() çağırmamalıdır.
// Kaos yasası (chaos = true) Faşist olsa bile Başkanlık gücü tetiklemez; resmî kurallardaki gibi güç atlanır.
function enactPolicy(policy, chaos = false) {
  const { board } = secretHitlerState;

  if (policy === 'liberal') {
    board.liberalPolicies += 1;
  } else if (policy === 'fascist') {
    board.fascistPolicies += 1;
    if (board.fascistPolicies >= 5) board.vetoUnlocked = true;
  }
  pushShEvent({ type: 'policy', policy, chaos });

  if (board.liberalPolicies >= 5) {
    secretHitlerState.winner = 'liberal';
    secretHitlerState.winReason = 'liberal_policies';
    secretHitlerState.phase = 'GAME_OVER';
    return true;
  }
  if (board.fascistPolicies >= 6) {
    secretHitlerState.winner = 'fascist';
    secretHitlerState.winReason = 'fascist_policies';
    secretHitlerState.phase = 'GAME_OVER';
    return true;
  }

  if (policy === 'fascist' && !chaos) {
    const power = getExecutivePower(board.boardType, board.fascistPolicies);
    if (power) {
      beginExecutivePower(power);
      return true;
    }
  }
  return false;
}

// 3 başarısız seçimde destenin üstündeki yasa oylamasız yürürlüğe girer (Başkanlık gücü tetiklenmez)
function enactChaosPolicy() {
  const { board, government, deck } = secretHitlerState;
  const [chaosPolicy] = drawPolicies(1);
  deck.legislativeHand = [];
  board.electionTracker = 0;
  government.termLimitedIds = [];
  government.presidentId = null;
  government.chancellorId = null;
  if (!chaosPolicy) return false;
  return enactPolicy(chaosPolicy, true);
}

// 3. secretHitlerState.board verilerini kullanarak index.html'deki oyun tahtasını günceller
const SH_FASCIST_TRACK_CONFIG = {
  small: [
    { slot: 1, icon: '',   title: '1. Faşist Yasa: Özel yetki yok' },
    { slot: 2, icon: '',   title: '2. Faşist Yasa: Özel yetki yok' },
    { slot: 3, icon: '👁️', title: 'Policy Peek: Başkan destenin en üstündeki 3 yasa kartına bakar' },
    { slot: 4, icon: '🗡️', title: 'İnfaz: Başkan bir oyuncuyu idam eder (3. yasadan sonra Hitler Şansölye seçilirse Faşistler kazanır)', danger: true },
    { slot: 5, icon: '🗡️', title: 'İnfaz + Veto: Başkan bir oyuncuyu idam eder ve Veto yetkisi açılır', danger: true },
    { slot: 6, icon: '💀', title: '6. Faşist Yasa: Faşistler oyunu kazanır', win: true },
  ],
  medium: [
    { slot: 1, icon: '',   title: '1. Faşist Yasa: Özel yetki yok' },
    { slot: 2, icon: '🔍', title: 'İnceleme: Başkan bir oyuncunun parti üyeliğini öğrenir' },
    { slot: 3, icon: '🎩', title: 'Özel Seçim: Başkan sıradaki Başkan adayını seçer' },
    { slot: 4, icon: '🗡️', title: 'İnfaz: Başkan bir oyuncuyu idam eder (3. yasadan sonra Hitler Şansölye seçilirse Faşistler kazanır)', danger: true },
    { slot: 5, icon: '🗡️', title: 'İnfaz + Veto: Başkan bir oyuncuyu idam eder ve Veto yetkisi açılır', danger: true },
    { slot: 6, icon: '💀', title: '6. Faşist Yasa: Faşistler oyunu kazanır', win: true },
  ],
  large: [
    { slot: 1, icon: '🔍', title: 'İnceleme: Başkan bir oyuncunun parti üyeliğini öğrenir' },
    { slot: 2, icon: '🔍', title: 'İnceleme: Başkan bir oyuncunun parti üyeliğini öğrenir' },
    { slot: 3, icon: '🎩', title: 'Özel Seçim: Başkan sıradaki Başkan adayını seçer' },
    { slot: 4, icon: '🗡️', title: 'İnfaz: Başkan bir oyuncuyu idam eder (3. yasadan sonra Hitler Şansölye seçilirse Faşistler kazanır)', danger: true },
    { slot: 5, icon: '🗡️', title: 'İnfaz + Veto: Başkan bir oyuncuyu idam eder ve Veto yetkisi açılır', danger: true },
    { slot: 6, icon: '💀', title: '6. Faşist Yasa: Faşistler oyunu kazanır', win: true },
  ],
};

function updateSecretHitlerBoardUI(view = secretHitlerState) {
  const { board, deck } = view;

  const libCountEl = $('sh-liberal-count');
  if (libCountEl) libCountEl.textContent = String(board.liberalPolicies);

  const fasCountEl = $('sh-fascist-count');
  if (fasCountEl) fasCountEl.textContent = String(board.fascistPolicies);

  // Liberal yasa yuvaları (1..5)
  const libSlots = document.querySelectorAll('#sh-liberal-slots .liberal-slot');
  libSlots.forEach(slot => {
    const slotNum = Number(slot.dataset.slot);
    slot.classList.toggle('enacted', slotNum <= board.liberalPolicies);
  });

  // Faşist yasa yuvaları (1..6) — board.boardType'a göre dinamik oluştur
  const fasSlotsContainer = $('sh-fascist-slots');
  if (fasSlotsContainer) {
    const trackCfg = SH_FASCIST_TRACK_CONFIG[board.boardType] || SH_FASCIST_TRACK_CONFIG.small;
    fasSlotsContainer.innerHTML = '';
    trackCfg.forEach(cfg => {
      const classes = ['policy-slot', 'fascist-slot'];
      if (cfg.danger) classes.push('danger-zone');
      if (cfg.win) classes.push('win-slot');
      if (cfg.slot <= board.fascistPolicies) classes.push('enacted');

      const slotEl = el('div', cfg.icon, classes.join(' '));
      slotEl.dataset.slot = String(cfg.slot);
      if (cfg.title) slotEl.title = cfg.title;
      fasSlotsContainer.appendChild(slotEl);
    });
  }

  // Seçim sayacı (Election Tracker: 0..3)
  const trackerTokens = document.querySelectorAll('#sh-election-tracker .tracker-token');
  trackerTokens.forEach(token => {
    const step = Number(token.dataset.step);
    token.classList.toggle('active', step === board.electionTracker);
  });

  // Deste / Çöp sayacı özeti
  const deckCounterEl = $('sh-deck-counter');
  if (deckCounterEl) {
    deckCounterEl.textContent = `🃏 Deste: ${deck.drawPile.length} · 🗑️ Çöp: ${deck.discardPile.length}`;
  }
}

/* ===== Secret Hitler: Aşama 4 — Başkanlık Sırası, Seçim Oylaması ve Yasama Evresi ===== */

// Tahta tipine ve yürürlükteki Faşist yasa sayısına göre Başkanlık gücünü döndürür
function getExecutivePower(boardType, fascistCount) {
  const powers = {
    small:  { 1: null,          2: null,          3: 'policy_peek',      4: 'execution', 5: 'execution' },
    medium: { 1: null,          2: 'investigate', 3: 'special_election', 4: 'execution', 5: 'execution' },
    large:  { 1: 'investigate', 2: 'investigate', 3: 'special_election', 4: 'execution', 5: 'execution' },
  };
  return (powers[boardType] && powers[boardType][fascistCount]) || null;
}

// 1. Yeni tura geçerken Başkan adayını ve dönem kısıtlamalarını (term limits) günceller
function advanceTurn() {
  const { government, seatOrder, alive, votes } = secretHitlerState;

  // Bir önceki seçilmiş hükümeti termLimitedIds listesine aktar (alive.size <= 5 ise sadece eski Şansölye engellenir)
  if (government.presidentId !== null || government.chancellorId !== null) {
    const limits = [];
    if (government.chancellorId && alive.has(government.chancellorId)) {
      limits.push(government.chancellorId);
    }
    if (alive.size > 5 && government.presidentId && alive.has(government.presidentId)) {
      limits.push(government.presidentId);
    }
    government.termLimitedIds = limits;
    government.presidentId = null;
    government.chancellorId = null;
  }

  // Özel Seçim (Special Election) varsa sıradaki Başkan adayı o kişi olur (normal presidentIdx ilerlemez)
  if (government.specialNextPresidentId && alive.has(government.specialNextPresidentId)) {
    government.presidentCandidateId = government.specialNextPresidentId;
    government.specialNextPresidentId = null;
  } else {
    government.specialNextPresidentId = null;
    const len = seatOrder.length;
    for (let i = 0; i < len; i++) {
      government.presidentIdx = (government.presidentIdx + 1) % len;
      const candidateId = seatOrder[government.presidentIdx];
      if (alive.has(candidateId)) {
        government.presidentCandidateId = candidateId;
        break;
      }
    }
  }

  government.chancellorCandidateId = null;
  votes.clear();
  secretHitlerState.pendingPower = null;
  secretHitlerState.executiveResult = null;
  secretHitlerState.peekCards = [];
  secretHitlerState.phase = 'NOMINATE_CHANCELLOR';
}

// 2. Hükümet güvenoyu (Ja! / Nein!) kaydeder ve tüm yaşayanlar oy kullandığında sonucu çözümler
function handleVote(playerId, voteBool) {
  const { alive, votes, board, government, roles } = secretHitlerState;
  if (secretHitlerState.phase !== 'VOTE_GOVERNMENT' || !alive.has(playerId)) return;

  votes.set(playerId, Boolean(voteBool));

  // Yaşayan tüm oyuncular oy kullanmadan sonucu hesaplama
  const allVoted = [...alive].every(id => votes.has(id));
  if (!allVoted) return;

  let jaCount = 0;
  let neinCount = 0;
  alive.forEach(id => {
    if (votes.get(id)) jaCount++;
    else neinCount++;
  });

  if (jaCount > neinCount) {
    // Çoğunluk "Ja!": Hükümet kuruldu
    board.electionTracker = 0;
    government.presidentId = government.presidentCandidateId;
    government.chancellorId = government.chancellorCandidateId;

    // 3 veya daha fazla Faşist yasa geçmişken Hitler Şansölye seçildiyse Faşistler kazanır
    if (board.fascistPolicies >= 3 && roles.get(government.chancellorId) === 'hitler') {
      secretHitlerState.winner = 'fascist';
      secretHitlerState.winReason = 'hitler_chancellor';
      secretHitlerState.phase = 'GAME_OVER';
      updateSecretHitlerBoardUI();
      return;
    }

    // 3+ Faşist yasadan sonra Şansölye seçilen kişi Hitler değilse herkese hatırlatılır
    if (board.fascistPolicies >= 3) {
      const cid = government.chancellorId;
      if (!secretHitlerState.notHitlerIds.includes(cid)) secretHitlerState.notHitlerIds.push(cid);
      pushShEvent({ type: 'not_hitler', chancellorId: cid });
    }

    government.vetoRefused = false;
    drawPolicies(3);

    secretHitlerState.phase = 'LEGISLATIVE_PRESIDENT';
    updateSecretHitlerBoardUI();
  } else {
    // Beraberlik veya çoğunluk "Nein!": Seçim başarısız
    board.electionTracker += 1;

    // Kaos kuralı: Destenin en üstündeki kart oylamasız yürürlüğe girer (Faşist ise Başkanlık gücü de tetiklenir)
    if (board.electionTracker >= 3 && enactChaosPolicy()) {
      updateSecretHitlerBoardUI();
      return;
    }

    advanceTurn();
    updateSecretHitlerBoardUI();
  }
}

// 3. Yasama evresi.
//  - Başkan: seçtiği kartı çöpe atar, kalan 2 kart Şansölye'ye geçer.
//  - Şansölye: seçtiği kart YÜRÜRLÜĞE girer, diğer kart çöpe atılır.
function handleLegislativeDiscard(cardIndex, byWhom) {
  const { deck } = secretHitlerState;
  if (cardIndex < 0 || cardIndex >= deck.legislativeHand.length) return;
  if (byWhom === 'president' && secretHitlerState.phase !== 'LEGISLATIVE_PRESIDENT') return;
  if (byWhom === 'chancellor' && secretHitlerState.phase !== 'LEGISLATIVE_CHANCELLOR') return;

  if (byWhom === 'president') {
    const [discarded] = deck.legislativeHand.splice(cardIndex, 1);
    deck.discardPile.push(discarded);
    secretHitlerState.phase = 'LEGISLATIVE_CHANCELLOR';
    updateSecretHitlerBoardUI();
    return;
  }

  // Şansölye: seçilen kart yürürlüğe girer, elde kalan diğer kart çöpe gider
  const [enacted] = deck.legislativeHand.splice(cardIndex, 1);
  deck.discardPile.push(...deck.legislativeHand);
  deck.legislativeHand = [];

  if (enactPolicy(enacted)) {
    updateSecretHitlerBoardUI();
    return;
  }
  advanceTurn();
}

/* ===== Secret Hitler: Aşama 5 — Başkanlık Güçleri (Executive Action) ve Veto ===== */

// 1. Hedef gerektiren Başkanlık güçleri: Soruşturma, Özel Seçim, İnfaz.
//    Güç, kaos yasasıyla tetiklense bile sırası gelen Başkan adayı (presidentCandidateId) tarafından kullanılır.
function handleExecutiveAction(actorId, targetId) {
  const s = secretHitlerState;
  const { pendingPower, alive, roles, investigatedIds } = s;
  if (s.phase !== 'EXECUTIVE_ACTION' || !pendingPower || pendingPower === 'policy_peek') return;
  if (actorId !== getExecutivePresidentId()) return;
  if (pendingPower === 'investigate' && s.executiveResult) return;   // sonuç onay bekliyor

  // Hedef hayatta olmalı ve Başkanın kendisi olmamalı
  if (!targetId || !alive.has(targetId) || targetId === actorId) return;

  if (pendingPower === 'execution') {
    alive.delete(targetId);
    s.government.termLimitedIds = s.government.termLimitedIds.filter(id => id !== targetId);
    pushShEvent({ type: 'execution', presidentId: actorId, targetId });

    // Öldürülen kişi Hitler ise Liberaller anında kazanır
    if (roles.get(targetId) === 'hitler') {
      s.winner = 'liberal';
      s.winReason = 'hitler_executed';
      s.pendingPower = null;
      s.phase = 'GAME_OVER';
      return;
    }
    advanceTurn();
    return;
  }

  if (pendingPower === 'investigate') {
    // Daha önce incelenmiş bir oyuncu tekrar incelenemez
    if (investigatedIds.has(targetId)) return;
    investigatedIds.add(targetId);

    // Parti üyeliği: 'liberal' -> 'liberal', 'fascist' veya 'hitler' -> 'fascist'
    const party = roles.get(targetId) === 'liberal' ? 'liberal' : 'fascist';
    s.executiveResult = { targetId, party };       // yalnızca Başkan'a gönderilir; "Tamam" ile turu bitirir
    pushShEvent({ type: 'investigate', presidentId: actorId, targetId });
    return;
  }

  if (pendingPower === 'special_election') {
    s.government.specialNextPresidentId = targetId;
    pushShEvent({ type: 'special_election', presidentId: actorId, targetId });
    advanceTurn();
  }
}

// 2. Başkan "Tamam" dediğinde: Yasa Gözetleme kartlarını ya da Soruşturma sonucunu kapatır ve oyunu devam ettirir
function handleExecutiveAck(actorId) {
  const s = secretHitlerState;
  if (s.phase !== 'EXECUTIVE_ACTION' || actorId !== getExecutivePresidentId()) return;

  if (s.pendingPower === 'policy_peek') {
    pushShEvent({ type: 'policy_peek', presidentId: actorId });
    advanceTurn();
  } else if (s.pendingPower === 'investigate' && s.executiveResult) {
    advanceTurn();
  }
}

// 3. Veto teklifi (Şansölye) ve Veto onayı/reddi (Başkan) sürecini yönetir
function handleVeto(voteBool, byWhom) {
  const { board, deck, government } = secretHitlerState;

  if (!board.vetoUnlocked) return;



  if (byWhom === 'chancellor') {

    if (secretHitlerState.phase !== 'LEGISLATIVE_CHANCELLOR' || government.vetoRefused) return;

    if (voteBool) {
      secretHitlerState.phase = 'VETO_CONFIRM';
    }
  } else if (byWhom === 'president') {
    if (secretHitlerState.phase !== 'VETO_CONFIRM') return;

    if (voteBool) {
      // Başkan vetoyu kabul etti: Eldeki 2 kart çöpe atılır, seçim sayacı 1 ilerler
      deck.discardPile.push(...deck.legislativeHand);

      deck.legislativeHand = [];

      board.electionTracker += 1;

      pushShEvent({ type: 'veto_accepted' });


      // Seçim sayacı 3'e ulaşırsa Kaos kuralı devreye girer
      if (board.electionTracker >= 3 && enactChaosPolicy()) {
        updateSecretHitlerBoardUI();
        return;
      }

      advanceTurn();
      updateSecretHitlerBoardUI();
    } else {
      // Başkan vetoyu reddetti: Şansölye elindeki 2 karttan birini yürürlüğe koymak zorundadır
      government.vetoRefused = true;

      pushShEvent({ type: 'veto_rejected' });
      secretHitlerState.phase = 'LEGISLATIVE_CHANCELLOR';

    }

  }

}



/* ===== Secret Hitler: DOM Etkileşimleri (Event Listeners) ===== */
function setupSecretHitlerEventListeners() {
  const btnJa = $('btn-vote-ja');
  const btnNein = $('btn-vote-nein');
  const handEl = $('sh-legislative-hand');
  const btnDiscard = $('btn-policy-discard');
  const btnEnact = $('btn-policy-enact');
  const btnVeto = $('btn-policy-veto');

  let selectedCardIndex = null;

  const clearCardSelection = () => {
    selectedCardIndex = null;
    if (handEl) {
      handEl.querySelectorAll('.policy-card').forEach(c => c.classList.remove('sel'));
    }
    if (btnDiscard) btnDiscard.disabled = true;
    if (btnEnact) btnEnact.disabled = true;
  };

  // 1. Hükümet Oylaması (Ja! / Nein!) — Doğrudan sendToHost ile Host'a iletilir
  if (btnJa) {
    btnJa.addEventListener('click', () => {
      btnJa.classList.add('sel');
      if (btnNein) btnNein.classList.remove('sel');
      sendToHost({ t: 'sh_action', action: 'vote', voteBool: true });
    });
  }

  if (btnNein) {
    btnNein.addEventListener('click', () => {
      btnNein.classList.add('sel');
      if (btnJa) btnJa.classList.remove('sel');
      sendToHost({ t: 'sh_action', action: 'vote', voteBool: false });
    });
  }

  // 2. Yasama Evresi Kart Seçimi (Event Delegation ile dinamik kartları da destekler)
  if (handEl) {
    handEl.addEventListener('click', (e) => {
      const card = e.target.closest('.policy-card');
      if (!card || !handEl.contains(card)) return;

      const cards = [...handEl.querySelectorAll('.policy-card')];
      cards.forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');

      const dataIdx = Number(card.dataset.index);
      selectedCardIndex = Number.isInteger(dataIdx) && dataIdx >= 0 ? dataIdx : cards.indexOf(card);

      if (btnDiscard) btnDiscard.disabled = false;
      if (btnEnact) btnEnact.disabled = false;
    });
  }

  // 3. Yasama Evresi Aksiyonları (Discard, Enact, Veto) — sendToHost üzerinden
  if (btnDiscard) {
    btnDiscard.addEventListener('click', () => {
      if (selectedCardIndex === null) return;
      const idx = selectedCardIndex;
      clearCardSelection();
      sendToHost({ t: 'sh_action', action: 'discard', cardIndex: idx });
    });
  }

  if (btnEnact) {
    btnEnact.addEventListener('click', () => {
      if (selectedCardIndex === null) return;
      const idx = selectedCardIndex;
      clearCardSelection();
      sendToHost({ t: 'sh_action', action: 'enact', cardIndex: idx });
    });
  }

  if (btnVeto) {
    btnVeto.addEventListener('click', () => {
      clearCardSelection();
      sendToHost({ t: 'sh_action', action: 'veto', voteBool: true });
    });
  }

  // 3.2 Veto onayı (yalnızca Başkan): Kabul / Reddet

  const btnVetoAccept = $('btn-veto-accept');
  const btnVetoReject = $('btn-veto-reject');

  if (btnVetoAccept) btnVetoAccept.addEventListener('click', () => sendToHost({ t: 'sh_action', action: 'veto', voteBool: true }));

  if (btnVetoReject) btnVetoReject.addEventListener('click', () => sendToHost({ t: 'sh_action', action: 'veto', voteBool: false }));


  // 3.5 Başkanlık gücü "Tamam" düğmeleri (Yasa Gözetleme kartları ve Soruşturma sonucu pop-up'ı)

  ['btn-exec-ok', 'btn-investigate-ok'].forEach(id => {

    const b = $(id);

    if (b) b.addEventListener('click', () => sendToHost({ t: 'sh_action', action: 'executive_ack' }));

  });


  // 4. Gizli Rol Kartı (Basılı Tutunca Göster / Bırakınca Gizle)
  const shRoleCard = $('sh-role-card');
  const shRoleText = $('sh-role-text');
  const SH_ROLE_LABELS = {
    liberal: '🕊️ LİBERAL',
    fascist: '🐍 FAŞİST',
    hitler: '💀 HİTLER',
  };
  if (shRoleCard && shRoleText) {
    const hiddenRoleText = 'Gizli Rolün (Görmek için basılı tut)';
    const showShRole = (e) => {
      e.preventDefault();
      const view = getSecretHitlerView();
      const mySHRole = view.roles.get(session.id);
      if (!mySHRole) return;

      shRoleCard.classList.remove('show', 'liberal', 'fascist', 'hitler');
      shRoleCard.classList.add('show', mySHRole);

      shRoleText.innerHTML = '';
      shRoleText.appendChild(document.createTextNode(SH_ROLE_LABELS[mySHRole] || mySHRole.toUpperCase()));

      if (mySHRole === 'fascist') {
        const namesMap = view.names || {};
        const getName = (pid) => namesMap[pid] || (host && host.players && host.players.has(pid) ? host.players.get(pid).name : pid);
        const otherFascists = [];
        let hitlerName = '—';

        view.roles.forEach((role, pid) => {
          if (role === 'fascist' && pid !== session.id) {
            otherFascists.push(getName(pid));
          } else if (role === 'hitler') {
            hitlerName = getName(pid);
          }
        });

        const descEl = document.createElement('small');
        descEl.className = 'role-desc';
        // textContent kullan: oyuncu isimleri HTML olarak yorumlanmasın
        descEl.textContent = otherFascists.length > 0
          ? `Diğer Faşistler: ${otherFascists.join(', ')}\nHitler: ${hitlerName}`
          : `Hitler: ${hitlerName}`;
        shRoleText.appendChild(descEl);
      }
    };
    const hideShRole = () => {
      shRoleCard.classList.remove('show', 'liberal', 'fascist', 'hitler');
      shRoleText.textContent = hiddenRoleText;
    };
    shRoleCard.addEventListener('pointerdown', showShRole);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => shRoleCard.addEventListener(ev, hideShRole));
    shRoleCard.addEventListener('contextmenu', e => e.preventDefault());
  }
}

/* ===== Secret Hitler: Aşama 6 — Ağ Senkronizasyonu ve State Gizleme (Sanitization) ===== */

// Her oyuncu için gizli bilgileri (deste sırası, diğer oyuncuların rolleri, yasama eli) filtreler
function sanitizeSecretHitlerStateFor(targetPid) {
  const {
    roles, alive, seatOrder, board, deck, government,
    phase, votes, pendingPower, investigatedIds, winner, winReason,

    peekCards, executiveResult, events,
  } = secretHitlerState;
  const isExecutiveActor = phase === 'EXECUTIVE_ACTION' && targetPid === government.presidentCandidateId;

  // 1. Rol gizleme: Oyun bitmediyse herkes kendi rolünü görür; Faşistler birbirini ve Hitler'i görür, Hitler ise hiçbir zaman Faşistleri görmez
  const visibleRoles = {};
  if (phase === 'GAME_OVER') {
    roles.forEach((role, pid) => { visibleRoles[pid] = role; });
  } else {
    const myRole = roles.get(targetPid);
    if (myRole) visibleRoles[targetPid] = myRole;

    if (myRole === 'fascist') {
      roles.forEach((role, pid) => {
        if (role === 'fascist' || role === 'hitler') visibleRoles[pid] = role;
      });
    }
  }

  // 2. Deste gizleme: drawPile ve discardPile içeriği asla gönderilmez, yalnızca kart sayıları paylaşılır.
  // legislativeHand yalnızca ilgili yasama fazındaki aktif Başkan veya Şansölye'ye gönderilir.
  const canSeeHand =
    (phase === 'LEGISLATIVE_PRESIDENT' && targetPid === government.presidentId) ||
    ((phase === 'LEGISLATIVE_CHANCELLOR' || phase === 'VETO_CONFIRM') && targetPid === government.chancellorId);

  const sanitizedDeck = {
    drawCount: deck.drawPile.length,
    discardCount: deck.discardPile.length,
    legislativeHand: canSeeHand ? [...deck.legislativeHand] : [],
  };

  // 3. Oylama gizleme: Oylama sürerken sadece oyuncunun kendi oyu gönderilir; tamamlandığında tüm oylar açılır
  const allVoted = [...alive].every(id => votes.has(id));
  const visibleVotes = {};
  if (phase !== 'VOTE_GOVERNMENT' || allVoted) {
    votes.forEach((v, pid) => { visibleVotes[pid] = v; });
  } else if (votes.has(targetPid)) {
    visibleVotes[targetPid] = votes.get(targetPid);
  }

  const names = {};
  if (host && host.players) {
    host.players.forEach((p, pid) => { names[pid] = p.name; });
  }

  return {
    names,
    roles: visibleRoles,
    alive: [...alive],
    seatOrder: [...seatOrder],
    board: { ...board },
    deck: sanitizedDeck,
    government: {
      ...government,
      termLimitedIds: [...government.termLimitedIds],
    },
    phase,
    votes: visibleVotes,
    votedCount: votes.size,
    pendingPower,
    investigatedIds: [...investigatedIds],

    winner,

    winReason,

    // Gizli bilgiler yalnızca güç kullanan Başkan'a gider

    peekCards: isExecutiveActor ? [...peekCards] : [],

    executiveResult: isExecutiveActor && executiveResult ? { ...executiveResult } : null,
    events: events.map(e => ({ ...e })),
    notHitlerIds: [...secretHitlerState.notHitlerIds],
  };
}

// 1. Host: Her oyuncuya kendi yetkisine göre filtrelenmiş SECRET_HITLER_SYNC mesajı yayınlar
function broadcastSecretHitlerState() {
  const recipients = (host && host.players && host.players.size)
    ? [...host.players.keys()]
    : [...secretHitlerState.seatOrder];

  recipients.forEach(pid => {
    const sanitizedData = sanitizeSecretHitlerStateFor(pid);
    const msg = {
      t: 'SECRET_HITLER_SYNC',
      type: 'SECRET_HITLER_SYNC',
      data: sanitizedData,
    };

    if (pid === session.id) {
      onSecretHitlerSync(sanitizedData);
    } else if (host && host.conns) {
      const conn = host.conns.get(pid);
      if (conn && conn.open) conn.send(msg);
    }
  });
}

// 2. Client (ve yerel Host): SECRET_HITLER_SYNC mesajını alır, lokal state'i ve arayüzü günceller
function onSecretHitlerSync(data) {
  if (!data) return;

  // LOBBY'den oyuna ilk geçişte 3 saniye geri sayım oynat
  if (!countdownPlayedForCurrentGame) {
    countdownPlayedForCurrentGame = true;
    playStartCountdown();
  }

  // Görünürlük kontrolü: Vampir ekranını (ve diğer ekranları) gizle, Secret Hitler ekranını aktif et
  showScreen('');
  const gameScreen = $('screen-game');
  if (gameScreen) {
    gameScreen.classList.remove('active');
    gameScreen.classList.add('hidden');
  }
  const shContainer = $('secret-hitler-container');
  if (shContainer) {
    shContainer.classList.remove('hidden');
    shContainer.classList.add('active');
  }

  // Host'ta gerçek state'e dokunma: filtrelenmiş veri yalnızca ayrı görünüme yazılır
  const view = getSecretHitlerView();

  view.names = { ...(view.names || {}), ...(data.names || {}) };
  view.roles = new Map(Object.entries(data.roles || {}));
  view.alive = new Set(data.alive || []);
  view.seatOrder = [...(data.seatOrder || [])];
  view.board = { ...view.board, ...(data.board || {}) };
  view.government = {
    ...view.government,
    ...(data.government || {}),
    termLimitedIds: [...((data.government && data.government.termLimitedIds) || [])],
  };

  // Görünümde yalnızca kart sayıları ve (yetkiliyse) yasama eli tutulur
  if (data.deck) {
    view.deck = {
      drawPile: Array(data.deck.drawCount || 0).fill(null),
      discardPile: Array(data.deck.discardCount || 0).fill(null),
      legislativeHand: [...(data.deck.legislativeHand || [])],
    };
  }

  view.phase = data.phase || 'LOBBY';
  view.votes = new Map(Object.entries(data.votes || {}));
  view.pendingPower = data.pendingPower || null;
  view.investigatedIds = new Set(data.investigatedIds || []);
  view.winner = data.winner || null;
  view.winReason = data.winReason || null;

  view.peekCards = [...(data.peekCards || [])];

  view.executiveResult = data.executiveResult ? { ...data.executiveResult } : null;
  view.events = [...(data.events || [])];
  view.notHitlerIds = [...(data.notHitlerIds || [])];


  // 1) Oyun tahtasını güncelle
  updateSecretHitlerBoardUI(view);

  // 2) Bilgi panelini (Faz & Başkan/Şansölye adaylarını) güncelle
  const { phase, government, board, deck, alive, votes } = view;
  const namesMap = data.names || view.names || {};
  const resolveName = (pid) => {
    if (!pid) return '—';
    if (namesMap[pid]) return namesMap[pid];
    if (host && host.players && host.players.has(pid)) return host.players.get(pid).name;
    return pid;
  };

  const phaseBadge = $('sh-phase-badge');
  if (phaseBadge) phaseBadge.textContent = SH_PHASE_LABEL[phase] || phase;


  const presEl = $('sh-pres-candidate');
  if (presEl) presEl.textContent = resolveName(government.presidentId || government.presidentCandidateId);

  const chancEl = $('sh-chanc-candidate');
  if (chancEl) chancEl.textContent = resolveName(government.chancellorId || government.chancellorCandidateId);

  // 2.5) Şansölye Adayı Seçimi (NOMINATE_CHANCELLOR) görünürlüğü ve aday listesi
  const nominateUI = $('sh-nominate-ui');
  const nominateList = $('sh-nominate-list');
  if (nominateUI && nominateList) {
    const canNominate = phase === 'NOMINATE_CHANCELLOR' && session.id === government.presidentCandidateId;
    nominateUI.classList.toggle('hidden', !canNominate);
    nominateList.innerHTML = '';
    if (canNominate) {
      const termLimited = new Set(government.termLimitedIds || []);
      alive.forEach(candidateId => {
        if (candidateId === session.id || termLimited.has(candidateId)) return;
        const btn = el('button', resolveName(candidateId), 'btn pick');
        btn.type = 'button';
        btn.onclick = () => {
          sendToHost({ t: 'sh_action', action: 'nominate', targetId: candidateId });
        };
        nominateList.appendChild(btn);
      });
    }
  }

  // 3) Hükümet Oylaması (VOTE_GOVERNMENT) görünürlüğü
  const votingUI = $('sh-voting-ui');
  if (votingUI) {
    const canVote = phase === 'VOTE_GOVERNMENT' && alive.has(session.id) && !votes.has(session.id);
    votingUI.classList.toggle('hidden', !canVote);
    if (canVote) {
      const btnJa = $('btn-vote-ja');
      const btnNein = $('btn-vote-nein');
      if (btnJa) btnJa.classList.remove('sel');
      if (btnNein) btnNein.classList.remove('sel');
    }
  }

  // 4) Yasama Ekranı (Legislative UI) ve Veto butonlarının görünürlüğü
  const legislativeUI = $('sh-legislative-ui');
  const handEl = $('sh-legislative-hand');
  const btnDiscard = $('btn-policy-discard');
  const btnEnact = $('btn-policy-enact');
  const btnVeto = $('btn-policy-veto');

  const isPresTurn = phase === 'LEGISLATIVE_PRESIDENT' && government.presidentId === session.id;
  const isChancTurn = phase === 'LEGISLATIVE_CHANCELLOR' && government.chancellorId === session.id;

  if (legislativeUI) {
    if (isPresTurn || isChancTurn) {
      legislativeUI.classList.remove('hidden');



      const legTitle = $('sh-legislative-title');
      const legDesc = $('sh-legislative-desc');

      if (legTitle) legTitle.textContent = isPresTurn ? '📜 Yasa Çöpe At' : '📜 Yasa Yürürlüğe Koy';

      if (legDesc) {
        legDesc.textContent = isPresTurn

          ? '3 yasadan ÇÖPE ATACAĞIN kartı seç (kalan 2 yasa Şansölye\'ye gider).'
          : '2 yasadan YÜRÜRLÜĞÜNE KOYACAĞIN kartı seç (diğeri çöpe gider).';
      }


      if (handEl) {
        handEl.innerHTML = '';
        deck.legislativeHand.forEach((policyType, idx) => {
          const isLib = policyType === 'liberal';
          const cardBtn = el('button', null, `policy-card ${isLib ? 'liberal' : 'fascist'}`);
          cardBtn.type = 'button';
          cardBtn.dataset.index = String(idx);
          cardBtn.appendChild(el('span', isLib ? '🕊️' : '🐍', 'policy-icon'));
          cardBtn.appendChild(el('span', isLib ? 'LİBERAL' : 'FAŞİST', 'policy-name'));
          handEl.appendChild(cardBtn);
        });
      }

      if (btnDiscard) {
        btnDiscard.classList.toggle('hidden', !isPresTurn);
        btnDiscard.disabled = true;
      }
      if (btnEnact) {
        btnEnact.classList.toggle('hidden', !isChancTurn);
        btnEnact.disabled = true;
      }
      if (btnVeto) {
        btnVeto.classList.toggle('hidden', !(isChancTurn && board.vetoUnlocked && !government.vetoRefused));
      }
    } else {

      legislativeUI.classList.add('hidden');

    }

  }



  // 4.5) Veto onay ekranı (Şansölye veto teklif etti, Başkan karar verir)

  renderSecretHitlerVetoUI(view, resolveName);


  // 5) Başkanlık güçleri (Yasa Gözetleme, Soruşturma, Özel Seçim, İnfaz)

  renderSecretHitlerExecutiveUI(view, resolveName);


  // 5.5) Oyun sonu: kazanan ve tüm roller
  renderSecretHitlerGameOver(view, resolveName);


  // 6) Oyuncu sırası ve ölen oyuncu bilgisi (ölenler oyunu izlemeye devam eder)
  renderSecretHitlerPlayers(view, resolveName);


  // 7) Herkese açık olayları (yasa, idam, soruşturma...) sırayla animasyonla göster
  processShEvents(view.events, resolveName);

}


// Secret Hitler arayüzünü gizler ve olay animasyonu durumunu sıfırlar (lobiye / ana ekrana dönüşte)

function hideSecretHitlerUI() {
  const c = $('secret-hitler-container');
  if (c) { c.classList.remove('active'); c.classList.add('hidden'); }

  const popup = $('sh-investigate-panel');

  if (popup) popup.classList.add('hidden');

  shLastEventSeq = null;

  shOverlayQueue.length = 0;
  document.querySelectorAll('.sh-overlay').forEach(n => n.remove());

  shOverlayBusy = false;

}


const SH_PHASE_LABEL = {
  LOBBY: 'Hazırlık',

  NOMINATE_CHANCELLOR: 'Şansölye Seçimi',
  VOTE_GOVERNMENT: 'Oylama',
  LEGISLATIVE_PRESIDENT: 'Başkan Yasa Seçiyor',
  LEGISLATIVE_CHANCELLOR: 'Şansölye Yasa Seçiyor',
  VETO_CONFIRM: 'Veto Onayı',
  EXECUTIVE_ACTION: 'Başkanlık Gücü',
  GAME_OVER: 'Oyun Bitti',

};


const SH_POWER_INFO = {
  policy_peek: { icon: '👁️', title: 'Yasa Gözetleme' },
  investigate: { icon: '🔍', title: 'Soruşturma', prompt: 'Kimi soruşturacaksın?' },
  special_election: { icon: '🎩', title: 'Özel Seçim', prompt: 'Sıradaki Başkan adayı kim olsun?' },
  execution: { icon: '🗡️', title: 'İnfaz', prompt: 'Kimi idam edeceksin?' },
};



function renderSecretHitlerVetoUI(view, resolveName) {
  const ui = $('sh-veto-ui');
  if (!ui) return;

  const { phase, government } = view;
  const active = phase === 'VETO_CONFIRM';
  ui.classList.toggle('hidden', !active);
  if (!active) return;


  const isPresident = session.id === government.presidentId;

  const chancName = resolveName(government.chancellorId);

  const desc = $('sh-veto-desc');
  if (desc) {

    if (isPresident) desc.textContent = `Şansölye ${chancName} bu turdaki yasaları veto etmek istiyor. Kabul edersen iki yasa da çöpe gider ve Kaos Sayacı 1 artar.`;

    else if (session.id === government.chancellorId) desc.textContent = 'Veto teklif ettin. Başkan\'ın karar vermesi bekleniyor…';

    else desc.textContent = `Şansölye ${chancName} veto teklif etti. ${resolveName(government.presidentId)} karar veriyor…`;
  }
  const actions = $('sh-veto-actions');
  if (actions) actions.classList.toggle('hidden', !isPresident);
}


const SH_REASON_TEXT = {

  liberal_policies: '🕊️ 5 Liberal yasa yürürlüğe girdi.',

  fascist_policies: '🐍 6 Faşist yasa yürürlüğe girdi.',

  hitler_chancellor: '💀 3. Faşist yasadan sonra Hitler Şansölye seçildi.',
  hitler_executed: '🗡️ Hitler idam edildi.',

};
const SH_ROLE_END_LABEL = { liberal: '🕊️ Liberal', fascist: '🐍 Faşist', hitler: '💀 Hitler' };

function renderSecretHitlerGameOver(view, resolveName) {
  const ui = $('sh-gameover-ui');

  if (!ui) return;
  const over = view.phase === 'GAME_OVER';
  ui.classList.toggle('hidden', !over);

  if (!over) return;


  const libWon = view.winner === 'liberal';

  const titleEl = $('sh-gameover-title');
  titleEl.textContent = libWon ? '🕊️ LİBERALLER KAZANDI' : '🐍 FAŞİSTLER KAZANDI';
  titleEl.className = 'sh-gameover-title ' + (libWon ? 'liberal' : 'fascist');
  $('sh-gameover-reason').textContent = SH_REASON_TEXT[view.winReason] || '';


  const rolesEl = $('sh-gameover-roles');
  rolesEl.innerHTML = '';
  view.seatOrder.forEach(pid => {
    const role = view.roles.get(pid);
    if (!role) return;

    const dead = !view.alive.has(pid);
    const li = el('li', null, 'role-' + role);
    li.appendChild(el('span', resolveName(pid) + (pid === session.id ? ' (sen)' : '') + (dead ? ' 💀' : '')));
    li.appendChild(el('strong', SH_ROLE_END_LABEL[role] || role));
    rolesEl.appendChild(li);

  });


  const actions = $('sh-gameover-actions');

  actions.innerHTML = '';

  if (host) actions.appendChild(button('🏠 Lobiye Dön', 'primary', () => sendToHost({ t: 'backToLobby' })));

  else actions.appendChild(el('p', 'Host lobiyi açınca otomatik geçilecek…', 'msg'));
  actions.appendChild(button('🚪 Odadan Ayrıl', '', leaveRoom));
}


function renderSecretHitlerExecutiveUI(view, resolveName) {

  const { phase, pendingPower, government, alive, investigatedIds } = view;

  const ui = $('sh-executive-ui');
  const popup = $('sh-investigate-panel');
  const info = SH_POWER_INFO[pendingPower];
  const active = phase === 'EXECUTIVE_ACTION' && !!info;
  const isActor = active && session.id === government.presidentCandidateId;


  // Soruşturma sonucu pop-up'ı (yalnızca Başkan'da, "Tamam"a basılana kadar önde kalır)
  const showResult = isActor && pendingPower === 'investigate' && !!view.executiveResult;
  if (popup) {

    popup.classList.toggle('hidden', !showResult);

    if (showResult) {
      const { targetId, party } = view.executiveResult;

      const isLib = party === 'liberal';

      const nameEl = $('sh-investigate-name');
      const partyEl = $('sh-investigate-party');
      if (nameEl) nameEl.textContent = `${resolveName(targetId)} oyuncusunun partisi:`;
      if (partyEl) {
        partyEl.textContent = isLib ? '🕊️ LİBERAL' : '🐍 FAŞİST';
        partyEl.className = 'sh-party-badge ' + (isLib ? 'liberal' : 'fascist');

      }
    }
  }


  if (!ui) return;

  ui.classList.toggle('hidden', !active);

  if (!active) return;


  const titleEl = $('sh-exec-title');
  const descEl = $('sh-exec-desc');

  const peekEl = $('sh-exec-peek');

  const listEl = $('sh-exec-list');
  const okBtn = $('btn-exec-ok');


  if (titleEl) titleEl.textContent = `${info.icon} ${info.title}`;
  peekEl.innerHTML = '';

  listEl.innerHTML = '';

  peekEl.classList.add('hidden');
  okBtn.classList.add('hidden');


  if (!isActor) {

    descEl.textContent = `${resolveName(government.presidentCandidateId)} ${info.title} gücünü kullanıyor…`;

    return;

  }


  if (pendingPower === 'policy_peek') {

    descEl.textContent = 'Destenin en üstündeki 3 yasa (yalnızca sen görebilirsin):';

    peekEl.classList.remove('hidden');
    view.peekCards.forEach(policyType => {
      const isLib = policyType === 'liberal';
      const card = el('div', null, `policy-card ${isLib ? 'liberal' : 'fascist'} peek`);
      card.appendChild(el('span', isLib ? '🕊️' : '🐍', 'policy-icon'));
      card.appendChild(el('span', isLib ? 'LİBERAL' : 'FAŞİST', 'policy-name'));

      peekEl.appendChild(card);

    });
    okBtn.classList.remove('hidden');
    return;

  }


  if (view.executiveResult) {
    descEl.textContent = 'Soruşturma sonucu ekrana geldi.';

    return;
  }


  descEl.textContent = info.prompt;
  alive.forEach(targetId => {

    if (targetId === session.id) return;

    if (pendingPower === 'investigate' && investigatedIds.has(targetId)) return;
    const btn = el('button', resolveName(targetId), 'btn pick');
    btn.type = 'button';

    btn.onclick = () => {

      if (pendingPower === 'execution' && !confirm(`${resolveName(targetId)} idam edilsin mi?`)) return;
      sendToHost({ t: 'sh_action', action: 'executive_power', targetId });
    };
    listEl.appendChild(btn);
  });

}


function renderSecretHitlerPlayers(view, resolveName) {

  const listEl = $('sh-players');
  if (listEl) {

    listEl.innerHTML = '';

    view.seatOrder.forEach(pid => {
      const isAlive = view.alive.has(pid);
      const tags = [];
      if (isAlive && pid === view.government.presidentCandidateId) tags.push('👑');
      if (!isAlive) tags.push('💀');
      if ((view.notHitlerIds || []).includes(pid) && view.phase !== 'GAME_OVER') tags.push('✅ Hitler değil');
      const label = `${resolveName(pid)}${pid === session.id ? ' (sen)' : ''}${tags.length ? ' ' + tags.join(' ') : ''}`;

      listEl.appendChild(el('li', label, isAlive ? '' : 'dead'));
    });

  }
  const deadBanner = $('sh-dead-banner');
  if (deadBanner) {
    const isDead = view.phase !== 'GAME_OVER' && view.seatOrder.includes(session.id) && !view.alive.has(session.id);
    deadBanner.classList.toggle('hidden', !isDead);
  }
}


/* ===== Secret Hitler: Olay animasyonları (yasa, idam, soruşturma, özel seçim, gözetleme) ===== */

let shLastEventSeq = null;
const shOverlayQueue = [];
let shOverlayBusy = false;


function processShEvents(events, resolveName) {
  if (!Array.isArray(events)) return;

  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);

  // İlk senkronda (geç katılma / yenileme) eski olaylar tekrar oynatılmaz
  if (shLastEventSeq === null) { shLastEventSeq = maxSeq; return; }

  if (maxSeq < shLastEventSeq) shLastEventSeq = 0;       // yeni oyun başladı

  events

    .filter(e => e.seq > shLastEventSeq)
    .sort((a, b) => a.seq - b.seq)
    .forEach(e => {

      const overlay = describeShEvent(e, resolveName);

      if (overlay) queueShOverlay(overlay);
    });
  shLastEventSeq = Math.max(shLastEventSeq, maxSeq);
}


function describeShEvent(e, resolveName) {
  const me = session.id;
  switch (e.type) {

    case 'policy':
      return e.policy === 'liberal'
        ? { icon: '🕊️', title: 'LİBERAL YASA', text: e.chaos ? 'Kaos! Destenin üstündeki yasa oylamasız yürürlüğe girdi.' : 'Yürürlüğe girdi.', cls: 'liberal', buzz: [50] }
        : { icon: '🐍', title: 'FAŞİST YASA', text: e.chaos ? 'Kaos! Destenin üstündeki yasa oylamasız yürürlüğe girdi.' : 'Yürürlüğe girdi.', cls: 'fascist', buzz: [80, 40, 80] };
    case 'execution':
      return e.targetId === me
        ? { icon: '💀', title: 'İDAM EDİLDİN', text: 'Artık oynayamazsın ama oyunu izlemeye devam edebilirsin.', cls: 'execution', buzz: [200, 80, 300], duration: 3200 }
        : { icon: '🗡️', title: 'İNFAZ', text: `${resolveName(e.presidentId)}, ${resolveName(e.targetId)} oyuncusunu idam etti.`, cls: 'execution', buzz: [120, 60, 160], duration: 3000 };
    case 'investigate':
      if (e.presidentId === me) return null;     // Başkan sonucu zaten pop-up olarak görüyor
      return { icon: '🔍', title: 'SORUŞTURMA', text: `${resolveName(e.presidentId)}, ${resolveName(e.targetId)} oyuncusunun partisini inceledi.`, cls: 'neutral' };
    case 'special_election':

      return { icon: '🎩', title: 'ÖZEL SEÇİM', text: `${resolveName(e.presidentId)}, ${resolveName(e.targetId)} oyuncusunu sonraki Başkan adayı yaptı.`, cls: 'neutral', duration: 2800 };
    case 'not_hitler':
      return { icon: '✅', title: 'HİTLER DEĞİL', text: `${resolveName(e.chancellorId)} Şansölye seçildi ve Hitler değil.`, cls: 'neutral', duration: 2600 };
    case 'veto_accepted':

      return { icon: '🚫', title: 'VETO KABUL EDİLDİ', text: 'Başkan vetoyu kabul etti. İki yasa da çöpe gitti, Kaos Sayacı 1 arttı.', cls: 'neutral', duration: 2800 };
    case 'veto_rejected':
      return { icon: '✋', title: 'VETO REDDEDİLDİ', text: 'Şansölye iki yasadan birini yürürlüğe koymak zorunda.', cls: 'neutral', duration: 2600 };
    case 'policy_peek':

      if (e.presidentId === me) return null;
      return { icon: '👁️', title: 'YASA GÖZETLEME', text: `${resolveName(e.presidentId)} destenin üstündeki 3 yasaya baktı.`, cls: 'neutral' };

    default:

      return null;

  }
}


function queueShOverlay(o) {

  shOverlayQueue.push(o);
  runShOverlayQueue();
}


function runShOverlayQueue() {
  if (shOverlayBusy) return;

  const o = shOverlayQueue.shift();
  if (!o) return;

  shOverlayBusy = true;


  const node = document.createElement('div');
  node.className = 'sh-overlay ' + (o.cls || '');
  const box = el('div', null, 'sh-overlay-box');
  box.appendChild(el('div', o.icon, 'sh-overlay-icon'));
  box.appendChild(el('div', o.title, 'sh-overlay-title'));
  box.appendChild(el('div', o.text, 'sh-overlay-text'));
  node.appendChild(box);
  document.body.appendChild(node);
  buzz(o.buzz || [40]);


  let done = false;
  const finish = () => {

    if (done) return;
    done = true;
    node.classList.add('out');
    setTimeout(() => {

      node.remove();
      shOverlayBusy = false;
      runShOverlayQueue();

    }, 350);
  };

  node.addEventListener('click', finish);        // dokununca erken kapanır
  setTimeout(finish, o.duration || 2200);
}


const session = {
  get id() {
    let v = sessionStorage.getItem('vk_pid');
    if (!v) { v = secureRandom().toString(36).slice(2, 10); sessionStorage.setItem('vk_pid', v); }
    return v;
  },
  get name() { return sessionStorage.getItem('vk_name') || ''; },
  set name(v) { sessionStorage.setItem('vk_name', v); },
};

// --- UI yardımcıları ---
let countdownPlayedForCurrentGame = false;
let countdownTimer = null;

function playStartCountdown(onComplete) {
  const overlay = $('countdown-overlay');
  const numEl = $('countdown-number');
  if (!overlay || !numEl) {
    if (typeof onComplete === 'function') onComplete();
    return;
  }

  clearInterval(countdownTimer);
  let count = 3;
  overlay.classList.remove('hidden');

  const tick = (val) => {
    numEl.textContent = String(val);
    // CSS animasyonunu her saniye yeniden tetikle
    numEl.style.animation = 'none';
    void numEl.offsetWidth;
    numEl.style.animation = '';
    buzz(25);
  };

  tick(count);
  countdownTimer = setInterval(() => {
    count -= 1;
    if (count > 0) {
      tick(count);
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      overlay.classList.add('hidden');
      buzz([40, 50, 40]);
      if (typeof onComplete === 'function') onComplete();
    }
  }, 1000);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
}
function homeMsg(t, err = true) { const m = $('home-msg'); m.textContent = t; m.classList.toggle('err', err); }

function renderLobby(state) {

  countdownPlayedForCurrentGame = false;
  hideSecretHitlerUI();
  if ($('game-mode-select') && state.gameMode) $('game-mode-select').value = state.gameMode;
  $('room-code').textContent = state.code;
  $('player-count').textContent = state.players.length;
  $('player-list').innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name + (p.host ? ' 👑' : '') + (p.id === session.id ? ' (sen)' : '') + (p.online ? '' : ' — bağlantı yok');
    if (!p.online) li.classList.add('off');
    $('player-list').appendChild(li);
  });
  $('cfg-view').textContent = state.gameMode === 'sh'
    ? '🕵️ Mod: Secret Hitler (5–10 Oyuncu)'
    : SPECIAL_ROLES.concat('villager').filter(r => state.cfg[r] > 0).map(r => `${ROLE_LABEL[r]}: ${state.cfg[r]}`).join(' · ') + (state.cfg.vigilante > 0 ? ` · 🔫 Mermi: ${state.cfg.bullets}` : '');
}

/* =====================================================
 *  HOST: oyun motoru (ileride State Machine) + PeerJS
 *  Host'un kendi hamleleri WebRTC'ye girmeden doğrudan
 *  handleMessage(session.id, msg) ile motora iletilir.
 * ===================================================== */
class Host {
  constructor(name, gameMode = 'vampire') {
    this.name = name;
    this.gameMode = gameMode;
    this.code = null;
    this.peer = null;
    this.conns = new Map();     // playerId -> DataConnection
    this.players = new Map();   // playerId -> {id,name,host,online}
    this.cfg = { vampire: 1, forger: 0, doctor: 0, bodyguard: 0, vigilante: 0, medium: 0, investigator: 0,
      tracker: 0, jester: 0, amnesiac: 0, villager: 2, bullets: 1 };
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
    this.vampPicks = new Map();      // vampir id -> anlık seçili hedef (dinamik oylama)
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
    this.amnesiacTransformed = new Map(); // unutkan id -> dönüştüğü yeni rol
    this.amnesiacNoticeTonight = false;   // bu gece başında unutkan dönüştü mü (sabah duyurusu için)
    this.vampNewMembers = [];             // bu gece vampir takımına dönüşen unutkanlar (tek gecelik bildirim)
    this.graveChat = [];             // Mezarlık sohbeti [{from,text,dead}]
    this.winner = null;
    this.nightDead = new Set();      // yalnızca bu gece ölenlere ölüm animasyonu gösterilir
    this.timer = null;
    this.dayEnd = 0;
    this.secretHitlerState = createSecretHitlerState();
    this.players.set(session.id, { id: session.id, name, host: true, online: true });
  }

  start(attempt = 0) {
    this.code = (attempt === 0 && DEV_ROOM) ? DEV_ROOM : String(Math.floor(10000 + secureRandom() * 90000));   // 5 haneli (test modunda sabit kod)
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

        if (this.gameStarted && this.gameMode === 'sh') return;   // Secret Hitler oyunu sürerken lobi yayını yapılmaz
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
        if (this.gameStarted) {
          if (this.gameMode === 'sh') broadcastSecretHitlerState();
          else { this.sendState(msg.id); this.broadcastState(); }
          break;
        }
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
      case 'vampPick':                                // vampir listeden birini seçtiğinde anlık olarak takımına yansır
        if (this.phase !== 'NIGHT' || !this.alive.has(pid) || !this.isKiller(pid) || this.nightChoices.has(pid)) return;
        if (msg.target && this.targetsFor(pid).includes(msg.target)) this.vampPicks.set(pid, msg.target);
        this.players.forEach((_, id) => { if (this.isVamp(id)) this.sendState(id); });
        break;
      case 'nightConfirm':
        if (this.phase !== 'NIGHT' || !this.alive.has(pid)) return;
        this.nightChoices.set(pid, msg.target);
        if (this.isKiller(pid) && msg.target) this.vampPicks.set(pid, msg.target);
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
        this.graveChat.push({ text });
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
        if (pid === session.id && this.currentPhase() === 'GAME_OVER') this.resetToLobby();

        break;

      case 'leave': {                                 // oyuncu odadan ayrıldı (lobi/oyun sonu)

        const curPhase = this.currentPhase();
        if (pid === session.id || !['LOBBY', 'GAME_OVER'].includes(curPhase)) return;
        const c = this.conns.get(pid);
        this.conns.delete(pid);                       // close olayı oyuncuyu tekrar işlemesin
        if (c) try { c.close(); } catch (e) {}
        this.players.delete(pid); this.alive.delete(pid); this.ready.delete(pid);
        if (curPhase === 'LOBBY') { this.normalizeCfg(false); this.broadcastLobby(); }

        else if (this.gameMode === 'sh') broadcastSecretHitlerState();

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
        if (pid !== session.id || this.phase !== 'LOBBY' || this.gameStarted) return;

        this.startGame();
        break;
      case 'sh_action': {
        if (this.gameMode !== 'sh') return;
        const { government, alive } = secretHitlerState;

        switch (msg.action) {
          case 'nominate': {
            if (secretHitlerState.phase !== 'NOMINATE_CHANCELLOR') return;
            if (pid !== government.presidentCandidateId) return;
            const targetId = msg.targetId;
            if (!targetId || !alive.has(targetId) || targetId === pid || government.termLimitedIds.includes(targetId)) return;
            government.chancellorCandidateId = targetId;
            secretHitlerState.phase = 'VOTE_GOVERNMENT';
            secretHitlerState.votes.clear();
            break;
          }
          case 'vote':
            handleVote(pid, Boolean(msg.voteBool));
            break;
          case 'discard':
            if (pid !== government.presidentId) return;
            handleLegislativeDiscard(Number(msg.cardIndex), 'president');
            break;
          case 'enact':
            if (pid !== government.chancellorId) return;
            handleLegislativeDiscard(Number(msg.cardIndex), 'chancellor');
            break;
          case 'veto': {
            const byWhom = msg.byWhom || (secretHitlerState.phase === 'VETO_CONFIRM' ? 'president' : 'chancellor');
            if (byWhom === 'chancellor' && pid !== government.chancellorId) return;
            if (byWhom === 'president' && pid !== government.presidentId) return;
            handleVeto(Boolean(msg.voteBool), byWhom);
            break;
          }
          case 'executive_power':

            handleExecutiveAction(pid, msg.targetId);

            break;
          case 'executive_ack':

            handleExecutiveAck(pid);
            break;
          default:
            return;
        }

        this.broadcastSecretHitlerState();
        break;
      }
    }
  }

  broadcastSecretHitlerState() {
    broadcastSecretHitlerState();
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
    if (to === 'NIGHT') {
      this.round++; this.nightChoices.clear(); this.vampPicks.clear(); this.nightTexts.clear(); this.nightDead.clear();
      this.amnesiacNoticeTonight = false; this.vampNewMembers = [];
      this.triggerAmnesiacs();
    }
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
  // Mezarlıkta >= 3 ölü olduğunda takip eden gecenin başında hayattaki Unutkan(lar) ölülerden rastgele birinin rolüne dönüşür
  triggerAmnesiacs() {
    const deadIds = [...this.players.keys()].filter(id => !this.alive.has(id));
    if (deadIds.length < 3) return;
    const pool = deadIds.map(id => this.roles.get(id)).filter(r => r && r !== 'amnesiac');
    if (!pool.length) return;
    [...this.alive].filter(id => this.roles.get(id) === 'amnesiac' && !this.amnesiacTransformed.has(id)).forEach(id => {
      const newRole = pool[Math.floor(secureRandom() * pool.length)];
      this.roles.set(id, newRole);
      this.amnesiacTransformed.set(id, newRole);
      this.amnesiacNoticeTonight = true;
      if (newRole === 'vigilante') this.bullets.set(id, this.cfg.bullets);
      this.invGroup.delete(id);
      this.addNote(id, `🧠 Hafızan yerine geldi! Artık yeni rolün: ${ROLE_LABEL[newRole]}`);
      if (VAMP_TEAM.includes(newRole)) this.vampNewMembers.push(this.nameOf(id));
    });
  }
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
      const t = this.nightChoices.get(id) || (this.isKiller(id) ? this.vampPicks.get(id) : null);
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
    // Masum kasabalıyı vuran infazcı aynı gecenin sonunda (direkt sabahına) vicdan azabından intihar eder
    guiltNew.forEach(id => { if (!deaths.has(id)) deaths.set(id, 'guilt'); });

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
    this.eventText = (lines.length ? lines.join('\n') : '🌙 Bu gece kimse ölmedi.') +
      (this.amnesiacNoticeTonight ? '\n🧠 Unutkan kim olduğunu hatırladı.' : '');
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
    this.nightChoices.clear(); this.vampPicks.clear(); this.nightTexts.clear(); this.trialVotes.clear(); this.execVotes.clear();
    this.lastProtected.clear(); this.wills.clear(); this.notes.clear(); this.bullets.clear();
    this.guilty.clear(); this.invGroup.clear(); this.amnesiacTransformed.clear();
    this.amnesiacNoticeTonight = false; this.vampNewMembers = [];
    this.graveChat = []; this.nightDead.clear(); this.deathWills = [];
    this.round = 0; this.eventText = null; this.winner = null;
  }

  // Oyun aşaması: Secret Hitler'da Host.phase hep 'LOBBY' kaldığı için oyunun gerçek aşaması buradan okunur
  currentPhase() {

    if (this.gameMode !== 'sh') return this.phase;
    if (!this.gameStarted) return 'LOBBY';
    return secretHitlerState.phase === 'GAME_OVER' ? 'GAME_OVER' : 'PLAYING';
  }


  // Oyun bitti → herkesi aynı odanın lobisine döndür (bağlantısı kopanlar listeden çıkar)

  resetToLobby() {

    clearTimeout(this.timer);
    if (this.gameMode === 'sh') {
      Object.assign(secretHitlerState, createSecretHitlerState());

      Object.assign(secretHitlerHostView, createSecretHitlerState());
    }
    [...this.players].forEach(([id, p]) => { if (!p.online) this.players.delete(id); });
    this.phase = 'LOBBY';
    this.gameStarted = false;
    this.clearGameState();
    this.normalizeCfg(true);

    document.body.className = '';

    sessionStorage.removeItem('vk_role'); myRole = null;

    hideSecretHitlerUI();

    showScreen('screen-lobby');

    $('host-config').classList.remove('hidden');
    $('client-wait').classList.add('hidden');
    this.broadcastLobby();
  }

  startGame() {
    if (this.gameMode === 'sh') {
      const n = this.total();
      if (n < 5 || n > 10) return;
      this.gameStarted = true;
      initSecretHitler([...this.players.keys()]);
      broadcastSecretHitlerState();
      return;
    }
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
    let candidates = [], acted = false, actedCount = 0, kind = null, skip = false, needsText = false, vampSummary = '';
    if (this.phase === 'NIGHT') {
      // Gerçek yeteneği olanlar gerçek hedef listesi, diğerleri sahte "kim ölecek?" listesi görür (anti-meta)
      if (meAlive) {
        kind = this.kindOf(pid);
        const killers = iAmVamp ? [...this.alive].filter(id => this.isKiller(id)) : [];
        const vampCounts = new Map();
        killers.forEach(kId => {
          const t = this.nightChoices.get(kId) || this.vampPicks.get(kId);
          if (t && this.targetsFor(kId).includes(t)) vampCounts.set(t, (vampCounts.get(t) || 0) + 1);
        });
        if (vampCounts.size) {
          vampSummary = '🧛 Vampir hedefi: ' + [...vampCounts].map(([t, c]) => `${this.nameOf(t)} (${c}/${killers.length})`).join(' · ');
        }
        candidates = kind === 'fake' ? [] : this.targetsFor(pid).map(id => ({
          id, name: this.nameOf(id), vampCount: vampCounts.get(id) || 0, vampTotal: killers.length,
        }));
        skip = kind === 'shoot';
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
      candidates, kind, skip, needsText, vampSummary,
      teamAlert: (this.phase === 'NIGHT' && iAmVamp && this.vampNewMembers.length) ? '🧛 Yeni bir üye katıldı: ' + this.vampNewMembers.join(', ') : null,
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
      amnesiacFrom: this.phase === 'GAME_OVER' ? Object.fromEntries(this.amnesiacTransformed) : null,
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
    return { code: this.code, gameMode: this.gameMode, players: [...this.players.values()], cfg: { ...this.cfg } };
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
  const isSH = state.gameMode === 'sh';
  $('role-steppers').classList.toggle('hidden', isSH);

  if (isSH) {
    const valid = n >= 5 && n <= 10;
    $('btn-start').disabled = !valid;
    $('cfg-hint').textContent =
      n < 5 ? `Secret Hitler için en az 5 oyuncu gerekli (${n}/5).` :
      n > 10 ? 'Secret Hitler en fazla 10 oyuncu ile oynanır.' :
      `Hazır! (${n} oyuncu · Secret Hitler)`;
    return;
  }

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

  cleanupConnection() {
    clearTimeout(this.retryTimer); clearTimeout(this.connTimer);
    try { this.conn && this.conn.close(); } catch (e) {}
    try { this.peer && this.peer.destroy(); } catch (e) {}
  }

  // (Yeniden) bağlan: aynı kalıcı id + isim ile 'join' gönderilir, Host rolü/durumu geri yollar
  connect() {
    if (this.gaveUp) return;
    this.cleanupConnection();
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
    this.cleanupConnection();
    sessionStorage.removeItem('vk_room'); sessionStorage.removeItem('vk_role');
    myRole = null;

    setOverlay(false);

    document.body.className = '';

    hideSecretHitlerUI();

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
    } else if (m.type === 'SECRET_HITLER_SYNC' || m.t === 'SECRET_HITLER_SYNC') {
      this.joined = true;
      sessionStorage.setItem('vk_room', this.code);
      setOverlay(false);
      onSecretHitlerSync(m.data);
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

    hideSecretHitlerUI();
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

  // Görünürlük kontrolü: Secret Hitler ekranını gizle, Vampir oyun ekranını hazır tut
  const shContainer = $('secret-hitler-container');
  if (shContainer) {
    shContainer.classList.remove('active');
    shContainer.classList.add('hidden');
  }
  const gameScreen = $('screen-game');
  if (gameScreen) gameScreen.classList.remove('hidden');

  const v = m.view;
  myRole = v.role;
  if (v.role) sessionStorage.setItem('vk_role', v.role);

  if (v.phase === 'ROLE_REVEAL') {
    if (!countdownPlayedForCurrentGame) {
      countdownPlayedForCurrentGame = true;
      playStartCountdown();
    }
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
  $('my-name').textContent = session.name;
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
      const label = c.vampCount > 0 ? `${c.name}  ·  🧛 ${c.vampCount}/${c.vampTotal}` : c.name;
      const b = el('button', label, 'btn pick' + (selected === c.id ? ' sel' : ''));
      b.onclick = () => { selected = c.id; buzz(); if (v.kind === 'kill') sendToHost({ t: 'vampPick', target: c.id }); else renderGame(v); };
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
    if (v.teamAlert) body.appendChild(el('p', v.teamAlert, 'banner'));
    if (v.vampSummary) body.appendChild(el('p', v.vampSummary, 'banner'));
    notes();
    if (!me.alive) body.appendChild(el('p', '💀 Öldün. Gece geçiyor…', 'msg'));
    else if (v.acted) { body.appendChild(el('p', '💤 Uyudun.', 'big')); waiting(); }
    else if (v.kind === 'fake') {
      body.appendChild(el('p', '🌙 Bu gece kullanacak bir yeteneğin yok.', 'msg'));
      body.appendChild(button('💤 Uyu', 'primary', () => { buzz([30, 40, 30]); sendToHost({ t: 'nightConfirm', target: 'skip' }); }));
    }
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
      el('p', `${p.name}: ${v.roles[p.id] === 'amnesiac' ? '🧠 UNUTKAN (Kaybetti ❌)' : (v.amnesiacFrom && v.amnesiacFrom[p.id] ? '🧠 Unutkan ➔ ' + ROLE_LABEL[v.roles[p.id]] : ROLE_LABEL[v.roles[p.id]])}${p.alive ? '' : ' 💀'}`, 'msg')));
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
  ['🔁 Oyun akışı', 'Gece özel rolü olanlar yeteneklerini kullanır. Sabah ölenler ve vasiyetleri açıklanır, ardından tartışma, yargılama ve infaz oylaması yapılır. Ölenlerin rolü oyun bitene kadar gizli kalır.'],
  ['📝 Vasiyetname', 'Hayattayken istediğin an yazıp güncelleyebilirsin. Öldüğünde herkese açık gösterilir. (Sahteci bunu değiştirebilir.)'],
  ['⚰️ Mezarlık', 'Medyum geceleri ölülerle yazışır. Diğer oyuncular geceleri bu panele bakabilir ama kimse yanıt vermez.'],
];

const ABOUT_TEXT_SH = [
  ['🎯 Amaç', 'Liberaller 5 Liberal yasa çıkararak veya Hitler\'i öldürerek kazanır. Faşistler 6 Faşist yasa çıkararak veya 3. Faşist yasadan sonra Hitler\'i Şansölye seçtirerek kazanır.'],
  ['🔁 Oyun Akışı', 'Her tur sıradaki Başkan adayı bir Şansölye adayı seçer. Hayatta olan herkes Ja! (Evet) veya Nein! (Hayır) oyu verir. Çoğunluk Ja derse hükümet kurulur; beraberlik veya Nein ise seçim başarısız olur. Kurulan hükümette Başkan 3 yasa kartı çeker, 1\'ini çöpe atar ve kalan 2\'yi Şansölye\'ye verir. Şansölye de 1\'ini atar, kalan yasa yürürlüğe girer.'],
  ['🤫 Gizli Roller', 'Herkes oyun başında gizli bir rol alır. Rolünü görmek için ekranın üstündeki rol kartına basılı tut, bırakınca gizlenir. Faşistler rol kartında diğer Faşistleri ve Hitler\'i de görür. Hitler ise kimseyi tanımaz, Liberaller de yalnızca kendi rollerini bilir.'],
  ['🕊️ Liberal', 'Faşistleri ve Hitler\'i bulmaya çalışır. Yalnızca kendi rolünü bilir.'],
  ['🐍 Faşist', 'Hitler\'in kim olduğunu ve diğer Faşistleri bilir. Liberalleri kandırıp Faşist yasa çıkarmaya ve Hitler\'i iktidara taşımaya çalışır.'],
  ['💀 Hitler', 'Faşist takımındadır ama Faşistlerin kim olduğunu bilmez, Faşistler onu tanır. 3. Faşist yasadan sonra Şansölye seçilirse Faşistler oyunu hemen kazanır; öldürülürse Liberaller kazanır.'],
  ['👥 Rol Dağılımı', '5 oyuncu: 3 Liberal, 1 Faşist, Hitler\n6 oyuncu: 4 Liberal, 1 Faşist, Hitler\n7 oyuncu: 4 Liberal, 2 Faşist, Hitler\n8 oyuncu: 5 Liberal, 2 Faşist, Hitler\n9 oyuncu: 5 Liberal, 3 Faşist, Hitler\n10 oyuncu: 6 Liberal, 3 Faşist, Hitler'],
  ['✅ Hitler Değil', '3. Faşist yasadan sonra Hitler olmayan biri Şansölye seçilirse herkese "Hitler değil" duyurusu yapılır ve oyuncunun adının yanında oyun boyunca ✅ işareti kalır.'],
  ['🚫 Dönem Sınırı', 'Bir önceki hükümetin Şansölyesi bir sonraki turda Şansölye adayı olamaz. 6 veya daha fazla oyuncu hayattaysa önceki Başkan da aday olamaz.'],
  ['⚡ Kaos Sayacı', 'Üst üste 3 hükümet reddedilirse destenin en üstündeki yasa oylamasız yürürlüğe girer, sayaç sıfırlanır ve dönem sınırları kalkar. Kaosla çıkan yasa Faşist olsa bile tahtadaki Başkanlık gücü kullanılmaz, atlanır.'],
];

const SH_POWERS_INTRO = 'Bir Faşist yasa yürürlüğe girdiğinde, tahtadaki ilgili yuvada ikon varsa o turun Başkanı bu gücü kullanır. Hangi yuvada hangi gücün çıkacağı oyuncu sayısına göre değişir:';

const SH_POWERS = [
  ['👁️ Yasa Gözetleme (Policy Peek)', 'Başkan destenin en üstündeki 3 yasa kartını görür ve "Tamam" diyerek oyunu devam ettirir. Kartlar yerinden çıkarılmaz.'],
  ['🔍 Soruşturma (Investigate)', 'Başkan bir oyuncu seçer; o oyuncunun parti üyeliği (Liberal/Faşist) yalnızca Başkan\'a pop-up olarak gösterilir. Hitler Faşist olarak görünür. Aynı oyuncu bir daha incelenemez.'],
  ['🎩 Özel Seçim (Special Election)', 'Başkan, sıradaki tur için kendi seçtiği bir oyuncuyu Başkan adayı yapar. Sonrasında normal sıra kaldığı yerden devam eder.'],
  ['🗡️ İnfaz (Execution)', 'Başkan bir oyuncuyu oyundan çıkarır. Ölen oyuncu sıradan da çıkar ama oyunu izlemeye devam eder. Ölen Hitler ise Liberaller kazanır.'],
  ['🚫 Veto Yetkisi', '5. Faşist yasadan sonra açılır. Şansölye veto teklif eder, Başkan da kabul ederse o turdaki yasalar çöpe gider ve Kaos Sayacı 1 artar.'],
];

const SH_BOARDS = [
  ['👥 5-6 Oyuncu', '3. yasa: Yasa Gözetleme · 4. ve 5. yasa: İnfaz (5. yasadan sonra Veto açılır)'],
  ['👥 7-8 Oyuncu', '2. yasa: Soruşturma · 3. yasa: Özel Seçim · 4. ve 5. yasa: İnfaz (5. yasadan sonra Veto açılır)'],
  ['👥 9-10 Oyuncu', '1. ve 2. yasa: Soruşturma · 3. yasa: Özel Seçim · 4. ve 5. yasa: İnfaz (5. yasadan sonra Veto açılır)'],
];

// Hakkında panelinin hangi oyun modunu anlatacağını belirler (oyun ekranı > lobi/ana ekran modu)
function currentAboutMode() {
  const shContainer = $('secret-hitler-container');
  if (shContainer && shContainer.classList.contains('active')) return 'sh';
  const select = $('game-mode-select');
  return select && select.value === 'sh' ? 'sh' : 'vampire';
}

function openAbout() {
  const b = $('about-body'); b.innerHTML = '';
  if (currentAboutMode() === 'sh') {
    ABOUT_TEXT_SH.forEach(([h, t]) => {
      b.appendChild(el('h3', h, 'about-h'));
      b.appendChild(el('p', t, 'about-p'));
    });
    b.appendChild(el('h3', '⚡ Başkanlık Güçleri', 'about-h'));
    b.appendChild(el('p', SH_POWERS_INTRO, 'about-p'));
    SH_BOARDS.forEach(([title, desc]) => {
      const c = el('div', null, 'about-role');
      c.appendChild(el('strong', title));
      c.appendChild(el('p', desc));
      b.appendChild(c);
    });
    SH_POWERS.forEach(([title, desc]) => {
      const c = el('div', null, 'about-role');
      c.appendChild(el('strong', title));
      c.appendChild(el('p', desc));
      b.appendChild(c);
    });
    openPanel('about-panel');
    return;
  }

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
  team('Tarafsız', ['jester', 'amnesiac']);
  openPanel('about-panel');
}
$('btn-about').onclick = openAbout;
$('btn-about-lobby').onclick = openAbout;
$('btn-about-game').onclick = openAbout;
if ($('btn-about-sh')) $('btn-about-sh').onclick = openAbout;
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
  if (real) v.graveChat.forEach(m => log.appendChild(el('p', `👻 Anonim: ${m.text}`, 'grave-msg')));
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
  const modeSelect = $('game-mode-select');
  const selectedMode = modeSelect ? modeSelect.value : 'vampire';
  sessionStorage.removeItem('vk_room'); sessionStorage.removeItem('vk_role'); myRole = null;
  acquireWakeLock();
  homeMsg('Oda kuruluyor…', false);
  host = new Host(n, selectedMode); host.start();
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
setupSecretHitlerEventListeners();
// Host'un kendi hamleleri: WebRTC yok, doğrudan motora
document.querySelectorAll('.step').forEach(b => b.onclick = () => {
  const role = b.dataset.role;
  host.handleMessage(session.id, { t: 'setCfg', role, value: host.cfg[role] + (+b.dataset.d) });
});
$('btn-start').onclick = () => host.handleMessage(session.id, { t: 'startGame' });


/* ===== Test modu: ?dev=host|join&room=11111&name=Ad (yalnızca test için; normal açılışta çalışmaz) ===== */
(function devMode() {
  const mode = DEV_Q.get('dev');
  if (!mode || !DEV_ROOM) return;
  const name = DEV_Q.get('name') || mode;
  $('inp-name').value = name;
  document.title = name + ' · VK';
  if (mode === 'host') {
    const gameMode = DEV_Q.get('gamemode') || 'sh';
    if ($('game-mode-select')) $('game-mode-select').value = gameMode;
    $('btn-create').onclick();
    const need = +DEV_Q.get('players') || (gameMode === 'sh' ? 7 : 11);
    // Vampir modundaysa herkes girince rolleri ayarla; Secret Hitler modunda roller otomatik dağıtılır
    const iv = setInterval(() => {
      if (!host || host.phase !== 'LOBBY' || host.total() < need) return;
      clearInterval(iv);
      if (host.gameMode === 'vampire') {
        const preset = { vampire: 2, forger: 1, doctor: 1, bodyguard: 1, vigilante: 1, medium: 1, investigator: 1, tracker: 1, jester: 1, bullets: 2 };
        Object.entries(preset).forEach(([role, value]) => host.handleMessage(session.id, { t: 'setCfg', role, value }));
      }
    }, 500);
  } else {
    $('inp-code').value = DEV_ROOM;
    let tries = 0;
    const iv = setInterval(() => {                       // host hazır olana kadar tekrar dene
      if (client && client.joined) return clearInterval(iv);
      if (++tries > 40) return clearInterval(iv);
      if (!client || client.gaveUp) $('btn-join').onclick();
    }, 3000);
    setTimeout(() => { if (!client) $('btn-join').onclick(); }, 1500);
  }
})();
