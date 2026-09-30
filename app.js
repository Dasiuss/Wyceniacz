import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, DB_SCHEMA } from './config.js';

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
const CHANNEL_NAME = 'wyceniacz';
const RESET_LABEL = 'Resetuj';
const RESET_CONFIRM_LABEL = 'Potwierdź reset';
const RESET_CONFIRM_MS = 6000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: DB_SCHEMA },
});

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

function sectionStats(votes, section) {
  const values = votes
    .filter((v) => v.section === section)
    .map((v) => Number(v.value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (values.length === 0) return { count: 0, values, avg: null };

  const avg = ceilHalf(values.reduce((a, b) => a + b, 0) / values.length);
  return { count: values.length, values, avg };
}

// Suma = suma trzech zaokraglonych (ceiling do 0.5) srednich sekcji.
// Sekcja bez glosow liczy sie jako 0.
function totalSum(votes) {
  return SECTIONS.reduce((acc, s) => acc + (sectionStats(votes, s.key).avg ?? 0), 0);
}

function myVote(section) {
  return state.votes.find((v) => v.section === section && v.voter_id === voterId) || null;
}

function ticketLabel(raw) {
  try {
    const u = new URL(raw);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return String(raw).slice(0, 60);
  }
}

/* ------------------------------------------------------------------ */
/*  Stan                                                               */
/* ------------------------------------------------------------------ */

const voterId = getVoterId();

const state = {
  voting: null,
  votes: [],
  history: [],
  online: 0,
};

const refs = Object.create(null);

let resetArmed = false;
let resetTimer = null;
let currentTimer = null;
let historyTimer = null;
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
const historyEl = document.getElementById('history');

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
        if (mine && !isPreset(Number(mine.value))) withdrawVote(s.key);
        return;
      }

      const value = Number(raw.replace(',', '.'));
      if (!Number.isFinite(value) || value < MIN_VALUE || value > MAX_VALUE) {
        errEl.textContent = `Zakres: ${fmt(MIN_VALUE)}–${fmt(MAX_VALUE)} MD`;
        return;
      }

      errEl.textContent = '';
      castVote(s.key, round2(value), false);
    };

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

