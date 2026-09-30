import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

/* ------------------------------------------------------------------ */
/*  Konfiguracja                                                       */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  { key: 'be', label: 'Backend' },
  { key: 'fe', label: 'Frontend' },
  { key: 'qa', label: 'Testy' },
];

// Przyciski ulozone po dwa w rzedzie: (1, 1.5) (2, 2.5) (3, 3.5) (4, 5) i na koncu
// (6, pole na wlasna wartosc). Pozostale wartosci wpisuje sie recznie.
const PRESET_VALUES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6];

const MIN_VALUE = 1;
const MAX_VALUE = 15;

const VOTER_STORAGE_KEY = 'wyceniacz.voterId';
const STATE_STORAGE_KEY = 'wyceniacz.state';
const CHANNEL_NAME = 'wyceniacz';

const RESET_LABEL = 'Resetuj';
const RESET_CONFIRM_LABEL = 'Potwierdź reset';
const RESET_CONFIRM_MS = 6000;

// Brak bazy to brak wspolnego magazynu: kazda karta trzyma wlasny obraz glosowania
// i cyklicznie go oglasza. Broadcast nie gwarantuje dostarczenia, wiec dosylka jest
// mechanizmem samonaprawy - bez niej jedna zgubiona wiadomosc rozjechalaby karty.
const HEARTBEAT_MS = 15000;

// Chwila na odpowiedz innych kart. Bez tego swiezo otwarta karta mrugnelaby pustym
// glosowaniem, zanim dowiedzialaby sie, ze ktos juz glosuje.
const PEER_GRACE_MS = 1200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ------------------------------------------------------------------ */
/*  Narzedzia                                                          */
/* ------------------------------------------------------------------ */

const fmt = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '–';
  return String(Math.round(x * 100) / 100);
};

// Zaokraglenie w gore do wielokrotnosci 0.5 (ceiling), np. 3.1 -> 3.5.
// Epsilon neutralizuje bledy reprezentacji zmiennoprzecinkowej: sumy glosow
// maja maksymalnie 2 miejsca po przecinku, wiec srednia rozniona od
// wielokrotnosci 0.5 o mniej niz 1e-9 po prostu nie istnieje i 1e-9 nie moze
// zjesc prawdziwego zaokraglenia.
const ceilHalf = (n) => Math.ceil(n * 2 - 1e-9) / 2;
const round2 = (n) => Math.round(n * 100) / 100;
const msg = (e) => (e && e.message ? e.message : String(e));

const isPreset = (value) => PRESET_VALUES.some((p) => Math.abs(p - value) < 1e-9);

// Polska odmiana: 1 glos, 2-4 glosy, 5+ glosow (a takze 22 glosy, ale 12 glosow).
function votesLabel(n) {
  if (n === 1) return '1 głos';

  const jednosci = n % 10;
  const nastki = n % 100;
  const kilka = jednosci >= 2 && jednosci <= 4 && (nastki < 12 || nastki > 14);

  return kilka ? `${n} głosy` : `${n} głosów`;
}

function safeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function getVoterId() {
  let id = null;
  try {
    id = localStorage.getItem(VOTER_STORAGE_KEY);
  } catch {
    /* tryb prywatny - brak localStorage */
  }

  if (!id || !UUID_RE.test(id)) {
    id = crypto.randomUUID();
    try {
      localStorage.setItem(VOTER_STORAGE_KEY, id);
    } catch {
      /* ignoruj */
    }
  }

  return id;
}

// Klucz dnia w czasie lokalnym. Wchodzi do identyfikatora glosowania, dzieki
// czemu glos z zeszlego tygodnia nie ma jak dopasowac sie do dzisiejszego.
function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Identyfikator glosowania: "<dzien>#<numer w tym dniu>", np. 2026-09-30#2.
const roundDay = (id) => String(id).split('#')[0];

const roundNo = (id) => {
  const n = Number(String(id).split('#')[1]);
  return Number.isFinite(n) ? n : 0;
};

