-- Migración 2026-08-21 — impedir tareas duplicadas
-- Ejecutar en el SQL Editor de Supabase, paso por paso y EN ORDEN.
-- Motivo: un guardado lento hizo que taps repetidos en "Guardar" insertaran la
-- misma tarea 15 veces. El fix principal está en la app (un solo submit en vuelo);
-- este índice es la red de seguridad si dos requests llegan igual en paralelo.

-- PASO 1 (solo mira, no cambia nada): ¿qué duplicados hay hoy?
-- Duplicado = misma subcategoría + mismo título (ignorando mayúsculas y espacios),
-- entre tareas NO completadas.
select subcategory_id,
       lower(btrim(title)) as titulo_normalizado,
       count(*)            as copias,
       min(created_at)     as primera,
       max(created_at)     as ultima
from public.tasks
where done = false
group by subcategory_id, lower(btrim(title))
having count(*) > 1
order by copias desc;

-- PASO 2 (destructivo): borra las copias y deja la más antigua de cada grupo.
-- Correr SOLO si el paso 1 mostró filas y el resultado te parece correcto.
-- Las tareas ya realizadas (historial) no se tocan; las completions apuntan a
-- task_id con "on delete set null", así que el historial sobrevive al borrado.
delete from public.tasks t
using public.tasks keep
where t.done = false
  and keep.done = false
  and t.user_id = keep.user_id
  and t.subcategory_id = keep.subcategory_id
  and lower(btrim(t.title)) = lower(btrim(keep.title))
  and (keep.created_at < t.created_at
       or (keep.created_at = t.created_at and keep.id < t.id));

-- PASO 3: el candado. Falla si todavía quedan duplicados (volver al paso 2).
-- Parcial (where done = false) para que sí puedas volver a crear una tarea con el
-- mismo nombre después de haberla completado.
create unique index if not exists tasks_sin_duplicados
  on public.tasks (user_id, subcategory_id, lower(btrim(title)))
  where done = false;
