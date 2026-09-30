# Wyceniacz

Wewnętrzna apka web do zespołowego wyceniania ticketów Jiry w **MD (osobodniach)**.
Trzy niezależne sekcje — **Backend**, **Frontend**, **Testy** — głosowanie w czasie
rzeczywistym, bez logowania i bez imion. Zastępuje plugin do Jiry, który u nas nie działa.

Komputer-first, vanilla JS, bez builda.

> **Nic nie jest nigdzie zapisywane.** Nie ma bazy danych ani historii. Głosy żyją
> wyłącznie w otwartych przeglądarkach i znikają, gdy wszyscy zamkną stronę.

> **Pracujesz nad kodem?** Zobacz [`AGENTS.md`](AGENTS.md) — architektura, protokół
> wymiany głosów, reguły biznesowe, konwencje i pułapki. Ten plik jest dla użytkownika.

---

## Jak to działa

- Każdy głos leci od razu przez kanał Realtime do pozostałych otwartych przeglądarek.
- **Przed** kliknięciem „Odkryj" widać tylko liczbę oddanych głosów w sekcji — nie widać
  ani czyichś wartości, ani tego, ile osób *powinno* zagłosować.
- **Odkryj** (może kliknąć każdy) pokazuje listę głosów, średnie i sumę.
- **Resetuj** (może kliknąć każdy) czyści głosy i link, i startuje nowe głosowanie.
  **Potwierdzenia wymaga tylko przed odkryciem** — pierwszy klik zmienia napis na
  „Potwierdź reset". Po odkryciu wartości są już widoczne dla wszystkich, więc reset
  działa od razu.
- **Link do Jiry** jest edytowalny zawsze; przycisk obok otwiera go w nowej karcie.
- **Cofnąć głos** można klikając drugi raz we własny, aktywny przycisk (albo czyszcząc pole).
- **Online** pokazuje, ile osób ma aktualnie otwartą stronę.

### Głosowanie trwa jeden dzień

Głosowanie ma tożsamość, która zawiera datę — na przykład `2026-09-30#2`. Konsekwencje:

- Po północy obowiązuje już nowy dzień i **wszystkie karty zaczynają puste głosowanie**.
  Jeśli sesja trwa o 00:00, zostanie przerwana — to celowe i przewidywalne.
- **Głos z zeszłego tygodnia nie może wrócić** do nowego głosowania: ma inny dzień
  w swoim identyfikatorze, więc nie ma jak się dopasować.
- W ramach jednego dnia przeglądarka pamięta ostatni stan, więc przypadkowe odświeżenie
  strony (F5) nie kasuje wpisanych głosów.

### Dopóki ktoś ma otwartą stronę, stan istnieje

Nie ma serwera, który przechowywałby głosowanie. Każda karta zna bieżący obraz i wymienia
się nim z pozostałymi. Dlatego:

- gdy choć jedna osoba miała stronę otwartą przez cały czas — obraz wraca,
- gdy **wszyscy** zamkną przeglądarki — wracają tylko pojedyncze, własne głosy z dysków;
  reszta przepada. To definicja tego modelu, nie usterka.

### Zasady wyliczeń

| Rzecz | Zasada |
| --- | --- |
| Skala przycisków | `1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6` — po dwa w rzędzie, obok „6" pole własnej wartości |
| Pole własnej wartości | dowolna liczba z zakresu `1 – 15`, zapis z dokładnością do 2 miejsc |
| Cofanie głosu | kliknięcie własnego, aktywnego przycisku drugi raz (albo wyczyszczenie pola) |
| Średnia sekcji | średnia głosów zaokrąglona **w górę** do wielokrotności `0.5` (ceiling) |
| Sekcja bez głosów | lista `–`, średnia `–`, do sumy wchodzi jako `0` |
| Suma | suma trzech zaokrąglonych średnich (BE + FE + Testy) |
| Tożsamość głosującego | losowy UUID w `localStorage` — jeden głos na sekcję na przeglądarkę |
| Historia | **nie istnieje** — nic nie jest zapisywane |

---

## Konfiguracja Supabase

