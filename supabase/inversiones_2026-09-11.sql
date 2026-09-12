-- Sección Inversiones — ejecutar en el SQL Editor de Supabase.
-- Tablas: inv_transactions (trades), inv_settings (deuda global), inv_tokens (mapeo
-- de símbolo a CoinGecko + override de precio). RLS por user_id, igual que el resto.
--
-- Todas llevan `id uuid` como PK aunque la clave natural sea otra: la capa db.js
-- direcciona por `id` para cualquier tabla (update/remove hacen .eq("id", id)).

create table if not exists public.inv_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  portfolio text not null default 'Principal',
  ts timestamptz not null,                  -- fecha/hora del trade
  symbol text not null,                     -- ticker tal cual viene del exchange (NEXO, ALVA)
  name text,                                -- nombre largo, si se conoce
  type text not null,                       -- buy | sell | transferIn | transferOut
  price numeric,                            -- USD por unidad (null en transferencias sin precio)
  amount numeric not null,                  -- cantidad de tokens, siempre positiva
  total_value numeric,                      -- USD del trade (null en transferencias sin precio)
  fee numeric not null default 0,
  fee_currency text default 'USD',
  notes text,
  source text not null default 'manual',    -- manual | cmc
  dedupe_key text not null,                 -- ts|symbol|type|amount normalizado (ver inversiones.js)
  created_at timestamptz not null default now()
);

-- Un import repetido del mismo CSV no duplica: el insert choca contra este índice
-- y la app lo cuenta como "ya estaba". Por eso la clave incluye el portafolio.
create unique index if not exists inv_tx_sin_duplicados
  on public.inv_transactions (user_id, portfolio, dedupe_key);

create index if not exists inv_tx_por_fecha
  on public.inv_transactions (user_id, ts desc);

-- Saldo global de deuda: una sola fila por usuario.
create table if not exists public.inv_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt numeric not null default 0,          -- USD que se deben (positivo = deuda)
  debt_note text,
  updated_at timestamptz not null default now()
);

create unique index if not exists inv_settings_un_usuario
  on public.inv_settings (user_id);

-- Mapeo símbolo -> CoinGecko + precio manual para tokens que CoinGecko no lista.
create table if not exists public.inv_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol text not null,
  name text,
  coingecko_id text,                        -- null = todavía sin resolver
  manual_price numeric,                     -- si está, gana sobre CoinGecko
  hidden boolean not null default false,    -- ocultar de la vista (posiciones muertas)
  updated_at timestamptz not null default now()
);

create unique index if not exists inv_tokens_un_simbolo
  on public.inv_tokens (user_id, symbol);

alter table public.inv_transactions enable row level security;
alter table public.inv_settings enable row level security;
alter table public.inv_tokens enable row level security;

drop policy if exists "own rows" on public.inv_transactions;
create policy "own rows" on public.inv_transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.inv_settings;
create policy "own rows" on public.inv_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.inv_tokens;
create policy "own rows" on public.inv_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
