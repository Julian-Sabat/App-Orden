-- Migración 2026-08-21 — impedir tareas duplicadas
-- Ejecutar en el SQL Editor de Supabase, PASO POR PASO Y EN ORDEN.
--
-- Motivo: un guardado lento hizo que taps repetidos en "Guardar" insertaran la
-- misma tarea 15 veces. El fix principal está en la app (un solo submit en vuelo);
-- este índice es la red de seguridad si dos requests llegan igual en paralelo.
--
-- Duplicado = misma subcategoría + mismo título + misma descripción + misma fecha
-- + misma hora, entre tareas NO completadas. La fecha entra a propósito: la misma
-- gestión hecha en días distintos son tareas distintas y deben poder convivir.
-- Título y descripción se comparan normalizados (sin mayúsculas, sin espacios
-- sobrantes); los NULL se aplanan con coalesce porque en un índice único de
-- Postgres dos NULL NO chocarían entre sí.

-- PASO 1 (solo mira, no cambia nada): ¿qué duplicados hay hoy?
-- Si no devuelve ninguna fila, saltear el paso 2 e ir directo al paso 3.
select subcategory_id,
       regexp_replace(btrim(lower(title)), '\s+', ' ', 'g')                    as titulo,
       coalesce(regexp_replace(btrim(lower(description)), '\s+', ' ', 'g'), '') as descripcion,
       due_date,
       due_time,
       count(*)        as copias,
       min(created_at) as primera,
       max(created_at) as ultima
from public.tasks
where done = false
group by subcategory_id,
         regexp_replace(btrim(lower(title)), '\s+', ' ', 'g'),
         coalesce(regexp_replace(btrim(lower(description)), '\s+', ' ', 'g'), ''),
         due_date,
         due_time
having count(*) > 1
order by copias desc;

-- PASO 2 (DESTRUCTIVO): borra las copias y deja la más antigua de cada grupo.
-- Correr SOLO si el paso 1 devolvió filas y el resultado te parece correcto.
-- Las tareas ya realizadas (historial) no se tocan; completions.task_id es
-- "on delete set null", así que el historial sobrevive al borrado.
delete from public.tasks t
using public.tasks keep
where t.done = false
  and keep.done = false
  and t.user_id = keep.user_id
  and t.subcategory_id = keep.subcategory_id
  and regexp_replace(btrim(lower(t.title)), '\s+', ' ', 'g')
    = regexp_replace(btrim(lower(keep.title)), '\s+', ' ', 'g')
  and coalesce(regexp_replace(btrim(lower(t.description)), '\s+', ' ', 'g'), '')
    = coalesce(regexp_replace(btrim(lower(keep.description)), '\s+', ' ', 'g'), '')
  and coalesce(t.due_date, date '0001-01-01') = coalesce(keep.due_date, date '0001-01-01')
  and coalesce(t.due_time, time '24:00:00')   = coalesce(keep.due_time, time '24:00:00')
  and (keep.created_at < t.created_at
       or (keep.created_at = t.created_at and keep.id < t.id));

-- PASO 3: el candado. Falla si todavía quedan duplicados (volver al paso 2).
-- Parcial (where done = false) para que sí puedas volver a crear una tarea
-- idéntica después de haber completado la anterior.
create unique index if not exists tasks_sin_duplicados
  on public.tasks (
    user_id,
    subcategory_id,
    regexp_replace(btrim(lower(title)), '\s+', ' ', 'g'),
    coalesce(regexp_replace(btrim(lower(description)), '\s+', ' ', 'g'), ''),
    coalesce(due_date, date '0001-01-01'),
    coalesce(due_time, time '24:00:00')
  )
  where done = false;

-- Si venías de la versión anterior de este archivo (índice solo por título),
-- borrarlo antes: drop index if exists public.tasks_sin_duplicados;