function renderSections() {
  const status = state.voting ? state.voting.status : null;
  const canVote = status === 'open';
  const revealed = status === 'revealed';

  for (const s of SECTIONS) {
    const r = refs[s.key];
    const stats = sectionStats(state.votes, s.key);

    const mine = myVote(s.key);
    const mineValue = mine ? Number(mine.value) : null;
    const mineIsPreset = mineValue !== null && isPreset(mineValue);

    for (const b of r.buttons) {
      const v = Number(b.dataset.value);
      const isMine = mineValue !== null && Math.abs(v - mineValue) < 1e-9;
      b.classList.toggle('active', isMine);
      b.disabled = !canVote;
      b.title = isMine ? 'Kliknij ponownie, aby cofnąć głos' : '';
    }

    r.input.disabled = !canVote;
    if (document.activeElement !== r.input) {
      r.input.value = mineValue !== null && !mineIsPreset ? fmt(mineValue) : '';
    }

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
  const v = state.voting;
  const revealed = Boolean(v) && v.status === 'revealed';

  if (document.activeElement !== linkInput) {
    linkInput.value = v && v.jira_url ? v.jira_url : '';
  }

  const typed = linkInput.value.trim();
  goBtn.disabled = !safeUrl(typed || (v && v.jira_url));

  revealBtn.disabled = revealed;

  resetBtn.textContent = resetArmed ? RESET_CONFIRM_LABEL : RESET_LABEL;
  resetBtn.classList.toggle('armed', resetArmed);
  resetBtn.title = revealed
    ? 'Rozpocznij nowe głosowanie — to jest już zapisane w historii'
    : 'Wyczyść głosy i zacznij od nowa (wymaga potwierdzenia)';

  sumEl.textContent = revealed ? `${fmt(totalSum(state.votes))} MD` : '–';

  if (!v) {
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

function renderHistory() {
  historyEl.textContent = '';

  if (state.history.length === 0) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Brak zakończonych głosowań.';
    historyEl.appendChild(p);
    return;
  }

  for (const h of state.history) {
    const item = document.createElement('details');
    item.className = 'hist';

    const summary = document.createElement('summary');

    const date = document.createElement('span');
    date.className = 'hist-date';
    date.textContent = h.revealed_at
      ? new Date(h.revealed_at).toLocaleString('pl-PL', {
          dateStyle: 'short',
          timeStyle: 'short',
        })
      : '—';
    summary.appendChild(date);

    const linkWrap = document.createElement('span');
    linkWrap.className = 'hist-link';

    if (h.jira_url) {
      const url = safeUrl(h.jira_url);
      const a = document.createElement('a');
      a.textContent = ticketLabel(h.jira_url);

      if (url) {
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.className = 'plain';
      }

      linkWrap.appendChild(a);
    } else {
      linkWrap.textContent = 'bez linku';
      linkWrap.classList.add('muted');
    }
    summary.appendChild(linkWrap);

    const sum = document.createElement('span');
    sum.className = 'hist-sum';
    sum.textContent = `${fmt(totalSum(h.votes))} MD`;
    summary.appendChild(sum);

    item.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'hist-body';

    for (const s of SECTIONS) {
      const st = sectionStats(h.votes, s.key);

      const row = document.createElement('div');
      row.className = 'hist-row';

      const label = document.createElement('span');
      label.className = 'hist-label';
      label.textContent = s.label;

      const vals = document.createElement('span');
      vals.className = 'hist-vals';
      vals.textContent = st.count ? st.values.map(fmt).join(', ') : '–';

      const avg = document.createElement('span');
      avg.className = 'hist-avg';
      avg.textContent = st.avg === null ? '–' : `${fmt(st.avg)} MD`;

      row.append(label, vals, avg);
      body.appendChild(row);
    }

    item.appendChild(body);
    historyEl.appendChild(item);
  }
}

function renderAll() {
  renderSections();
  renderPanel();
  renderOnline();
}

/* ------------------------------------------------------------------ */
/*  Pobieranie danych                                                  */
/* ------------------------------------------------------------------ */

async function refreshCurrent() {
  const { data, error } = await supabase.rpc('get_state');
  if (error) throw error;

  state.voting = data ? data.voting : null;
  state.votes = data && Array.isArray(data.votes) ? data.votes : [];

  fatalEl.hidden = true;
  renderSections();
  renderPanel();
}

async function refreshHistory() {
  const { data, error } = await supabase.rpc('get_history');
  if (error) throw error;

  state.history = Array.isArray(data) ? data : [];
  renderHistory();
}

function scheduleCurrent() {
  clearTimeout(currentTimer);
  currentTimer = setTimeout(() => {
    refreshCurrent().catch(showFatal);
  }, 200);
}

function scheduleHistory() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    refreshHistory().catch(() => {});
  }, 400);
}

/* ------------------------------------------------------------------ */
/*  Akcje                                                              */
/* ------------------------------------------------------------------ */

async function castVote(section, value, fromButton) {
  if (!state.voting || state.voting.status !== 'open') {
    toast('Głosowanie jest już odkryte — kliknij Resetuj, aby zacząć nowe.');
    return;
  }

  // Klikniecie w swoj wlasny, aktywny przycisk cofa glos.
  const mine = myVote(section);
  if (mine && Math.abs(Number(mine.value) - value) < 1e-9) {
    await withdrawVote(section);
    return;
  }

  try {
    const { error } = await supabase.rpc('submit_vote', {
      p_voter_id: voterId,
      p_section: section,
      p_value: value,
    });
    if (error) throw error;

    if (fromButton) {
      const r = refs[section];
      if (r) {
        r.errEl.textContent = '';
        if (document.activeElement !== r.input) r.input.value = '';
      }
    }

    await refreshCurrent();
  } catch (e) {
    toast(`Nie udało się zapisać głosu: ${msg(e)}`);
    await refreshCurrent().catch(() => {});
  }
}

