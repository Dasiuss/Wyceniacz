# AGENTS.md — dokumentacja techniczna

Ten plik jest dla **każdego, kto pracuje nad kodem** — człowieka albo agenta.
Opisuje architekturę, protokół wymiany głosów, reguły biznesowe, pułapki i konwencje.

Dla instrukcji wdrożenia i użytkowania zobacz [`README.md`](README.md).

---

## 1. Co to jest

Aplikacja webowa do zespołowego wyceniania ticketów Jiry w **MD (osobodniach)**.
Trzy niezależne sekcje — Backend, Frontend, Testy. Głosowanie w czasie rzeczywistym,
bez logowania i bez imion. Zastępuje plugin do Jiry.

**Hosting:** GitHub Pages (`https://dasiuss.github.io/Wyceniacz/`)
**Komunikacja:** Supabase Realtime — kanał `broadcast` + `presence`. **Bez tabel, bez SQL-a.**
**Trwałość:** brak. Głosy żyją tylko w otwartych przeglądarkach.

---

## 2. Twarde ograniczenia

Te założenia są celowe. Nie łam ich bez uzgodnienia.

| Ograniczenie | Dlaczego |
| --- | --- |
| **Zero zapisu danych** — żadnej bazy, żadnej historii | Wymóg organizacyjny: brak pozwolenia na przechowywanie tych danych |
| **Bez build stepu** — żadnego npm, bundlera, TypeScriptu | Cała apka to pliki statyczne prosto z repo. `git push` = deploy |
| **Jedyna zależność:** `@supabase/supabase-js` v2 z CDN (jsDelivr) | Brak `node_modules`, brak `package.json` |
| **Vanilla JS**, moduły ES | Rozmiar apki nie uzasadnia frameworka |
| **Bez logowania i bez imion** | Wymóg produktowy. Tożsamość = losowy UUID w `localStorage` |
| **Bez frameworka CSS** | Zwykły CSS ze zmiennymi |

---

## 3. Mapa plików

```
index.html                      szkielet: topbar, kontener sekcji, panel, toast
styles.css                      cały wygląd; motyw i kolory sekcji w :root i [data-section]
config.js                       SUPABASE_URL, SUPABASE_KEY
app.js                          cała logika klienta (kanał, render, akcje, pamięć)
.github/workflows/deploy.yml    automatyczny deploy na GitHub Pages
README.md                       instrukcja dla użytkownika
AGENTS.md                       ten plik
```

`app.js` nie ma importów poza `config.js` i CDN-em. Nie ma podziału na moduły —
świadomie, przy tej skali jeden plik z sekcjami oddzielonymi komentarzami jest czytelniejszy.

**Nie ma `sql/`.** Jedyne uruchamiane ręcznie SQL to `drop schema wyceniacz cascade`
(instrukcja w README) — nie jest potrzebne do działania apki.

---

## 4. Przepływ danych

```
     przeglądarka A                                   przeglądarka B
          │                                                 │
          │ 1. send("state", {round, votes})                │
          ▼                                                 │
   ┌────────────────────┐   2. websocket (broadcast)        │
   │  Supabase Realtime │ ──────────────────────────────────┼──► 3. applyRemote()
   │  kanał publiczny   │                                   │    ├── mergeRound()
   │  "wyceniacz"       │                                   │    └── mergeVotes()
   │                    │ ◄─────────────────────────────────┘
   │  bez tabel!        │
   └────────────────────┘
          │
          └─ 4. presence → licznik "Online"
```

**Kluczowa zasada:** nie ma serwera, który wie, jak jest. Każda karta trzyma **własny
obraz** głosowania i cyklicznie go ogłasza, a pozostali go scalują. Zamiast pytać bazę,
wymieniamy się stanem. To jest cała architektura.

Brak bazy nie oznacza chaosu, bo scalanie jest **przemienne i idempotentne** —
kolejność i liczba powtórzonych wiadomości nie mają znaczenia (patrz sekcja 6).

---

## 5. Model stanu

Nie ma tabel. Są dwa byty: **głosowanie** i **głosy**.

### Głosowanie

```js
{
  id: "2026-09-30#2",   // dzien + numer w tym dniu
  status: "open",       // "open" | "revealed"
  revealedAt: null,     // ISO albo null
  jiraUrl: null,        // link do ticketu
  urlAt: 0,             // kiedy link ostatnio zmieniono (do scalania)
  at: 1735...,          // kiedy cokolwiek w glosowaniu zmieniono
}
```