// Porownanie identyfikatorow: najpierw dzien, potem numer. Porownanie samych
// napisow nie wystarczy, bo "#10" wypada przed "#2".
function compareRounds(a, b) {
  const da = roundDay(a);
  const db = roundDay(b);
  if (da !== db) return da < db ? -1 : 1;

  const na = roundNo(a);
  const nb = roundNo(b);
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

function normalizeRound(r) {
  return {
    id: String(r.id),
    status: r.status === 'revealed' ? 'revealed' : 'open',
    revealedAt: r.revealedAt || null,
    jiraUrl: r.jiraUrl || null,
    urlAt: Number(r.urlAt) || 0,
    at: Number(r.at) || 0,
  };
}

/* ------------------------------------------------------------------ */
/*  Stan                                                               */
/* ------------------------------------------------------------------ */

const voterId = getVoterId();

// round  - biezace glosowanie; null tylko przez chwile po starcie, zanim wiemy, co jest grane
// votes  - mapa voterId -> { be?, fe?, qa?, rev }. Wpis jest wlasnoscia jednej osoby:
//          tylko ona go zapisuje, a pozostali go przekazuja i porownuja po "rev".
const state = {
  round: null,
  votes: new Map(),
  online: 0,
};

const refs = Object.create(null);

let channel = null;
let lastRev = 0;
let resetArmed = false;
let resetTimer = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/*  Elementy globalne                                                  */
/* ------------------------------------------------------------------ */

const sectionsEl = document.getElementById('sections');
const fatalEl = document.getElementById('fatal');
const toastEl = document.getElementById('toast');
const statePill = document.getElementById('state-pill');
const onlinePill = document.getElementById('online-pill');
const linkInput = document.getElementById('jira');
const goBtn = document.getElementById('go');
const revealBtn = document.getElementById('reveal');
const resetBtn = document.getElementById('reset');
const sumEl = document.getElementById('sum');

/* ------------------------------------------------------------------ */
/*  Wlasny glos                                                        */
/* ------------------------------------------------------------------ */

const myEntry = () => state.votes.get(voterId) || null;

function myVote(section) {
  const e = myEntry();
  if (!e) return null;
  const v = Number(e[section]);
  return Number.isFinite(v) ? v : null;
}

// "rev" to pieczatka czasu zmiany wlasnego glosu. Musi rosnac, bo dzieki niej
// stare kopie krażace po sieci przegrywaja z nowszymi - bez tego ktos, kto był
// offline, moglby przywrocic glos, ktory wlasciciel juz cofnal.
function nextRev() {
  lastRev = Math.max(Date.now(), lastRev + 1);
  return lastRev;
}

// value === null cofa glos w tej sekcji.
function setMyVote(section, value) {
  const entry = { ...(myEntry() || {}), rev: nextRev() };

  if (value === null) delete entry[section];
  else entry[section] = value;

  state.votes.set(voterId, entry);
}

// Scalenie cudzych glosow. Wpis wygrywa, gdy ma wyzszy "rev" - kopia, ktora krazyla
// po sieci dluzej, przegrywa z nowsza. Kolejnosc wiadomosci nie ma znaczenia.
function mergeVotes(incoming) {
  if (!incoming || typeof incoming !== 'object') return false;

  let changed = false;

  for (const [id, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== 'object') continue;

    const rev = Number(entry.rev) || 0;
    const known = state.votes.get(id);

    if (!known || rev > (Number(known.rev) || 0)) {
      state.votes.set(id, entry);
      changed = true;
    }
  }

  return changed;
}

/* ------------------------------------------------------------------ */
/*  Pamiec lokalna                                                     */
/* ------------------------------------------------------------------ */

function loadStored() {
  let raw = null;
  try {
    raw = localStorage.getItem(STATE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const s = JSON.parse(raw);
    if (!s || typeof s.roundId !== 'string') return null;

    // Twarda polnoc: slad z innego dnia jest martwy. To jest ten warunek,
    // ktory nie pozwala zeszlotygodniowemu glosowi wrocic do nowego glosowania.
    if (roundDay(s.roundId) !== todayKey()) return null;

    return s;
  } catch {
    return null;
  }
}

function persist() {
  if (!state.round) return;

  const votes = {};
  for (const [id, entry] of state.votes) votes[id] = entry;

  try {
    localStorage.setItem(
      STATE_STORAGE_KEY,
      JSON.stringify({
        roundId: state.round.id,
        status: state.round.status,
        revealedAt: state.round.revealedAt,
        jiraUrl: state.round.jiraUrl,
        urlAt: state.round.urlAt,
        at: state.round.at,
        votes,
      })
    );
  } catch {
    /* brak zapisu - apka dziala dalej, tylko bez pamieci */
  }
}

function applyStored() {
  const s = loadStored();
  if (!s) return false;

  state.round = normalizeRound({
    id: s.roundId,
    status: s.status,
    revealedAt: s.revealedAt,
    jiraUrl: s.jiraUrl,
    urlAt: s.urlAt,
    at: s.at,
  });

  state.votes = new Map();
  mergeVotes(s.votes);

  const own = state.votes.get(voterId);
  lastRev = own ? Number(own.rev) || 0 : 0;

  return true;
}

/* ------------------------------------------------------------------ */
/*  Glosowanie                                                         */
/* ------------------------------------------------------------------ */

// Nowe glosowanie uniewaznia wszystkie dotychczasowe glosy - nalezaly do
// poprzedniego. Dlatego zmiana identyfikatora zawsze czysci mape glosow.
function adoptRound(r) {
  state.round = r;
  state.votes.clear();
  persist();
}

function startRound(n) {
  adoptRound(normalizeRound({ id: `${todayKey()}#${n}`, status: 'open', at: Date.now() }));
  renderAll();
  sendState();
}

function resetVoting() {
  const n = state.round ? roundNo(state.round.id) : 0;

  disarmReset();
  linkInput.value = '';
  startRound(Math.max(1, n + 1));
}

function revealVoting() {
  if (!state.round || state.round.status === 'revealed') return;

  const at = Date.now();
  state.round = {
    ...state.round,
    status: 'revealed',
    revealedAt: new Date(at).toISOString(),
    at,
  };

  persist();
  renderAll();
  sendState();
}

function saveLink(raw) {
  if (!state.round) return;

  const at = Date.now();
  state.round = { ...state.round, jiraUrl: raw || null, urlAt: at, at };

  persist();
  renderPanel();
  sendState();
}

// Scalenie cudzego stanu. Zwraca 'adopted' | 'merged' | 'same' | 'older' | 'foreign'.
function mergeRound(incoming) {
  if (!incoming || typeof incoming.id !== 'string') return 'foreign';

  // Glosowanie z innego dnia nie nalezy do nas - wymuszamy swoj dzien.
  if (roundDay(incoming.id) !== todayKey()) return 'foreign';

  const r = normalizeRound(incoming);

  if (!state.round) {
    adoptRound(r);
    return 'adopted';
  }

  const cmp = compareRounds(r.id, state.round.id);

  if (cmp > 0) {
    adoptRound(r);
    return 'adopted';
  }

  if (cmp < 0) return 'older';

  const cur = state.round;
  const merged = {
    ...cur,
    status: cur.status === 'revealed' || r.status === 'revealed' ? 'revealed' : 'open',
    revealedAt: cur.revealedAt || r.revealedAt || null,
    at: Math.max(cur.at, r.at),
  };

  if (r.urlAt > cur.urlAt) {
    merged.jiraUrl = r.jiraUrl;
    merged.urlAt = r.urlAt;
  }

  const changed = merged.status !== cur.status || merged.jiraUrl !== cur.jiraUrl;
  state.round = merged;

  return changed ? 'merged' : 'same';
}

function applyRemote(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.voterId === voterId) return;

  const roundOutcome = mergeRound(payload.round);
  const votesChanged = mergeVotes(payload.votes);

  if (roundOutcome === 'older' || roundOutcome === 'foreign') {
    // Znamy nowsze albo wlasciwe glosowanie - niech nadawca dogoni.
    sendState();
    return;
  }

  if (roundOutcome !== 'same' || votesChanged) {
    persist();
    renderAll();
  }
}

/* ------------------------------------------------------------------ */
/*  Budowa interfejsu (raz)                                            */
/* ------------------------------------------------------------------ */

function buildUI() {
  for (const s of SECTIONS) {
    const col = document.createElement('section');
    col.className = 'col';
    col.dataset.section = s.key;

    const title = document.createElement('h2');
    title.textContent = s.label;
    col.appendChild(title);

    const valuesEl = document.createElement('div');
    valuesEl.className = 'values';
    valuesEl.setAttribute('role', 'group');
    valuesEl.setAttribute('aria-label', `Wycena: ${s.label}`);

    const buttons = [];
    for (const v of PRESET_VALUES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'val';
      b.dataset.value = String(v);
      b.textContent = fmt(v);
      b.addEventListener('click', () => castVote(s.key, v, true));
      valuesEl.appendChild(b);
      buttons.push(b);
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'val-input';
    input.min = String(MIN_VALUE);
    input.max = String(MAX_VALUE);
    input.step = 'any';
    input.inputMode = 'decimal';
    input.placeholder = 'inna';
    input.setAttribute('aria-label', `Inna wartość dla sekcji ${s.label}`);
    valuesEl.appendChild(input);

    col.appendChild(valuesEl);

    const errEl = document.createElement('span');
    errEl.className = 'err';
    col.appendChild(errEl);

    const commit = () => {
      const raw = input.value.trim();

      // Wyczyszczenie pola cofa glos wpisany recznie.
      if (raw === '') {
        errEl.textContent = '';
        const mine = myVote(s.key);
        if (mine !== null && !isPreset(mine)) withdrawVote(s.key);
        return;
      }

      const value = Number(raw.replace(',', '.'));
      if (!Number.isFinite(value) || value < MIN_VALUE || value > MAX_VALUE) {
        errEl.textContent = `Zakres: ${fmt(MIN_VALUE)}–${fmt(MAX_VALUE)} MD`;
        renderSelection(s.key);
        return;
      }

      errEl.textContent = '';
      castVote(s.key, round2(value), false);
    };

    // Pole reaguje juz na pierwszy znak i przejmuje zaznaczenie od przyciskow,
    // zeby nie bylo watpliwosci, ktora wartosc sie liczy.
    input.addEventListener('input', () => {
      errEl.textContent = '';
      renderSelection(s.key);
    });

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        input.blur();
      }
    });

    const result = document.createElement('div');
    result.className = 'result';

    const votesOut = document.createElement('div');
    votesOut.className = 'votes';

    const avgOut = document.createElement('div');
    avgOut.className = 'avg';

    const avgLabel = document.createElement('span');
    avgLabel.className = 'avg-label';

    const avgValue = document.createElement('span');
    avgValue.className = 'avg-value';

    avgOut.append(avgLabel, avgValue);

    result.appendChild(votesOut);
    result.appendChild(avgOut);
    col.appendChild(result);

    sectionsEl.appendChild(col);

    refs[s.key] = { buttons, input, errEl, votesOut, avgOut, avgLabel, avgValue };
  }
}

