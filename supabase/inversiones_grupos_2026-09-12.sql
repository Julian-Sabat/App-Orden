-- Grupos de inversión: nombres propios para los portafolios que vienen del import.
-- Ejecutar en el SQL Editor de Supabase, después de inversiones_2026-09-11.sql.
--
-- El grupo de cada movimiento es la columna `portfolio` de inv_transactions, que sale
-- del nombre del archivo exportado ("Alts_transactions.csv" -> "Alts"). Renombrar eso
-- in-place rompería el próximo import (volvería a crear "Alts" como grupo aparte), así
-- que el nombre visible se guarda aparte, como un mapa clave -> etiqueta:
--   { "Alts": "Cripto especulativa", "Core": "Núcleo" }

alter table public.inv_settings
  add column if not exists portfolio_labels jsonb not null default '{}'::jsonb;
