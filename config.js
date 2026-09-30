/* ---------------------------------------------------------------------------
   Wyceniacz - konfiguracja polaczenia z Supabase
   ---------------------------------------------------------------------------
   Klucz publishable jest przeznaczony do uzycia w przegladarce i moze byc
   publiczny - uprawnienia pilnuje baza (RLS + funkcje RPC w schemacie).
   Nigdy nie wklejaj tu klucza "secret"/service_role.
--------------------------------------------------------------------------- */

export const SUPABASE_URL = 'https://qxxiujhtjffwptubvcih.supabase.co';

export const SUPABASE_KEY = 'sb_publishable_KZHlKoj3Cdmiq9kLx0Un1g_PGXkKojI';

export const DB_SCHEMA = 'wyceniacz';