Potrzebny jest tylko projekt z włączonym Realtime i **dwiema wartościami** w
[`config.js`](config.js): adresem projektu i kluczem **publishable**.

**Żadnych tabel, schematów ani SQL-a.** Aplikacja korzysta wyłącznie z kanału
Realtime (`broadcast` + `presence`), który działa od razu, bez przygotowania bazy.

Publishable key jest z założenia publiczny — trafia do przeglądarki. Nigdy nie wklejaj
tu klucza `secret` / `service_role`.

---

## Sprzątanie po starej wersji (opcjonalne)

Wcześniejsza wersja trzymała głosy i historię w schemacie `wyceniacz`. Obecna wersja
go nie używa. Jeśli chcesz posprzątać, zrób to **ręcznie, raz**:

**1. Usuń schemat** — Dashboard → **SQL Editor** → *New query* → wklej i **Run**:

```sql
drop schema if exists wyceniacz cascade;
```

`cascade` usunie tabele, funkcje i trigger. **Nie dotyka** `public.meetings` ani niczego
innego w projekcie. Tabele znikną też automatycznie z publikacji Realtime.
Operacja jest **nieodwracalna**.

**2. Usuń schemat z API** — Dashboard → **Project Settings → API → Exposed schemas** →
usuń `wyceniacz` i zapisz.

Po tych krokach aplikacja działa dalej bez żadnych zmian — nie potrzebuje bazy.

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

> Dwie karty otwarte pod **tym samym adresem** dzielą `localStorage`, więc są tą samą
> osobą (jeden głos). Aby zasymulować dwie osoby, otwórz apkę pod dwoma różnymi
> adresami, np. `http://localhost:8000` i `http://127.0.0.1:8000` — to różne originy,
> więc różne tożsamości.

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

> Artefakt bierze całe repo (poza `.git` i `.github`), więc w apce leżą też
> `README.md` i `AGENTS.md`. Nie ma tam nic wrażliwego — klucz publishable i tak
> musi być w `config.js`.

---

## Bezpieczeństwo i limity

Skoro nic nie jest zapisywane, nie ma czego zapełnić ani wyciec z bazy:

- **Żaden request nie idzie do bazy danych.** Cała komunikacja to kanał Realtime —
  głosy są przesyłane na żywo i nigdzie nie są przechowywane.
- **Nie ma limitów głosów na sekcję**, bo nie istnieje żaden trwały zbiór, który
  można by nimi chronić.
- **Kanał jest publiczny dla posiadaczy klucza projektu.** Osoba, która ma adres apki
  i klucz publishable, mogłaby teoretycznie podłączyć się do kanału i podejrzeć głosy
  w locie. Znika to w momencie zamknięcia strony, a dane są beznazwowe — same liczby.
- Aplikacja działa na darmowym planie Supabase, gdzie przekroczenie limitów skutkuje
  ograniczeniem projektu, a nie fakturą.

---

## Struktura

```
index.html                      szkielet strony
styles.css                      style
config.js                       URL projektu + publishable key
app.js                          cała logika (kanał, render, akcje, pamięć lokalna)
.github/workflows/deploy.yml    automatyczny deploy na GitHub Pages
README.md                       ten plik — użytkowanie i wdrożenie
AGENTS.md                       dokumentacja techniczna dla pracujących nad kodem
```

---

## Rozwiązywanie problemów

| Objaw | Przyczyna |
| --- | --- |
| „Brak połączenia na żywo" na czerwono | brak sieci albo zły URL/klucz w `config.js`; apka ponawia próbę w tle |
| Licznik „Online" pokazuje kogoś, kogo już nie ma | karta została zamknięta bez czystego rozłączenia; licznik sam się poprawi po chwili |
| Głosy zniknęły, gdy wszyscy wyszli | tak działa ten model — nic nie jest zapisywane trwale |
| Rano strona startuje pusta | minęła północ, głosowanie obowiązuje w ramach jednego dnia |
| „Głosowanie jest już odkryte" | po odkryciu głosy są zablokowane; kliknij Resetuj |
| Zmiany nie pojawiają się na żywo | druga karta jest pod tym samym adresem i tą samą tożsamością |
