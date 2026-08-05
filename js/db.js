// Capa de datos: Supabase si hay config, si no modo local (localStorage).
// API uniforme: init, isRemote, getSession, signIn, signOut, fetchAll, insert, update, remove.

const LOCAL_KEY = "orden_local_db";
const CACHE_KEY = "orden_cache";
const TABLES = ["categories", "subcategories", "tasks", "completions"];

let supabase = null;
let session = null;

function hasConfig() {
  if (localStorage.getItem("orden_force_local")) return false; // override de desarrollo
  const c = window.APP_CONFIG || {};
  return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
}

export function isRemote() {
  return !!supabase;
}

export function getSession() {
  return session;
}

export async function init(onAuthChange) {
  if (!hasConfig()) return;
  const { createClient } = await import(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"
  );
  supabase = createClient(window.APP_CONFIG.SUPABASE_URL, window.APP_CONFIG.SUPABASE_ANON_KEY);
  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (onAuthChange) onAuthChange(s);
  });
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(traducirError(error.message));
  session = data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
  session = null;
}

function traducirError(msg) {
  if (/invalid login credentials/i.test(msg)) return "Email o contraseña incorrectos.";
  if (/email not confirmed/i.test(msg)) return "El email no está confirmado.";
  if (/network|fetch/i.test(msg)) return "Sin conexión. Intenta de nuevo.";
  return msg;
}

// ---------- Modo local ----------

function localDB() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupto: partir de cero */ }
  const empty = {};
  TABLES.forEach((t) => (empty[t] = []));
  return empty;
}

function saveLocal(db) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(db));
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// ---------- Cache de lectura (arranque instantáneo en modo remoto) ----------

export function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignorar */ }
  return null;
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) { /* storage lleno: no es crítico */ }
}

export function clearCache() {
  localStorage.removeItem(CACHE_KEY);
}

// ---------- Operaciones ----------

export async function fetchAll() {
  if (!supabase) {
    const db = localDB();
    return {
      categories: db.categories, subcategories: db.subcategories,
      tasks: db.tasks, completions: db.completions,
    };
  }
  const [cat, sub, tas, com] = await Promise.all([
    supabase.from("categories").select("*").order("position"),
    supabase.from("subcategories").select("*").order("position"),
    supabase.from("tasks").select("*").order("created_at"),
    supabase.from("completions").select("*").order("completed_at", { ascending: false }).limit(1000),
  ]);
  for (const r of [cat, sub, tas, com]) {
    if (r.error) throw new Error("Error cargando datos: " + r.error.message);
  }
  const data = { categories: cat.data, subcategories: sub.data, tasks: tas.data, completions: com.data };
  writeCache(data);
  return data;
}

export async function insert(table, row) {
  if (!supabase) {
    const db = localDB();
    const full = { id: uuid(), created_at: new Date().toISOString(), done: false, ...row };
    if (table === "completions" && !full.completed_at) full.completed_at = new Date().toISOString();
    db[table].push(full);
    saveLocal(db);
    return full;
  }
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error("No se pudo guardar: " + error.message);
  return data;
}

export async function update(table, id, patch) {
  if (!supabase) {
    const db = localDB();
    const row = db[table].find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    saveLocal(db);
    return row;
  }
  const { data, error } = await supabase.from(table).update(patch).eq("id", id).select().single();
  if (error) throw new Error("No se pudo actualizar: " + error.message);
  return data;
}

export async function remove(table, id) {
  if (!supabase) {
    const db = localDB();
    db[table] = db[table].filter((r) => r.id !== id);
    // cascada manual del modo local
    if (table === "categories") {
      const subIds = db.subcategories.filter((s) => s.category_id === id).map((s) => s.id);
      db.subcategories = db.subcategories.filter((s) => s.category_id !== id);
      db.tasks = db.tasks.filter((t) => !subIds.includes(t.subcategory_id));
    }
    if (table === "subcategories") {
      db.tasks = db.tasks.filter((t) => t.subcategory_id !== id);
    }
    saveLocal(db);
    return;
  }
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw new Error("No se pudo eliminar: " + error.message);
}

// Migración: si hay datos del modo local y la cuenta remota está vacía, los sube.
export async function migrateLocalToRemote() {
  if (!supabase) return false;
  const db = localDB();
  if (!db.categories.length && !db.tasks.length) return false;
  const remote = await fetchAll();
  if (remote.categories.length) return false; // la cuenta ya tiene datos: no pisar
  const idMap = {};
  for (const c of db.categories) {
    const { id, user_id, created_at, ...rest } = c;
    const nc = await insert("categories", rest);
    idMap[id] = nc.id;
  }
  for (const s of db.subcategories) {
    const { id, user_id, created_at, category_id, ...rest } = s;
    const ns = await insert("subcategories", { ...rest, category_id: idMap[category_id] });
    idMap[id] = ns.id;
  }
  for (const t of db.tasks) {
    const { id, user_id, created_at, subcategory_id, ...rest } = t;
    const nt = await insert("tasks", { ...rest, subcategory_id: idMap[subcategory_id] });
    idMap[id] = nt.id;
  }
  for (const c of db.completions) {
    const { id, user_id, task_id, ...rest } = c;
    await insert("completions", { ...rest, task_id: idMap[task_id] || null });
  }
  localStorage.removeItem(LOCAL_KEY);
  return true;
}
