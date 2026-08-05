-- Schema de la app "Orden" — ejecutar en el SQL Editor de Supabase
-- Tablas: categories, subcategories, tasks, completions. RLS por user_id.

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  position int not null default 0,
  color int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.subcategories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  subcategory_id uuid not null references public.subcategories(id) on delete cascade,
  title text not null,
  description text,
  due_date date,
  due_time time,
  recurrence jsonb,          -- {"tipo": "diaria|semanal|quincenal|mensual|anual|dia_del_mes", "dia": n}
  next_due date,             -- próxima ocurrencia (solo recurrentes)
  done boolean not null default false,  -- solo no recurrentes
  created_at timestamptz not null default now()
);

create table if not exists public.completions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  title text not null,
  category_name text,
  subcategory_name text,
  occurrence_date date,
  completed_at timestamptz not null default now()
);

alter table public.categories enable row level security;
alter table public.subcategories enable row level security;
alter table public.tasks enable row level security;
alter table public.completions enable row level security;

drop policy if exists "own rows" on public.categories;
create policy "own rows" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.subcategories;
create policy "own rows" on public.subcategories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.tasks;
create policy "own rows" on public.tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on public.completions;
create policy "own rows" on public.completions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
