# AGENTS.md — dokumentacja techniczna

Ten plik jest dla **każdego, kto pracuje nad kodem** — człowieka albo agenta.
Opisuje architekturę, reguły biznesowe, pułapki i konwencje.

Dla instrukcji wdrożenia i użytkowania zobacz [`README.md`](README.md).

---

## 1. Co to jest

Aplikacja webowa do zespołowego wyceniania ticketów Jiry w **MD (osobodniach)**.
Trzy niezależne sekcje — Backend, Frontend, Testy. Głosowanie w czasie rzeczywistym,
bez logowania i bez imion. Zastępuje plugin do Jiry.

**Hosting:** GitHub Pages (`https://dasiuss.github.io/Wyceniacz/`)
**Backend:** Supabase — Postgres + Realtime + Presence, schemat `wyceniacz`

---

## 2. Twarde ograniczenia

Te założenia są celowe. Nie łam ich bez uzgodnienia.

| Ograniczenie | Dlaczego |
| --- | --- |
| **Bez build stepu** — żadnego npm, bundlera, TypeScriptu | Cała apka to pliki statyczne prosto z repo. `git push` = deploy |
| **Jedyna zależność:** `@supabase/supabase-js` v2 z CDN (jsDelivr) | Brak `node_modules`, brak `package.json` |
| **Vanilla JS**, moduły ES | Rozmiar apki nie uzasadnia frameworka |
| **Bez logowania i bez imion** | Wymóg produktowy. Tożsamość = losowy UUID w `localStorage` |
| **Bez frameworka CSS** | Zwykły CSS ze zmiennymi |

---

## 3. Mapa plików

```
index.html                      szkielet: topbar, kontener sekcji, panel, historia, toast
styles.css                      cały wygląd; motyw i kolory sekcji w :root i [data-section]
config.js                       SUPABASE_URL, SUPABASE_KEY, DB_SCHEMA
app.js                          cała logika klienta (620 linii)
sql/setup.sql                   konfiguracja bazy; idempotentny, do wklejenia w SQL Editor
.github/workflows/deploy.yml    automatyczny deploy na GitHub Pages
README.md                       instrukcja dla użytkownika / wdrożeniowa
AGENTS.md                       ten plik
```

`app.js` nie ma importów poza `config.js` i CDN-em. Nie ma podziału na moduły —
świadomie, przy tej skali jeden plik z sekcjami oddzielonymi komentarzami jest czytelniejszy.

---

## 4. Przepływ danych

```
       przeglądarka A                                  przeglądarka B
            │                                                │
            │ 1. RPC (submit_vote)                           │
            ▼                                                │
   ┌──────────────────┐                                      │
   │    Supabase      │                                      │
   │  Postgres        │                                      │
   │  schemat         │  3. websocket (postgres_changes)     │
   │  wyceniacz       │ ─────────────────────────────────────┼──►
   │                  │                                      │
   │  votings         │  4. scheduleCurrent() → get_state()  │
   │  votes           │ ◄────────────────────────────────────┘
   └──────────────────┘
             │
             │ 2. trigger prune_history przy odkryciu
             ▼
```

**Kluczowa zasada:** klient nigdy nie zapisuje stanu lokalnie. Baza jest jedynym
źródłem prawdy. Po każdym zdarzeniu klient **pobiera stan od nowa** zamiast
próbować go zrekonstruować z payloadu websocketa. To celowe uproszczenie:
kosztuje jedno małe zapytanie, a eliminuje całą klasę błędów synchronizacji.

---

## 5. Model danych

### `wyceniacz.votings` — pojedyncze głosowanie

| Kolumna | Typ | Uwagi |
| --- | --- | --- |
| `id` | uuid | PK, `gen_random_uuid()` |
| `jira_url` | text | max 500 znaków, przycinane w RPC |
| `status` | text | `'open'` albo `'revealed'` |
| `created_at` | timestamptz | |
| `revealed_at` | timestamptz | NULL dopóki otwarte |