**Niezmiennik:** identyfikator zawiera dzień. Dzięki temu głos z innego dnia **fizycznie
nie ma jak** dopasować się do dzisiejszego głosowania — i dlatego nie trzeba żadnego
filtrowania po czasie.

### Głosy

```js
// Map<voterId, { be?: number, fe?: number, qa?: number, rev: number }>
// "rev" to pieczatka czasu ostatniej zmiany wlasnego glosu.
```

**Niezmiennik:** wpis głosującego należy **wyłącznie do niego**. Nikt nigdy nie pisze
cudzego głosu — może go tylko przekazać dalej. Dlatego konflikty są praktycznie niemożliwe.

### Cykl życia

```
                    reset()
   [open] ─────────────────────────► [open]  nowy numer, np. #2
      │                                 │
      │ reveal()                        │ glosy wyczyszczone
      ▼                                 ▼
   [revealed]  (widoczne do konca dnia)
      │
      └─ po pólnocy ──► nowy dzien = nowe puste glosowanie
```

- **Reset** = nowy identyfikator (`#n+1`); wszystkie głosy przepadają, bo należały
  do poprzedniego głosowania.
- **Odkrycie** = `status: "revealed"`; nieodwracalne w ramach dnia.
- **Północ** = identyfikator traci ważność; patrz sekcja 8.

---

## 6. Protokół wymiany

Wszystko dzieje się na jednym kanale (`CHANNEL_NAME = 'wyceniacz'`) i składa się
z **dwóch** zdarzeń. To cały protokół.

| Zdarzenie | Kiedy | Treść |
| --- | --- | --- |
| `state` | przy każdej zmianie, co `HEARTBEAT_MS`, po prośbie o synchronizację, przy powrocie do karty | `{ voterId, round, votes }` — `votes` to **cały znany obraz** |
| `sync-request` | świeżo otwarta karta po zasubskrybowaniu | `{ voterId }` — prośba, by obecni odesłali swój stan |

### Trzy reguły scalania

Rozstrzygają jednoznacznie, kto ma rację — bez serwera i bez zegara.

**1. Głosowanie: wygrywa większy identyfikator.**

```js
compareRounds('2026-09-30#2', '2026-09-30#10')  // -> -1  (numer, nie napis!)
compareRounds('2026-10-01#1', '2026-09-30#9')   // -> 1   (dzien przed numerem)
```

Porównywanie samych napisów byłoby błędem: `"#10"` wypada przed `"#2"`. Dlatego
`compareRounds` porównuje najpierw dzień, potem **liczbę**.

**2. Ten sam identyfikator: `revealed` bije `open`**, a link wygrywa po `urlAt`.
Odkrycia nie da się cofnąć przez spóźnioną wiadomość.

**3. Głos: wygrywa większy `rev`.**

```js
if (!known || rev > known.rev) state.votes.set(id, entry);
```

`rev` jest pieczątką czasu właściciela i **musi rosnąć**:

```js
lastRev = Math.max(Date.now(), lastRev + 1);
```

To nie kosmetyka. Bez tego karta, która była offline i wróci z **starą** kopią cudzego
głosu, mogłaby przywrócić głos, który jego właściciel już cofnął. Z `rev` stara kopia
zawsze przegrywa.

### Dlaczego wolno przekazywać cały obraz

`state` zawiera też cudze głosy, nie tylko własny. Dzięki `rev` to jest bezpieczne:
przekazana kopia nie nadpisze nowszej. Bez `rev` przekazywanie cudzych głosów byłoby
groźne i trzeba by ograniczyć się do własnego wpisu.

### Wiadomość przychodzi z opóźnieniem, powtórzona albo wcale

`broadcast` **nie gwarantuje** dostarczenia. Nie ma potwierdzeń, nie ma kolejki.
Dlatego:

- odpowiedź na `older`/`foreign` to natychmiastowe odesłanie własnego stanu,
- dosyłka co 15 s to mechanizm samonaprawy,
- powrót do karty wymusza `state` + `sync-request`.

Bez dosyłki jedna zgubiona wiadomość rozjechałaby karty na stałe.

---

## 7. Pamięć lokalna

Dwa klucze:

| Klucz | Zawartość |
| --- | --- |
| `wyceniacz.voterId` | UUID tożsamości — **nie** per karta, jedna osoba = jeden głos |
| `wyceniacz.state` | ostatni znany obraz: `roundId`, `status`, `jiraUrl`, `urlAt`, `at`, `votes` |

Zapisywany jest **cały obraz, także cudze głosy**. To świadoma decyzja: dzięki temu
odświeżenie strony nic nie gubi, a gdy ktoś był tylko odbiorcą, jego karta nadal zna wynik.

Pamięć jest **wyłącznie lokalna** — nigdy nie jest nigdzie wysyłana jako zapis.

---

## 8. Twarda północ

Głosowanie obowiązuje w ramach jednego dnia kalendarzowego. Dwie konsekwencje:

**Przy starcie** — ślad z innego dnia jest odrzucany:

```js
if (roundDay(s.roundId) !== todayKey()) return null;
```

**W otwartej karcie** — kontrola co 30 s:

```js
if (state.round && roundDay(state.round.id) !== todayKey()) startRound(1);
```

Sesja, która trwa o 00:00, **przerywa się** i startuje puste głosowanie na nowy dzień.
To wybór produktowy, nie przeoczenie — jedna reguła „głosowanie trwa jeden dzień" jest
prostsza do wytłumaczenia niż wyjątki dla sesji nocnych.

---

## 9. Architektura klienta

### Stan

```js
state = {
  round: null,      // biezace glosowanie; null tylko przez chwile po starcie
  votes: new Map(), // voterId -> { be?, fe?, qa?, rev }
  online: 0,        // liczba osob na stronie (Presence)
}
```

`refs` trzyma referencje do elementów DOM per sekcja:
`{ buttons, input, errEl, votesOut, votesValueEl, avgOut, avgLabel, avgValue }`.

### Kolejność uruchomienia

```
init()
 ├─ buildUI()                 trzy kolumny, raz
 ├─ applyStored()             wczytaj dzisiejszy slad (jesli jest)
 ├─ renderAll()
 ├─ subscribe()               kanal + presence
 │    └─ SUBSCRIBED -> track(), sync-request, sendState()
 ├─ setTimeout(..., 1200)     gdy nikt nie odpowiedzial -> startRound(1)
 ├─ setInterval 15 s          dosylka
 └─ setInterval 30 s          kontrola pólnocy
```

Gracja `PEER_GRACE_MS` istnieje po to, żeby świeżo otwarta karta nie mrugnęła pustym
głosowaniem, zanim dowie się, że ktoś już głosuje. Przy braku odpowiedzi zakłada
`<dzien>#1`.

### Renderowanie

```
zmiana lokalna / applyRemote()
        │
        ├── renderAll() ──► renderSections() ──► renderSelection(key)   [per sekcja]
        │                                    └──► renderPanel()
        └── sendState()
```

`renderSelection(key)` jest **jedynym** miejscem, które decyduje, co jest zaznaczone.
Nie duplikuj tej logiki — patrz sekcja 11.

### Presence

```js
supabase.channel('wyceniacz', { config: { presence: { key: voterId } } })
```

Klucz Presence = `voterId`, więc dwie karty tej samej osoby liczą się jako jedna osoba.
Licznik pokazuje „ile osób", nie „ile kart".

---

## 10. Reguły biznesowe

### Zaokrąglanie — najważniejsza formuła

```js
const ceilHalf = (n) => Math.ceil(n * 2 - 1e-9) / 2;
```

Ceiling do wielokrotności 0.5: `3.1 → 3.5`, `3.0 → 3.0`, `2.75 → 3.0`.

**Epsilon `1e-9` nie jest ozdobnikiem.** Bez niego średnia równa dokładnie np. `2.5`
mogła przez błąd reprezentacji zmiennoprzecinkowej wyskoczyć jako `3.0`. Jest bezpieczny,
bo wartości mają maksymalnie 2 miejsca po przecinku — średnia różniąca się od wielokrotności
0.5 o mniej niż 1e-9 po prostu nie może istnieć.

Dlatego w interfejsie etykieta mówi **„Wynik"**, a nie „Średnia" — pokazywana liczba nie
jest średnią, tylko średnią podniesioną w górę. Nie zmieniaj tej etykiety z powrotem.

### Suma

Suma **trzech zaokrąglonych średnich**, nie surowych. Sekcja bez głosów wchodzi jako `0`.
Czyli pokazywana suma zawsze zgadza się z trzema liczbami nad nią — to jest ta liczba,
którą wkleja się do ticketu.