async function withdrawVote(section) {
  if (!state.voting || state.voting.status !== 'open') return;

  try {
    const { error } = await supabase.rpc('withdraw_vote', {
      p_voter_id: voterId,
      p_section: section,
    });
    if (error) throw error;

    const r = refs[section];
    if (r) {
      r.errEl.textContent = '';
      if (document.activeElement !== r.input) r.input.value = '';
    }

    await refreshCurrent();
  } catch (e) {
    toast(`Nie udało się cofnąć głosu: ${msg(e)}`);
    await refreshCurrent().catch(() => {});
  }
}

async function saveLink(raw) {
  try {
    const { error } = await supabase.rpc('set_jira_url', { p_url: raw || '' });
    if (error) throw error;

    if (state.voting) state.voting.jira_url = raw || null;
    renderPanel();
  } catch (e) {
    toast(`Nie udało się zapisać linku: ${msg(e)}`);
  }
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
  const stored = (state.voting && state.voting.jira_url) || '';

  if (typed !== stored) saveLink(typed);
});

goBtn.addEventListener('click', () => {
  const stored = (state.voting && state.voting.jira_url) || '';
  const raw = linkInput.value.trim() || stored;
  const url = safeUrl(raw);

  if (!url) {
    toast('Brak poprawnego linku do otwarcia.');
    return;
  }

  if (raw !== stored) saveLink(raw);
  window.open(url, '_blank', 'noopener');
});

revealBtn.addEventListener('click', async () => {
  revealBtn.disabled = true;

  try {
    const { error } = await supabase.rpc('reveal_voting');
    if (error) throw error;

    await Promise.all([refreshCurrent(), refreshHistory()]);
  } catch (e) {
    toast(`Nie udało się odkryć: ${msg(e)}`);
  } finally {
    renderPanel();
  }
});

resetBtn.addEventListener('click', async () => {
  const revealed = Boolean(state.voting) && state.voting.status === 'revealed';

  // Potwierdzenie ma sens tylko przed odkryciem - wtedy reset kasuje glosy bez
  // sladu. Po odkryciu glosowanie jest juz w historii, wiec reset jest natychmiastowy.
  if (revealed) {
    if (resetArmed) disarmReset();
  } else if (!resetArmed) {
    armReset();
    return;
  } else {
    disarmReset();
  }

  resetBtn.disabled = true;

  try {
    const { error } = await supabase.rpc('reset_voting');
    if (error) throw error;

    linkInput.value = '';
    await Promise.all([refreshCurrent(), refreshHistory()]);
  } catch (e) {
    toast(`Nie udało się zresetować: ${msg(e)}`);
  } finally {
    resetBtn.disabled = false;
    renderPanel();
  }
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
  fatalEl.textContent =
    `Nie udało się połączyć z bazą: ${msg(e)} — ` +
    `jeśli to błąd 404 / PGRST106, dodaj schemat „${DB_SCHEMA}” w Supabase → ` +
    'Project Settings → API → Exposed schemas i uruchom sql/setup.sql.';
}

/* ------------------------------------------------------------------ */
/*  Realtime + Presence                                                */
/* ------------------------------------------------------------------ */

function subscribe() {
  const channel = supabase
    .channel(CHANNEL_NAME, { config: { presence: { key: voterId } } })
    .on(
      'postgres_changes',
      { event: '*', schema: DB_SCHEMA, table: 'votings' },
      () => {
        scheduleCurrent();
        scheduleHistory();
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: DB_SCHEMA, table: 'votes' },
      () => scheduleCurrent()
    )
    .on('presence', { event: 'sync' }, () => {
      state.online = Object.keys(channel.presenceState()).length;
      renderOnline();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        channel.track({ at: new Date().toISOString() }).catch(() => {});
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        toast('Utracono połączenie na żywo — odśwież stronę.');
      }
    });
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

async function init() {
  buildUI();
  renderAll();

  try {
    await Promise.all([refreshCurrent(), refreshHistory()]);
  } catch (e) {
    showFatal(e);
  }

  subscribe();
}

init();