/* ------------------------------------------------------------------ */
/*  Renderowanie                                                       */
/* ------------------------------------------------------------------ */

function renderOnline() {
  onlinePill.textContent = `Online: ${state.online}`;
}

// Ustala, co jest zaznaczone w danej sekcji. Pole z wpisana wartoscia ma
// pierwszenstwo nad przyciskami: po wybraniu 3 i wpisaniu 9 nie moga swiecic
// oba naraz, bo nie wiadomo, ktora wartosc sie liczy.
function renderSelection(key) {
  const r = refs[key];
  if (!r) return;

  const canVote = Boolean(state.round) && state.round.status === 'open';

  const mineValue = myVote(key);
  const mineIsCustom = mineValue !== null && !isPreset(mineValue);

  // Wpisana, jeszcze niezatwierdzona wartosc tez jest biezacym wyborem.
  const poleMaTresc = r.input.value.trim() !== '';

  r.input.disabled = !canVote;
  r.input.classList.toggle('active', poleMaTresc || mineIsCustom);
  r.input.title = mineIsCustom ? 'Wyczyść pole, aby cofnąć głos' : '';

  const zaznaczonyPreset = !poleMaTresc && mineValue !== null && isPreset(mineValue)
    ? mineValue
    : null;

  for (const b of r.buttons) {
    const v = Number(b.dataset.value);
    const isMine = zaznaczonyPreset !== null && Math.abs(v - zaznaczonyPreset) < 1e-9;
    b.classList.toggle('active', isMine);
    b.disabled = !canVote;
    b.title = isMine ? 'Kliknij ponownie, aby cofnąć głos' : '';
  }
}