**Niezmiennik:** w danym momencie istnieje **co najwyżej jedno** głosowanie ze
statusem `open`. Wymuszone partycyjnym indeksem unikalnym:

```sql
create unique index votings_single_open
  on wyceniacz.votings (status) where status = 'open';
```

To nie jest kosmetyk — bez tego dwóch klientów otwierających apkę równocześnie
utworzyłoby dwa równoległe głosowania.

### `wyceniacz.votes` — pojedynczy głos

| Kolumna | Typ | Uwagi |
| --- | --- | --- |
| `id` | uuid | PK |
| `voting_id` | uuid | FK → `votings(id)` **ON DELETE CASCADE** |
| `voter_id` | uuid | tożsamość przeglądarki, generowana po stronie klienta |
| `section` | text | `be` / `fe` / `qa` |
| `value` | numeric(5,2) | zakres 1–15 |
| `created_at`, `updated_at` | timestamptz | |

**Niezmiennik:** jeden głos na sekcję na głosującego w danym głosowaniu:

```sql
unique (voting_id, voter_id, section)
```

To pozwala robić zapis przez `ON CONFLICT DO UPDATE` — zmiana głosu to update,
nie nowy wiersz.

### Cykl życia głosowania

```
        reset_voting()                    reveal_voting()
   ┌─────────────────────┐          ┌──────────────────────────┐
   │                     ▼          │                          ▼
 [open] ──────────────► [open]   [open] ──────────────────► [revealed]
   │                     nowe        │                          │
   │                                 │                          │ trafia do historii
   │ reset_voting()                  │                          │ (jeśli ma ≥1 głos)
   ▼                                 ▼                          ▼
 usunięte bez śladu            usunięte bez śladu         zostaje na stałe
 (brak wpisu w historii)                                  (do limitu 100)
```

- **`open` → reset** = wiersz usunięty, głosy kaskadowo, **żadnego wpisu w historii**.
- **`open` → reveal** = status zmieniony, wiersz **staje się** wpisem w historii.
  Nie ma osobnej tabeli historii ani kopiowania danych.
- **Historia** = wszystkie wiersze ze statusem `revealed`, **które mają co najmniej
  jeden głos**. Głosowanie odkryte z zerem głosów jest niewidoczne w historii.

---

## 6. API — funkcje RPC

`anon` **nie ma prawa zapisu** do żadnej tabeli. Cała komunikacja zapisująca
przechodzi przez funkcje `SECURITY DEFINER`, które walidują dane wejściowe.
Każda ma `set search_path = wyceniacz, pg_temp` (ochrona przed podstawieniem schematu)
oraz `EXECUTE` odebrany z `public` i nadany jawnie.

| Funkcja | Zwraca | Co robi / czego pilnuje |
| --- | --- | --- |
| `get_state()` | jsonb | Bieżące głosowanie + jego głosy. **Bez historii** — wołane przy każdym evencie |
| `get_history()` | jsonb | Do 100 ostatnich ujawnionych głosowań z ≥1 głosem |
| `submit_vote(p_voter_id uuid, p_section text, p_value numeric)` | void | Waliduje zakres 1–15, sekcję, blokadę po odkryciu, **limit 10 głosów na sekcję**. Upsert |
| `withdraw_vote(p_voter_id uuid, p_section text)` | void | Usuwa własny głos. Konieczne, bo `anon` nie ma `DELETE` |
| `set_jira_url(p_url text)` | void | Przycina do 500 znaków, puste → NULL. Działa także po odkryciu |
| `reveal_voting()` | void | Ustawia `revealed` + `revealed_at`. Uruchamia trigger przycinający historię |
| `reset_voting()` | `votings` | Usuwa otwarte głosowanie z głosami, tworzy nowe, puste |
| `ensure_voting()` | `votings` | Wewnętrzna. Otwarte → ostatnie → utwórz nowe. Obsługuje wyścig `unique_violation` |

**Uwaga o wywołaniach:** PostgREST wymaga **wszystkich** parametrów. Pominięcie
któregokolwiek kończy się `PGRST202`, a nie czytelnym błędem walidacji.

