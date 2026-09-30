# Wyceniacz

Wewnętrzna apka web do zespołowego wyceniania ticketów Jiry w **MD (osobodniach)**.
Trzy niezależne sekcje — **Backend**, **Frontend**, **Testy** — głosowanie w czasie
rzeczywistym, bez logowania i bez imion. Zastępuje plugin do Jiry, który u nas nie działa.

Komputer-first, vanilla JS, bez builda. Stan trzyma Supabase (Postgres + Realtime + Presence).

---

## Jak to działa

- Każdy zagłosowany klik leci od razu do bazy i rozchodzi się websocketem do pozostałych.
- **Przed** kliknięciem „Odkryj" widać tylko liczbę oddanych głosów w sekcji — nie widać
  ani czyichś wartości, ani tego, ile osób *powinno* zagłosować.
- **Odkryj** (może kliknąć każdy) pokazuje listę głosów, średnie i sumę. Głosowanie do
  historii trafia tylko wtedy, gdy ma co najmniej jeden głos.
- **Resetuj** (może kliknąć każdy) czyści bieżące głosy i link, i startuje nowe głosowanie.
  Wymaga podwójnego potwierdzenia: pierwszy klik zmienia napis na „Potwierdź reset".
  Reset bez wcześniejszego odkrycia nie zapisuje niczego do historii.
- **Link do Jiry** jest edytowalny zawsze; historia zapamiętuje go razem z głosowaniem.
- **Online** pokazuje, ile osób ma aktualnie otwartą stronę (jeden licznik na przeglądarkę).

### Zasady wyliczeń

| Rzecz | Zasada |
| --- | --- |
| Skala przycisków | `0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6` |
| Pole własnej wartości | dowolna liczba z zakresu `0.5 – 15`, zapis z dokładnością do 2 miejsc |
| Średnia sekcji | średnia głosów zaokrąglona **w górę** do wielokrotności `0.5` (ceiling) |
| Sekcja bez głosów | lista `–`, średnia `–`, do sumy wchodzi jako `0` |
| Suma | suma trzech zaokrąglonych średnich (BE + FE + Testy) |
| Tożsamość głosującego | losowy UUID w `localStorage` — jeden głos na sekcję na przeglądarkę |
| Historia | wspólna, w bazie, maksymalnie 100 najnowszych głosowań |

---

## Konfiguracja Supabase

### 1. Uruchom `sql/setup.sql`

Supabase Dashboard → **SQL Editor** → *New query* → wklej całą zawartość
[`sql/setup.sql`](sql/setup.sql) → **Run**.

Skrypt jest idempotentny (można go uruchamiać wielokrotnie) i tworzy:

- schemat `wyceniacz` — **nie rusza** `public.meetings` ani niczego innego w projekcie,
- tabele `wyceniacz.votings` i `wyceniacz.votes`,
- RLS, w której `anon` ma **wyłącznie `SELECT`** (potrzebny Realtime'owi); każdy zapis
  idzie przez funkcje `SECURITY DEFINER`,
- RPC: `get_state`, `get_history`, `submit_vote`, `set_jira_url`, `reveal_voting`,
  `reset_voting`,
- trigger przycinający historię do 100 najnowszych głosowań,
- publikację Realtime dla obu tabel.

### 2. Wystaw schemat na API ⚠️

Dashboard → **Project Settings → API → Exposed schemas** → dopisz `wyceniacz` i zapisz.

Bez tego kroku `supabase-js` zwróci `404` / `PGRST106`, bo PostgREST nie widzi schematu.
Gdyby zakładka kiedyś zniknęła, to samo ustawia się SQL-em:

```sql
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, wyceniacz';
notify pgrst, 'reload config';
```

### 3. Sprawdź dane połączenia

[`config.js`](config.js) zawiera URL projektu i **publishable** key. Ten klucz jest z założenia
publiczny — uprawnienia pilnuje baza. Nigdy nie wklejaj tam klucza `secret` / `service_role`.

---

## Uruchomienie lokalne

Moduły ES nie działają z `file://`, więc potrzebny jest jakikolwiek serwer HTTP:

```bash
# Python
python -m http.server 8000

# albo Node
npx serve .
```

I wejdź na <http://localhost:8000>.

---

## Wdrożenie na GitHub Pages

Deploy jest w pełni automatyczny — plik [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).
Apka nie ma builda, więc workflow po prostu publikuje pliki z repo.

**Jednorazowa konfiguracja:**

1. **Settings → Pages → Source: `GitHub Actions`** → Save.
   *(Bez tego `deploy-pages` padnie z błędem „Pages not enabled".)*
2. Wypchnij cokolwiek na `main` albo odpal workflow ręcznie:
   **Actions → Deploy na GitHub Pages → Run workflow**.

**Co się dzieje dalej:**

- każdy `push` na `main` → nowy deploy,
- adres apki: `https://<user>.github.io/Wyceniacz/`,
- adres pojawia się też w logu joba `Publikacja` (`page_url`).

> Artefakt bierze całe repo (poza `.git` i `.github`), więc w apce leży też
> `README.md` i `sql/setup.sql`. Nie ma tam nic wrażliwego — klucz publishable
> i tak musi być w `config.js`.
>
> GitHub Pages z **prywatnego** repo wymaga płatnego planu. Przy publicznym repo adres jest
> publiczny, więc i publishable key jest publiczny — dlatego limity po stronie bazy
> (poniżej) są ważne.

---

## Bezpieczeństwo i limity

Klucz publishable jest publiczny, więc baza sama się broni:

- `anon` może **tylko czytać**. Nie da się `INSERT`/`UPDATE`/`DELETE` przez REST.
- Wszystkie zapisy przechodzą przez RPC, które walidują dane wejściowe:
  - zakres wartości `0.5 – 15`,
  - sekcja wyłącznie `be` / `fe` / `qa`,
  - **maksymalnie 10 głosów na sekcję** w jednym głosowaniu,
  - link do Jiry ucinany do 500 znaków.
- Historia jest przycinana do 100 głosowań, a głosowania ujawnione bez głosów są usuwane.
  Cała baza zatem nigdy nie przekroczy kilku MB.
- Dane są beznazwowe i bezużyteczne — same liczby.

Projekt działa na darmowym planie Supabase, gdzie przekroczenie limitów skutkuje
ograniczeniem projektu, a nie fakturą.

---

## Struktura

```
index.html      szkielet strony
styles.css      style
config.js       URL + publishable key + nazwa schematu
app.js          cała logika (realtime, render, akcje)
sql/setup.sql   konfiguracja bazy (do wklejenia w SQL Editor)
```

---

## Rozwiązywanie problemów

| Objaw | Przyczyna |
| --- | --- |
| `404` / `PGRST106` przy starcie | brak `wyceniacz` w **Exposed schemas** |
| `Could not find the table` | nie uruchomiono `sql/setup.sql` |
| Zmiany nie pojawiają się na żywo | tabele nie są w publikacji `supabase_realtime` |
| `Limit 10 glosow w tej sekcji` | twardy limit bezpieczeństwa — zresetuj głosowanie |
| „Głosowanie jest już odkryte" | po odkryciu głosy są zablokowane; kliknij Resetuj |