// Zbiera glosy wszystkich osob w danej sekcji i liczy srednia (ceiling do 0.5).
function sectionStats(section) {
  const values = [];

  for (const entry of state.votes.values()) {
    const v = Number(entry[section]);
    if (Number.isFinite(v)) values.push(v);
  }

  values.sort((a, b) => a - b);
  if (values.length === 0) return { count: 0, values, avg: null };

  return {
    count: values.length,
    values,
    avg: ceilHalf(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

// Suma = suma trzech zaokraglonych (ceiling do 0.5) srednich sekcji.
// Sekcja bez glosow liczy sie jako 0.
function totalSum() {
  return SECTIONS.reduce((acc, s) => acc + (sectionStats(s.key).avg ?? 0), 0);
}

function renderSections() {
  const status = state.round ? state.round.status : null;
  const revealed = status === 'revealed';

  for (const s of SECTIONS) {
    const r = refs[s.key];
    const stats = sectionStats(s.key);
    const mineValue = myVote(s.key);

    // W trakcie pisania nie nadpisujemy pola - inaczej przerysowanie zgubiloby
    // wpisywana wartosc.
    if (document.activeElement !== r.input) {
      const mineIsCustom = mineValue !== null && !isPreset(mineValue);
      r.input.value = mineIsCustom ? fmt(mineValue) : '';
    }

    renderSelection(s.key);

    if (revealed) {
      r.votesOut.textContent = stats.count ? stats.values.map(fmt).join(', ') : '–';
      r.votesOut.classList.add('revealed');

      r.avgLabel.textContent = 'Średnia';
      r.avgValue.textContent = stats.avg === null ? '–' : `${fmt(stats.avg)} MD`;
      r.avgOut.classList.add('on');
    } else {
      r.votesOut.textContent = votesLabel(stats.count);
      r.votesOut.classList.remove('revealed');

      r.avgLabel.textContent = '';
      r.avgValue.textContent = '';
      r.avgOut.classList.remove('on');
    }
  }
}

function renderPanel() {
  const r = state.round;
  const revealed = Boolean(r) && r.status === 'revealed';

  if (document.activeElement !== linkInput) {
    linkInput.value = r && r.jiraUrl ? r.jiraUrl : '';
  }

  const typed = linkInput.value.trim();
  goBtn.disabled = !safeUrl(typed || (r && r.jiraUrl));

  revealBtn.disabled = revealed;

  resetBtn.textContent = resetArmed ? RESET_CONFIRM_LABEL : RESET_LABEL;
  resetBtn.classList.toggle('armed', resetArmed);
  resetBtn.title = revealed
    ? 'Rozpocznij nowe głosowanie'
    : 'Wyczyść głosy i zacznij od nowa (wymaga potwierdzenia)';

  sumEl.textContent = revealed ? `${fmt(totalSum())} MD` : '–';

  if (!r) {
    statePill.textContent = 'Łączenie…';
    statePill.removeAttribute('data-state');
  } else if (revealed) {
    statePill.textContent = 'Odkryte';
    statePill.dataset.state = 'revealed';
  } else {
    statePill.textContent = 'Zbieranie głosów';
    statePill.dataset.state = 'open';
  }
}

function renderAll() {
  renderSections();
  renderPanel();
  renderOnline();
}

/* ------------------------------------------------------------------ */
/*  Akcje                                                              */
/* ------------------------------------------------------------------ */

function castVote(section, value, fromButton) {
  if (!state.round || state.round.status !== 'open') {
    toast('Głosowanie jest już odkryte — kliknij Resetuj, aby zacząć nowe.');
    return;
  }

  // Klikniecie w przycisk, ktory jest widocznie zaznaczony, cofa glos.
  // Patrzymy na stan interfejsu, a nie na dane: gdy w polu wpisano inna
  // wartosc, przycisk nie jest zaznaczony, wiec klikniecie ma go wybrac,
  // a nie cofac.
  if (fromButton) {
    const idx = PRESET_VALUES.indexOf(value);
    const przycisk = idx >= 0 ? refs[section].buttons[idx] : null;

    if (przycisk && przycisk.classList.contains('active')) {
      withdrawVote(section);
      return;
    }
  }

  setMyVote(section, value);

  const r = refs[section];
  if (fromButton && r && document.activeElement !== r.input) {
    r.errEl.textContent = '';
    r.input.value = '';
  }

  persist();
  renderSections();
  renderPanel();
  sendState();
}

function withdrawVote(section) {
  if (!state.round || state.round.status !== 'open') return;

  setMyVote(section, null);

  const r = refs[section];
  if (r) {
    r.errEl.textContent = '';
    if (document.activeElement !== r.input) r.input.value = '';
  }

  persist();
  renderSections();
  renderPanel();
  sendState();
}

function armReset() {
  resetArmed = true;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
  renderPanel();
}

function disarmReset() {
  resetArmed = false;
  clearTimeout(resetTimer);
  resetTimer = null;
  renderPanel();
}

/* ------------------------------------------------------------------ */
/*  Zdarzenia                                                          */
/* ------------------------------------------------------------------ */

linkInput.addEventListener('change', () => {
  const typed = linkInput.value.trim();
  const stored = (state.round && state.round.jiraUrl) || '';

  if (typed !== stored) saveLink(typed);
});

goBtn.addEventListener('click', () => {
  const stored = (state.round && state.round.jiraUrl) || '';
  const raw = linkInput.value.trim() || stored;
  const url = safeUrl(raw);

  if (!url) {
    toast('Brak poprawnego linku do otwarcia.');
    return;
  }

  if (raw !== stored) saveLink(raw);
  window.open(url, '_blank', 'noopener');
});

revealBtn.addEventListener('click', () => {
  revealVoting();
});

resetBtn.addEventListener('click', () => {
  const revealed = Boolean(state.round) && state.round.status === 'revealed';

  // Potwierdzenie ma sens tylko przed odkryciem - wtedy reset kasuje glosy bez
  // sladu. Po odkryciu wartosci sa juz widoczne dla wszystkich, wiec nic nie przepada
  // i reset jest natychmiastowy.
  if (revealed) {
    if (resetArmed) disarmReset();
  } else if (!resetArmed) {
    armReset();
    return;
  } else {
    disarmReset();
  }

  resetVoting();
});

// Klikniecie poza przyciskiem rozbraja potwierdzenie resetu.
document.addEventListener('click', (e) => {
  if (resetArmed && e.target !== resetBtn) disarmReset();
});

/* ------------------------------------------------------------------ */
/*  Toast                                                              */
/* ------------------------------------------------------------------ */

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 5000);
}

/* ------------------------------------------------------------------ */
/*  Blad krytyczny                                                     */
/* ------------------------------------------------------------------ */

function showFatal(e) {
  fatalEl.hidden = false;
  fatalEl.textContent = `Brak połączenia na żywo: ${msg(e)} — ponawiam próbę w tle.`;
}

/* ------------------------------------------------------------------ */
/*  Realtime + Presence (bez tabel)                                    */
/* ------------------------------------------------------------------ */

// Bez bazy nie ma skad wziac stanu: kazda karta oglasza to, co wie, a pozostale
// to scala. Rozstrzygaja dwa niezmienniki:
//   1. numer glosowania (wiekszy wygrywa) - decyduje, ktore glosowanie trwa,
//   2. "rev" wpisu glosu (wiekszy wygrywa) - decyduje, czyj glos jest nowszy.
// Dzieki nim kolejność wiadomosci nie ma znaczenia, wiec nie ma czego zsynchronizowac.
function sendState() {
  if (!channel || !state.round) return;

  const votes = {};
  for (const [id, entry] of state.votes) votes[id] = entry;

  Promise.resolve(
    channel.send({
      type: 'broadcast',
      event: 'state',
      payload: { voterId, round: state.round, votes },
    })
  ).catch(() => {});
}

function subscribe() {
  channel = supabase
    .channel(CHANNEL_NAME, { config: { presence: { key: voterId } } })
    .on('broadcast', { event: 'state' }, ({ payload }) => applyRemote(payload))
    .on('broadcast', { event: 'sync-request' }, ({ payload }) => {
      if (payload && payload.voterId && payload.voterId !== voterId) sendState();
    })
    .on('presence', { event: 'sync' }, () => {
      state.online = Object.keys(channel.presenceState()).length;
      renderOnline();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        fatalEl.hidden = true;
        channel.track({ at: new Date().toISOString() }).catch(() => {});
        Promise.resolve(
          channel.send({ type: 'broadcast', event: 'sync-request', payload: { voterId } })
        ).catch(() => {});
        sendState();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        showFatal('brak łączności z kanałem');
      }
    });
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

function init() {
  buildUI();

  applyStored();
  renderAll();

  subscribe();

  // Gdy nikt nie odpowiedzial, jestesmy pierwsi - zakladamy glosowanie na dzis.
  setTimeout(() => {
    if (!state.round) startRound(1);
  }, PEER_GRACE_MS);

  // Dosylka: broadcast nie gwarantuje dostarczenia, wiec co jakis czas przypominamy
  // swój stan. W krotkiej sesji to kilka kilobajtow.
  setInterval(() => {
    if (document.visibilityState === 'visible') sendState();
  }, HEARTBEAT_MS);

  // Twarda polnoc: glosowanie obowiazuje w ramach jednego dnia. Gdy karta przesiedzi
  // pólnoc, wracamy do stanu wyjsciowego zamiast ciagnac glosy z poprzedniej doby.
  setInterval(() => {
    if (state.round && roundDay(state.round.id) !== todayKey()) {
      linkInput.value = '';
      startRound(1);
    }
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    sendState();

    // Powrot do karty po dluzszej przerwie to typowy moment, w ktorym warto
    // dociagnac to, co przegapilismy.
    Promise.resolve(
      channel?.send({ type: 'broadcast', event: 'sync-request', payload: { voterId } })
    ).catch(() => {});
  });
}

init();