### Odmiana liczebnika

```js
0 głosów · 1 głos · 2 głosy · 4 głosy · 5 głosów · 12 głosów · 22 głosy
```

Reguła: `n === 1` → „głos"; końcówka 2–4 poza 12–14 → „głosy"; reszta → „głosów".

### Widoczność

| Stan | Co widać w sekcji |
| --- | --- |
| `open` | Tylko liczba oddanych głosów (etykieta „Głosy" jest ukryta). **Bez** wartości, wyniku i sumy |
| `revealed` | Etykieta „Głosy" i lista głosów rosnąco (z przecinkami), pod nią wynik, w panelu suma |

Ukrywanie wartości przed odkryciem jest sensem całej apki — chodzi o to, żeby nikt nie
sugerował się cudzymi liczbami.

### Blokady

- Po odkryciu przyciski i pole są zablokowane. Zmiana wymaga resetu.
- Pole własnej wartości: zablokowane, ale jego treść pozostaje widoczna.

### Reset — dwa tryby

| Stan | Zachowanie |
| --- | --- |
| `open` | **Dwa kroki.** Pierwszy klik zmienia napis na „Potwierdź reset" (6 s). Głosy przepadają bez śladu, więc pytanie ma sens |
| `revealed` | **Od razu.** Wartości są już widoczne dla wszystkich, nic nie przepada |

---

## 11. Zaznaczanie wyboru — zasada, której łatwo nie zauważyć

> **Pole z wpisaną treścią ma pierwszeństwo nad przyciskami.**

Scenariusz, który to wymusił: użytka wybiera „3" przyciskiem, potem wpisuje „9" w polu.
Przed poprawką **oba** wskaźniki świeciły naraz — nie było wiadomo, co się liczy.

| Sytuacja | Zaznaczony przycisk | Pole podświetlone |
| --- | --- | --- |
| Głos „3", pole puste | `3` | nie |
| Głos „3", wpisane „9" (bez opuszczenia) | **brak** | **tak** |
| Pole wyczyszczone | `3` wraca | nie |

Cała logika siedzi w `renderSelection(key)`. Jest wołane przy każdym odświeżeniu
i z handlera `input` (przy każdym wpisanym znaku).

### Powiązane pułapki

**`renderSections` nie może ruszać pola, gdy ma fokus:**

```js
if (document.activeElement !== r.input) {
  r.input.value = mineIsCustom ? fmt(mineValue) : '';
}
```

Bez tego warunku każde odświeżenie z Realtime kasowałoby wpisywaną wartość w połowie pisania.

**Cofanie głosu patrzy na DOM, nie na dane:**

```js
if (przycisk && przycisk.classList.contains('active')) withdrawVote(section);
```

Wcześniej patrzyło na stan głosów, który po wpisaniu innej wartości jest nieaktualny,
i kliknięcie przycisku **cofało** głos zamiast go wybierać.

---

## 12. Kolory — i dlaczego są właśnie takie

| Element | Odcień | Kolor |
| --- | --- | --- |
| „Odkryj" (akcent) | 26° | `#b45309` ochra |
| Suma końcowa (panel) | 26° | `#b45309` ochra — celowo ten sam akcent co „Odkryj" |
| Reset (danger) | ~6° | `#c0392b` |
| Testy | 175° | `#0d9488` morski |
| Backend | 221° | `#2563eb` niebieski |
| Frontend | 336° | `#9d174d` bordo |

Ciepła strona koła (0–40°) jest **zajęta** przez akcent i danger. Dlatego kolory sekcji
muszą być rozłożone poza nią.

**Zmiana koloru sekcji:** jedna linia w `styles.css`:

```css
.col[data-section="fe"] { --sec: #9d174d; --sec-soft: #f9edf2; }
```

Wszystko w kolumnie bierze kolor z `--sec`: pasek u góry, kropka przy nazwie, hover
przycisków, aktywny przycisk, ramka i tekst aktywnego pola oraz wynik.

**Przy zmianie sprawdź trzy rzeczy:**

1. Odległość na kole barw od pozostałych sekcji — **min. ~100°**. Niebieski i fiolet
   (`#7c3aed`, 262°) mają 41° i były nierozróżnialne w praktyce.
2. Odległość od akcentu (26°) i danger (~6°).
3. Kontrast białego tekstu na kolorze (aktywny przycisk) — **min. 4.5:1**.

Historia decyzji: róż `#db2777` został odrzucony, oliwka `#4d7c0f` rozważana, ostatecznie
bordo `#9d174d` — 115° od Backendu, 161° od Testów, kontrast 7.88.

---

## 13. Pułapki, które już nas kosztowały czas

### Testowanie: dwie karty pod tym samym adresem to jedna osoba

Karty dzielą `localStorage`, więc mają **ten sam `voterId`** i liczą się jako jedna osoba.
Żeby zasymulować dwie osoby, otwórz apkę pod dwoma różnymi originami
(`http://localhost:8123` i `http://127.0.0.1:8123`). Próba podmiany `voterId` w jednej
karcie zmienia go w **obu** (wspólny magazyn) i miesza wyniki.

### Zamknięta karta może jeszcze przez chwilę nadawać

Narzędzie zamykające kartę nie zawsze zamyka ją czysto — strona potrafi jeszcze wysłać
stan, a wpis w Presence („Online") zniknie dopiero po chwili. To artefakt środowiska
testowego, nie błąd apki. Przy zwykłym zamknięciu karty w przeglądarce rozłączenie jest
czyste i licznik spada od razu.

### `rev` i numer głosowania muszą być monotoniczne

Oba są **jedynym** rozstrzygnięciem konfliktów. Jeśli `rev` przestanie rosnąć (np. przy
skróceniu zapisu do licznika od 1), kopia z cudzego dysku zacznie wygrywać z prawdziwym
głosem. Dlatego `rev` bierze się z `Date.now()` z gwarancją `max(now, lastRev + 1)`.

### Wpisy głosów nigdy nie są usuwane z mapy

Cofnięcie głosu zostawia wpis **bez sekcji, z podniesionym `rev`**. Gdyby wpis zniknął,
cudza karta ze starą kopią nie miałaby czego nadpisać i wskrzesiłaby cofnięty głos.

### Nowe głosowanie musi wyczyścić głosy

`adoptRound()` czyści całą mapę. Głosy z poprzedniego numeru nie mają prawa wejść do
nowego. Zapomnienie o tym to najprostszy sposób, żeby „stare" głosy wróciły po resecie.

### `send()` może polecieć przez REST

Gdy websocket nie jest jeszcze gotowy, `supabase-js` wysyła broadcast przez REST pod
`/realtime/v1/api/broadcast` i loguje ostrzeżenie. **To nie jest zapis do bazy.** Żaden
request nie idzie do PostgREST (`/rest/v1`) — i tak ma zostać.

### CSS transition psuje odczyt stylów

`getComputedStyle` zwraca dla właściwości animowanych **wartość sprzed zmiany** w zerowej
klatce przejścia. `.val-input` ma `transition` na kolorze, tle i ramce, więc bezpośrednio
po dodaniu klasy pomiar pokazuje stare wartości. `font-weight` nie ma transition, więc
zmienia się natychmiast — co daje złudzenie, że „część stylów działa, a część nie".

**To doprowadziło do dwóch fałszywych alarmów.** Odczytuj style w osobnym wywołaniu, nie
w tym samym ticku, w którym zmieniasz klasę.

### Serwer HTTP jest obowiązkowy

Moduły ES nie działają z `file://`. Bez serwera appka nie wystartuje wcale.

### Windows wypisuje ostrzeżenia o CRLF

`LF will be replaced by CRLF` przy `git add` są nieszkodliwe. Nie „naprawiaj" ich
zmieniając konfigurację gita.

---

## 14. Konwencje kodu

- **Teksty interfejsu:** polski, pełne znaki diakrytyczne („Wyczyść pole").
- **Komentarze:** polski, opisują *dlaczego*, nie *co*. Wartościowe komentarze wyjaśniają
  decyzje („bez tego przerysowanie gubi wpisywaną wartość").
- **Nazwy w kodzie:** angielskie (`renderSelection`, `sendState`, `mergeRound`).
- **Bezpieczeństwo DOM:** dane pochodzące od użytkownika (link do Jiry!) nigdy przez
  `innerHTML`. Buduj przez `createElement` + `textContent`, a adresy przepuszczaj przez
  `safeUrl()` (przepuszcza tylko `http:`/`https:`).
- **Sekcje kodu** w `app.js` oddzielone komentarzami-blokami: konfiguracja → narzędzia →
  stan → własny głos → pamięć lokalna → głosowanie → budowa UI → renderowanie → akcje →
  zdarzenia → toast → Realtime → start.
- **Dodając element interfejsu:** nigdy nie używaj `innerHTML` na kontenerze, w którym
  są pola formularza.

---

## 15. Częste zadania

| Zadanie | Co zmienić |
| --- | --- |
| **Zmiana skali przycisków** | `PRESET_VALUES` (+ ewentualnie `MIN_VALUE`/`MAX_VALUE`) w `app.js`. **Nic w bazie** — bazy nie ma |
| **Zmiana zakresu pola własnego** | `MIN_VALUE`, `MAX_VALUE` w `app.js` |
| **Zniesienie / zmiana zasady północy** | `loadStored()` (odrzucanie innego dnia) **oraz** interwał kontrolny w `init()`; ewentualnie `todayKey()` |
| **Zmiana częstotliwości dosyłki** | `HEARTBEAT_MS` w `app.js` |
| **Zmiana czasu na odpowiedź innych** | `PEER_GRACE_MS` w `app.js` |
| **Kolor sekcji** | jedna linia `[data-section="..."]` w `styles.css` (sprawdź odległości odcieni) |
| **Dodanie czwartej sekcji** | `SECTIONS` w `app.js` + reguła `[data-section]` w CSS + `grid-template-columns`; w `SECTIONS` potrzebny jest tylko `key` i `label`, bo głosy siedzą w mapie |
| **Nowe pole w głosowaniu** (np. notatka) | obiekt `round` + `normalizeRound()` + `mergeRound()` (reguła scalania!) + `persist()` |
| **Zmiana nazwy kanału** | `CHANNEL_NAME` — **musi** być identyczna u wszystkich, inaczej karty się nie znajdą |
| **Diagnostyka ruchu** | zakładka Network: poza websocketem nie może być żadnego żądania do `/rest/v1` |

---

## 16. Jak sprawdzić, że działa

### Dwie osoby bez dwóch komputerów

Dwa różne originy, bo karty pod jednym adresem dzielą tożsamość:

```
http://localhost:8123/     <- osoba A
http://127.0.0.1:8123/     <- osoba B
```

Otwórz oba, zagłosuj w jednym — drugi ma pokazać licznik bez przeładowania.

### Twardy dowód braku zapisu

W zakładce Network **nie może być ani jednego** żądania do `/rest/v1`.
Jedyne połączenie do Supabase to `wss://.../realtime/v1/websocket`.

### Utrata nadziei, że zapis istnieje

Zagłosuj, zamknij obie karty, otwórz na nowo — głosy przepadły (poza własnymi z dysku).
To jest **oczekiwane** działanie, nie objaw awarii.

### Ślad z innego dnia

Wstaw do `localStorage` pod `wyceniacz.state` stan z wczorajszym `roundId` i cudzym
głosem, przeładuj — ma wystartować puste głosowanie na dziś, a wczorajszy głos nie może
się pojawić.

### Północ w otwartej karcie

Podmień `window.Date` na przesunięty o dobę i poczekaj ~33 s — głosowanie ma przejść na
nowy dzień i wyczyścić głosy.

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
| **Trwały zapis, baza, historia** | Wymóg organizacyjny: brak pozwolenia na przechowywanie danych |
| **Wracanie do głosowania po wczoraj** | Głosowanie obowiązuje jeden dzień — patrz sekcja 8 |
| PIN / hasło | Rozważane. Odrzucone — nie ma już bazy do obrony, a PIN to tarcie przy każdym wejściu |
| Wiele pokoi / równoległych wycen | Jedno globalne głosowanie wystarcza zespołowi |
| Logowanie, imiona, awatary | Wymóg wprost: bez logowania i bez imion |
| Story points | Jednostką są osobodni (MD) |
| Edycja / usuwanie cudzych głosów | Nie ma do tego żadnej drogi — wpis głosującego należy tylko do niego |
| Serwer pośredniczący, własne API | Apka jest statyczna i ma taka zostać |
| Build step, framework, TypeScript | Apka jest zbyt mała, a prostota wdrożenia jest wartością |
| Testy automatyczne | Logika jest w jednym pliku po stronie klienta; weryfikacja jest ręczna (sekcja 16) |