### Zachowanie limitu 10 głosów

```sql
if not v_existing then
  select count(*) into v_count
    from wyceniacz.votes
   where voting_id = r.id and section = p_section;

  if v_count >= c_max_per_section then
    raise exception 'Limit % glosow w tej sekcji zostal osiagniety', c_max_per_section;
  end if;
end if;
```

Limit sprawdzany **tylko dla nowego wiersza**. Osoba, która już zagłosowała
w tej sekcji, może swój głos zmieniać bez ograniczeń, nawet przy pełnym limicie.
Bez tego warunku `v_existing` nie dałoby się poprawić głosu w zatłoczonej sekcji.

---

## 7. Trigger przycinający historię

```sql
after update on wyceniacz.votings
for each row
when (new.status = 'revealed' and old.status is distinct from 'revealed')
execute function wyceniacz.prune_history();
```

Funkcja robi dwie rzeczy:

1. **Kasuje porzucone** — ujawnione głosowania bez głosów (poza właśnie ujawnionym).
   Takie wiersze powstają, gdy ktoś kliknie „Odkryj" przy zerze głosów.
2. **Przycina do 100** — usuwa wszystko powyżej 100 najnowszych ujawnionych
   głosowań, które mają głosy (`order by revealed_at desc offset 100`).

**Dlaczego to jest w bazie, a nie w kliencie:** limit jest gwarantowany niezależnie
od tego, kto i jakim klientem kliknie „Odkryj". Klient nie może go pominąć ani
„zapomnieć" posprzątać. To zabezpieczenie przed nabiciem danych przez skrypt
z publicznym kluczem.

**Skutek uboczny projektu:** trigger odpala się tylko przy `reveal`. Wiersz
`revealed` z zerem głosów może więc trochę poleżeć — jest niewidoczny w interfejsie
i zostanie usunięty przy następnym odkryciu. To akceptowalne.

---

## 8. Model bezpieczeństwa

Publishable key jest **publiczny z założenia** — leży w `config.js` w publicznym repo.
Nie da się tego ukryć i nie trzeba.

