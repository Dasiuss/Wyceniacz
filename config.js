/* ---------------------------------------------------------------------------
   Wyceniacz - konfiguracja polaczenia z Supabase
   ---------------------------------------------------------------------------
   Ten projekt nie ma zadnych tabel. Klucz sluzy wylacznie do wejscia na kanal
   Realtime (broadcast + presence), przez ktory karty wymieniaja sie glosami.
   Nic nie jest nigdzie zapisywane - dane zyja w otwartych przegladarkach.

   Klucz publishable jest przeznaczony do uzycia w przegladarce i moze byc
   publiczny. Nigdy nie wklejaj tu klucza "secret"/service_role.
--------------------------------------------------------------------------- */

export const SUPABASE_URL = 'https://qxxiujhtjffwptubvcih.supabase.co';

export const SUPABASE_KEY = 'sb_publishable_KZHlKoj3Cdmiq9kLx0Un1g_PGXkKojI';