| Warstwa | Ustawienie |
| --- | --- |
| Granty na tabele | `anon` ma **wyłącznie `SELECT`** (potrzebny Realtime'owi). Zero `INSERT`/`UPDATE`/`DELETE` |
| RLS | Włączone na obu tabelach, polityki `SELECT` z `using (true)` |
| Zapis | Wyłącznie przez RPC `SECURITY DEFINER` z walidacją |
| Realtime | Wymaga grantu `SELECT` — dlatego nie da się go odebrać |

**Czego to broni:**

- Bezpośredni `POST` do `/rest/v1/votes` → `401`. Nie da się ominąć walidacji RPC.
- Skrypt z kluczem może wpisać najwyżej **10 głosów na sekcję** (30 wierszy na
  głosowanie), a historia jest przycięta do 100 głosowań → cała baza nie przekroczy
  ~3000 wierszy, czyli kilku MB.
- Odczyt jest otwarty, ale dane są beznazwowe i bezużyteczne — same liczby.

**Czego to NIE broni:** każdy z adresem apki może głosować, odkrywać i resetować.
To świadoma decyzja produktowa („każdy może kliknąć"), nie przeoczenie.
Nie dodawaj PIN-u bez uzgodnienia — był rozważany i odrzucony.

Plan darmowy Supabase nie ma podpiętej płatności, więc przekroczenie limitów
skutkuje ograniczeniem projektu, a nie fakturą.

---

## 9. Architektura klienta

### Tożsamość

Jeden UUID na przeglądarkę, generowany raz i trzymany w `localStorage`
(`wyceniacz.voterId`). Celowo **nie** per karta — jedna osoba = jeden głos.

### Stan

```js
state = {
  voting: {},    // bieżące głosowanie (może być revealed)
  votes: [],     // głosy bieżącego głosowania
  history: [],   // do 100 wpisów
  online: 0,     // liczba osób na stronie (Presence)
}
```

`refs` trzyma referencje do elementów DOM per sekcja:
`{ buttons, input, errEl, votesOut, avgOut, avgLabel, avgValue }`.

### Interfejs budowany raz, aktualizowany punktowo

`buildUI()` tworzy trzy kolumny **raz, przy starcie**. Renderowanie nie używa
`innerHTML` na kontenerach z polami — aktualizuje konkretne właściwości. Powód:
`renderSections` odpala się przy każdym evencie Realtime, a przerysowanie
`innerHTML` gubiłoby fokus i wpisywaną wartość.

### Rozdzielenie odświeżania

| Funkcja | Kiedy | Dlaczego |
| --- | --- | --- |
| `refreshCurrent()` | każde zdarzenie Realtime (debounce 200 ms) | zwraca ~1 KB |
| `refreshHistory()` | start + zmiany w tabeli `votings` (debounce 400 ms) | zwraca do 100 wpisów |

To **nie jest** mikrooptymalizacja. Wcześniej jedno `get_state` zwracało razem
z historią, więc każdy pojedynczy głos ciągnął u wszystkich całą historię.
Przy 10 osobach i 50 głosach to różnica rzędu dziesiątek MB transferu.

### Kolejność renderowania

```
refreshCurrent() ──► renderSections() ──► renderSelection(key)   [per sekcja]
                                    └──► renderPanel()
refreshHistory() ──► renderHistory()
```

`renderSelection(key)` jest **jedynym** miejscem, które decyduje, co jest zaznaczone.
Nie duplikuj tej logiki — patrz sekcja 11.

### Realtime i Presence

```js
supabase.channel('wyceniacz', { config: { presence: { key: voterId } } })
  .on('postgres_changes', { event: '*', schema: 'wyceniacz', table: 'votings' }, ...)
  .on('postgres_changes', { event: '*', schema: 'wyceniacz', table: 'votes' }, ...)
  .on('presence', { event: 'sync' }, ...)
```

Klucz Presence = `voterId`, więc dwie karty tej samej osoby liczą się jako jedna.
To celowe — licznik ma pokazywać „ile osób", nie „ile kart".

---

## 10. Reguły biznesowe

### Zaokrąglanie — najważniejsza formuła

```js
const ceilHalf = (n) => Math.ceil(n * 2 - 1e-9) / 2;
```

Ceiling do wielokrotności 0.5: `3.1 → 3.5`, `3.0 → 3.0`, `2.75 → 3.0`.

**Epsilon `1e-9` nie jest ozdobnikiem.** Bez niego średnia równa dokładnie
np. `2.5` mogła przez błąd reprezentacji zmiennoprzecinkowej wyskoczyć jako `3.0`.
Jest bezpieczny, bo wartości mają maksymalnie 2 miejsca po przecinku — średnia
różniąca się od wielokrotności 0.5 o mniej niż 1e-9 po prostu nie może istnieć.

### Suma

Suma **trzech zaokrąglonych średnich**, nie surowych. Sekcja bez głosów wchodzi
jako `0`. Czyli pokazywana suma zawsze zgadza się z trzema liczbami nad nią —
to jest ta liczba, którą wkleja się do ticketu.

### Odmiana liczebnika

```js
0 głosów · 1 głos · 2 głosy · 4 głosy · 5 głosów · 12 głosów · 22 głosy
```

Reguła: `n === 1` → „głos"; końcówka 2–4 poza 12–14 → „głosy"; reszta → „głosów".

### Widoczność

| Stan | Co widać w sekcji |
| --- | --- |
| `open` | Tylko liczba oddanych głosów. **Bez** wartości, średniej i sumy |
| `revealed` | Lista głosów rosnąco (z przecinkami), pod nią średnia, w panelu suma |

Ukrywanie wartości przed odkryciem jest sensem całej apki — chodzi o to, żeby
nikt nie sugerował się cudzymi liczbami.

### Blokady

- Po odkryciu przyciski i pole są zablokowane. Zmiana wymaga resetu.
- Pole własnej wartości: zablokowane, ale jego treść pozostaje widoczna.

### Reset — dwa tryby

| Stan | Zachowanie |
| --- | --- |
| `open` | **Dwa kroki.** Pierwszy klik zmienia napis na „Potwierdź reset" (6 s). Głosy przepadają bez śladu, więc pytanie ma sens |
| `revealed` | **Od razu.** Głosowanie jest już w historii, nic nie przepada |

---

## 11. Zaznaczanie wyboru — zasada, której łatwo nie zauważyć

> **Pole z wpisaną treścią ma pierwszeństwo nad przyciskami.**

Scenariusz, który to wymusił: użytka wybiera „3" przyciskiem, potem wpisuje „9"
w polu. Przed poprawką **oba** wskaźniki świeciły naraz — nie było wiadomo,
co się liczy.

Stan aktualny:

| Sytuacja | Zaznaczony przycisk | Pole podświetlone |
| --- | --- | --- |
| Głos „3", pole puste | `3` | nie |
| Głos „3", wpisane „9" (bez opuszczenia) | **brak** | **tak** |
| Pole wyczyszczone | `3` wraca | nie |

Cała logika siedzi w `renderSelection(key)`. Jest wołane z dwóch miejsc:
z `renderSections()` (przy każdym odświeżeniu) i z handlera `input`
(przy każdym wpisanym znaku).

### Powiązane pułapki

**`renderSections` nie może ruszać pola, gdy ma fokus:**

```js
if (document.activeElement !== r.input) {
  r.input.value = mineIsCustom ? fmt(mineValue) : '';
}
```

Bez tego warunku każde odświeżenie z Realtime kasowałoby wpisywaną wartość
w połowie pisania.

**Cofanie głosu patrzy na DOM, nie na bazę:**

```js
if (przycisk && przycisk.classList.contains('active')) { await withdrawVote(...); }
```

Wcześniej patrzyło na `state.votes`, które po wpisaniu innej wartości jest
nieaktualne, i kliknięcie przycisku **cofało** głos zamiast go wybierać.

---

## 12. Kolory — i dlaczego są właśnie takie

Paleta jest ciasna, więc kolory sekcji nie są dowolne:

| Element | Odcień | Kolor |
| --- | --- | --- |
| „Odkryj" (akcent) | 26° | `#b45309` ochra |
| Reset (danger) | ~6° | `#c0392b` |
| Testy | 175° | `#0d9488` morski |
| Backend | 221° | `#2563eb` niebieski |
| Frontend | 336° | `#9d174d` bordo |

Ciepła strona koła (0–40°) jest **zajęta** przez akcent i danger. Dlatego kolory
sekcji muszą być rozłożone poza nią.

**Zmiana koloru sekcji:** jedna linia w `styles.css`:

```css
.col[data-section="fe"] { --sec: #9d174d; --sec-soft: #f9edf2; }
```

Wszystko w kolumnie bierze kolor z `--sec`: pasek u góry, kropka przy nazwie,
hover przycisków, aktywny przycisk, ramka i tekst aktywnego pola oraz średnia.

**Przy zmianie sprawdź trzy rzeczy:**

1. Odległość na kole barw od pozostałych sekcji — **min. ~100°**. Niebieski
   i fiolet (`#7c3aed`, 262°) mają 41° i były nierozróżnialne w praktyce.
2. Odległość od akcentu (26°) i danger (~6°).
3. Kontrast białego tekstu na kolorze (aktywny przycisk) — **min. 4.5:1**.
   Dodatkowo kolor jest używany jako tekst na karcie (`--surface` `#fffdf9`).

Historia decyzji: róż `#db2777` został odrzucony, oliwka `#4d7c0f` rozważana,
ostatecznie bordo `#9d174d` — 115° od Backendu, 161° od Testów, kontrast 7.88.

---

## 13. Pułapki, które już nas kosztowały czas

### CSS transition psuje odczyt stylów

`getComputedStyle` zwraca dla właściwości animowanych **wartość sprzed zmiany**
w zerowej klatce przejścia. `.val-input` ma `transition` na kolorze, tle i ramce,
więc bezpośrednio po dodaniu klasy pomiar pokazuje stare wartości. `font-weight`
nie ma transition, więc zmienia się natychmiast — co daje złudzenie, że
„część stylów działa, a część nie".

**To doprowadziło do dwóch fałszywych alarmów.** Odczytuj style w osobnym
wywołaniu/zrzucie, nie w tym samym ticku, w którym zmieniasz klasę.

### Edytor SQL uruchamia `setup.sql` jako jedną transakcję

Jeśli którykolwiek statement padnie, **wycofuje się cały skrypt**. Objaw był mylący:
błąd dotyczył ograniczenia, a brakowało zupełnie innej funkcji.
Po nieudanym uruchomieniu nie zakładaj, że „część się udała".

### Dodanie `check` wymaga najpierw sprzątnięcia danych

Zmiana zakresu z 0.5–15 na 1–15 wywaliła się na `23514`, bo w bazie zostały
historyczne głosy `0.5`. Stąd w `setup.sql` jawny `delete` **przed** `alter table`.
Ogólna zasada: nowe ograniczenie zawsze waliduje istniejące wiersze.

### `if not exists` nie zmieni istniejącej definicji

`create table if not exists` **pominie** tabelę, która już istnieje — razem ze
starymi ograniczeniami. Zmiana ograniczenia wymaga jawnego `drop constraint`
i `add constraint`. Dlatego `setup.sql` ma oba.

### Własny schemat wymaga trzech rzeczy naraz

Żeby `supabase-js` i Realtime widziały `wyceniacz`:

1. `grant usage` + `grant select` dla `anon` (w `setup.sql`),
2. tabele w publikacji `supabase_realtime` (w `setup.sql`),
3. `wyceniacz` w **Project Settings → API → Exposed schemas** — **ręcznie,
   w dashboardzie**, jedyny krok poza repo.

Bez punktu 3 każdy request kończy się `PGRST106`.

### Pomiar i testowanie

- **Serwer HTTP jest obowiązkowy** — moduły ES nie działają z `file://`.
- Pomiar pojedynczej właściwości DOM bywa mylący (patrz transition powyżej).
  Warto mierzyć `getBoundingClientRect()`, gdy pytanie dotyczy wyrównania —
  to dało twardy dowód, że panel ma wszystkie elementy w jednej linii.
- Testuj na **dwóch niezależnych kartach**, żeby sprawdzić Realtime. Karta,
  która nigdy się nie przeładowała, a pokazuje zmiany z drugiej — to jedyny
  wiarygodny dowód, że websockety działają.
- Windows wypisuje ostrzeżenia `LF will be replaced by CRLF`. Są nieszkodliwe,
  nie „naprawiaj" ich zmieniając konfigurację gita.

---

## 14. Konwencje kodu

- **Teksty interfejsu:** polski, pełne znaki diakrytyczne („Wyczyść pole").
- **Komentarze:** polski, opisują *dlaczego*, nie *co*. Wartościowe komentarze
  wyjaśniają decyzje („bez tego warunku przerysowanie gubi wpisywaną wartość").
- **Nazwy w kodzie:** angielskie (`renderSelection`, `castVote`).
- **Bezpieczeństwo DOM:** dane pochodzące od użytkownika (link do Jiry!) nigdy
  przez `innerHTML`. Buduj przez `createElement` + `textContent`, a adresy
  przepuszczaj przez `safeUrl()` (przepuszcza tylko `http:`/`https:`).
- **Sekcje kodu** w `app.js` oddzielone komentarzami-blokami:
  konfiguracja → narzędzia → stan → elementy → budowa UI → renderowanie →
  pobieranie danych → akcje → zdarzenia → toast → Realtime → start.
- **Dodając element interfejsu:** nigdy nie używaj `innerHTML` na kontenerze,
  w którym są pola formularza.

---

## 15. Częste zadania

| Zadanie | Co zmienić |
| --- | --- |
| **Zmiana skali przycisków** | `PRESET_VALUES` w `app.js` **oraz** zakres w `submit_vote` i ograniczenie `votes_value_check` w `setup.sql` — i przeklejić SQL |
| **Zmiana limitu głosów na sekcję** | `c_max_per_section` w `submit_vote` (`setup.sql`) |
| **Zmiana limitu historii** | `offset 100` w `prune_history` **oraz** `limit 100` w `get_history` |
| **Kolor sekcji** | jedna linia `[data-section="..."]` w `styles.css` (sprawdź odległości odcieni) |
| **Dodanie czwartej sekcji** | `SECTIONS` w `app.js` + `check (section in ...)` na `votes` + whitelisty w `submit_vote`/`withdraw_vote` + reguła `[data-section]` w CSS + `grid-template-columns` jeśli ma być obok |
| **Zmiana kolejności sekcji** | kolejność w `SECTIONS` w `app.js`; kolory są przypisane po `data-section`, więc idą za nazwą |
| **Diagnostyka bazy z zewnątrz** | REST z nagłówkami `Accept-Profile: wyceniacz` i `Content-Profile: wyceniacz` |

---

## 16. Jak sprawdzić, że działa

### Test przez REST (bez przeglądarki)

```js
const H = {
  apikey: KEY, Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": "wyceniacz", "Content-Profile": "wyceniacz",
};
await fetch(`${URL}/rest/v1/rpc/get_state`, { method: "POST", headers: H, body: "{}" });
```

Warto sprawdzić: limit głosów, walidację zakresu, blokadę po odkryciu,
**czy zapis bezpośredni do tabeli zwraca `401`** (to test modelu bezpieczeństwa),
oraz to, czy reset nie tworzy wpisu w historii.

### Test Realtime

Otwórz apkę w dwóch kartach, w jednej zagłosuj, w drugiej **nie przeładowuj**
i sprawdź, czy licznik głosów się zaktualizował. Potem odkryj w jednej karcie
i sprawdź, czy druga pokazała pełny stan. To jedyny sposób, żeby zweryfikować
websockety — API ich nie sprawdzi.

### Test wyliczeń

Ustaw: Backend `3` i `3.2`, Frontend `2` i `3`, Testy bez głosów.

| Sekcja | Średnia | Po ceiling | Sprawdza |
| --- | --- | --- | --- |
| Backend | `3.1` | **`3.5`** | że ceiling faktycznie podnosi |
| Frontend | `2.5` | **`2.5`** | że wartość dokładnie na granicy nie ucieka w górę |
| Testy | brak | **`–`** | pusta sekcja wchodzi do sumy jako `0` |

Suma: `3.5 + 2.5 + 0` = **`6 MD`**.

Drugi przypadek na brzeg: Frontend `1` i `1.5` → średnia `1.25` → **`1.5`**
(a nie `1.0`). To odróżnia ceiling od zwykłego `Math.round`.

---

## 17. Czego świadomie nie ma

Nie dodawaj tego bez uzgodnienia — każda z tych rzeczy była rozważana i odrzucona:

| Rzecz | Powód odrzucenia |
| --- | --- |
| PIN / hasło | Rozważane. Odrzucone — twarde limity w bazie wystarczają, a PIN to tarcie przy każdym wejściu |
| Wiele pokoi / równoległych wyceny | Jedno globalne głosowanie wystarcza zespołowi |
| Logowanie, imiona, awatary | Wymóg wprost: bez logowania i bez imion |
| Story points | Jednostką są osobodni (MD) |
| Edycja/usuwanie pojedynczych głosów cudzych | Nie ma do tego żadnej funkcji — celowo |
| Build step, framework, TypeScript | Apka jest zbyt mała, a prostota wdrożenia jest wartością |
| Testy automatyczne | Nie ma logiki po stronie serwera poza SQL-em; weryfikacja jest ręczna (sekcja 16) |
