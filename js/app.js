import * as DB from "./db.js";
import {
  todayStr, parseDate, advancePastToday, firstDayOfMonthOccurrence, describeRecurrence,
} from "./recurrence.js";

// ---------- Estado ----------
const S = {
  remote: false,
  session: null,
  loaded: false,
  categories: [],
  subcategories: [],
  tasks: [],
  completions: [],
  expandedTask: null,
  proxFilter: { cat: "", subs: [] },   // filtro: categoría + subcategorías (multi)
  todasFilter: { cat: "", subs: [] },
  histFilter: { cat: "", subs: [] },
  undo: null,
  undoTimer: null,
};

const PALETTE_N = 8;
const THEME_KEY = "orden_theme";
const THEME_CYCLE = { auto: "dark", dark: "light", light: "auto" };
const THEME_LABEL = { auto: "automático (según el sistema)", dark: "oscuro", light: "claro" };

function themePref() {
  const t = localStorage.getItem(THEME_KEY);
  return t === "dark" || t === "light" ? t : "auto";
}

function applyTheme() {
  const p = themePref();
  if (p === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p;
}

function themeIcon() {
  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const p = themePref();
  if (p === "dark") return svg('<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>');
  if (p === "light") return svg('<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4L19 19M19 5l-1.6 1.6M6.6 17.4L5 19"/>');
  return svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8.5"/>');
}
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

// ---------- Utilidades ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function addDaysStr(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtShort(dateStr) {
  const today = todayStr();
  if (dateStr === today) return "hoy";
  if (dateStr === addDaysStr(today, 1)) return "mañana";
  if (dateStr === addDaysStr(today, -1)) return "ayer";
  const d = parseDate(dateStr);
  const y = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${DIAS[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}${y}`;
}

function fmtTime(t) {
  return t ? t.slice(0, 5) : "";
}

function dueStatus(dateStr) {
  const today = todayStr();
  if (dateStr < today) return "overdue";
  if (dateStr === today) return "today";
  return "future";
}

// Fecha de la ocurrencia vigente de una tarea
function occDate(t) {
  return t.recurrence ? t.next_due : t.due_date;
}

// ¿Cuenta para el badge? (fecha llegó o pasó, pendiente)
function isDue(t) {
  if (t.recurrence) return t.next_due && t.next_due <= todayStr();
  return !t.done && t.due_date && t.due_date <= todayStr();
}

// ¿Se muestra en listas de pendientes?
function isActive(t) {
  return t.recurrence ? true : !t.done;
}

function subBadge(subId) {
  return S.tasks.filter((t) => t.subcategory_id === subId && isDue(t)).length;
}

function catBadge(catId) {
  return S.subcategories
    .filter((s) => s.category_id === catId)
    .reduce((n, s) => n + subBadge(s.id), 0);
}

function sortByPosition(arr) {
  return [...arr].sort((a, b) => (a.position - b.position) || (a.created_at < b.created_at ? -1 : 1));
}

// ---------- Datos ----------
async function refreshData() {
  try {
    const data = await DB.fetchAll();
    Object.assign(S, data);
    S.loaded = true;
  } catch (e) {
    showToast("⚠️ " + e.message);
  }
  render();
}

function hydrateFromCache() {
  const c = DB.readCache();
  if (c) {
    Object.assign(S, c);
    S.loaded = true;
  }
}

// ---------- Render ----------
function route() {
  const h = location.hash || "#/";
  const parts = h.slice(2).split("/");
  if (parts[0] === "cat" && parts[1]) return { view: "cat", id: parts[1] };
  if (parts[0] === "sub" && parts[1]) return { view: "sub", id: parts[1] };
  if (parts[0] === "proximas") return { view: "proximas" };
  if (parts[0] === "todas") return { view: "todas" };
  if (parts[0] === "historial") return { view: "historial" };
  return { view: "home" };
}

function render() {
  const app = document.getElementById("app");
  if (S.remote && !S.session) {
    app.innerHTML = renderLogin();
    return;
  }
  if (!S.loaded) {
    app.innerHTML = `<div class="loading">Cargando…</div>`;
    return;
  }
  const r = route();
  let html = "";
  if (r.view === "home") html = renderHome();
  else if (r.view === "cat") html = renderCat(r.id);
  else if (r.view === "sub") html = renderSub(r.id);
  else if (r.view === "proximas") html = renderProximas();
  else if (r.view === "todas") html = renderTodas();
  else if (r.view === "historial") html = renderHistorial();
  app.innerHTML = html + renderNav(r.view);
}

function header(title, backHref, right = "") {
  return `<header class="topbar">
    ${backHref ? `<a class="back" href="${backHref}" aria-label="Volver">‹</a>` : `<span class="back-spacer"></span>`}
    <h1>${esc(title)}</h1>
    <div class="topbar-right">${right}</div>
  </header>`;
}

function renderNav(active) {
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const ICONS = {
    home: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
    proximas: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    todas: svg('<path d="M8.5 6h12M8.5 12h12M8.5 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
    historial: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>'),
  };
  const item = (href, view, label) =>
    `<a href="${href}" class="nav-item ${active === view ? "active" : ""}">
      <span class="nav-icon">${ICONS[view]}</span><span>${label}</span>
    </a>`;
  return `<nav class="bottomnav">
    ${item("#/", "home", "Categorías")}
    ${item("#/proximas", "proximas", "Próximas")}
    ${item("#/todas", "todas", "Todas")}
    ${item("#/historial", "historial", "Historial")}
  </nav>`;
}

function badgeHtml(n) {
  return n > 0 ? `<span class="badge">${n}</span>` : "";
}

// --- Login ---
function renderLogin() {
  return `<div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">✓</div>
      <h1>Orden</h1>
      <p class="muted">Inicia sesión para ver tus tareas</p>
      <form data-form="login">
        <input type="email" name="email" placeholder="Email" required autocomplete="email" />
        <input type="password" name="password" placeholder="Contraseña" required autocomplete="current-password" />
        <div class="form-error" id="login-error"></div>
        <button type="submit" class="btn-primary">Entrar</button>
      </form>
    </div>
  </div>`;
}

// --- Home: categorías ---
function renderHome() {
  const cats = sortByPosition(S.categories);
  const items = cats.map((c) => `
    <div class="card cat-card c${c.color % PALETTE_N}">
      <a class="card-main" href="#/cat/${c.id}">
        <span class="card-dot"></span>
        <span class="card-name">${esc(c.name)}</span>
        ${badgeHtml(catBadge(c.id))}
        <span class="chevron">›</span>
      </a>
      <button class="card-edit" data-action="edit-cat" data-id="${c.id}" aria-label="Editar">✎</button>
    </div>`).join("");
  const themeBtn = `<button class="icon-btn" data-action="toggle-theme" title="Tema: ${THEME_LABEL[themePref()]}">${themeIcon()}</button>`;
  const right = themeBtn + (S.remote
    ? `<button class="icon-btn" data-action="logout" title="Cerrar sesión">⏻</button>`
    : `<span class="local-chip" title="Datos solo en este dispositivo">local</span>`);
  return `${header("Orden", null, right)}
  <main class="content">
    ${items || `<p class="empty">Sin categorías todavía.<br>Crea la primera para empezar.</p>`}
    <button class="btn-add" data-action="new-cat">+ Nueva categoría</button>
  </main>
  <button class="fab" data-action="new-task-any" aria-label="Nueva tarea">
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
  </button>`;
}

// --- Subcategorías de una categoría ---
function renderCat(catId) {
  const cat = S.categories.find((c) => c.id === catId);
  if (!cat) return `${header("Orden", "#/")}<main class="content"><p class="empty">Categoría no encontrada.</p></main>`;
  const subs = sortByPosition(S.subcategories.filter((s) => s.category_id === catId));
  const items = subs.map((s) => `
    <div class="card c${cat.color % PALETTE_N}">
      <a class="card-main" href="#/sub/${s.id}">
        <span class="card-name">${esc(s.name)}</span>
        ${badgeHtml(subBadge(s.id))}
        <span class="chevron">›</span>
      </a>
      <button class="card-edit" data-action="edit-sub" data-id="${s.id}" aria-label="Editar">✎</button>
    </div>`).join("");
  return `${header(cat.name, "#/")}
  <main class="content">
    ${items || `<p class="empty">Sin subcategorías todavía.</p>`}
    <button class="btn-add" data-action="new-sub" data-cat="${catId}">+ Nueva subcategoría</button>
  </main>`;
}

// --- Tareas de una subcategoría ---
function renderSub(subId) {
  const sub = S.subcategories.find((s) => s.id === subId);
  if (!sub) return `${header("Orden", "#/")}<main class="content"><p class="empty">Subcategoría no encontrada.</p></main>`;
  const cat = S.categories.find((c) => c.id === sub.category_id);
  const tasks = S.tasks.filter((t) => t.subcategory_id === subId && isActive(t));

  const due = tasks.filter((t) => isDue(t)).sort((a, b) => (occDate(a) > occDate(b) ? 1 : -1));
  const noDate = tasks.filter((t) => !t.recurrence && !t.due_date);
  const future = tasks.filter((t) => occDate(t) && occDate(t) > todayStr())
    .sort((a, b) => (occDate(a) > occDate(b) ? 1 : -1));

  const section = (title, arr) => arr.length
    ? `<h2 class="section-title">${title}</h2>${arr.map((t) => taskRow(t, false)).join("")}`
    : "";

  return `${header(sub.name, `#/cat/${sub.category_id}`)}
  <main class="content c${(cat?.color ?? 0) % PALETTE_N}">
    ${section("Para hoy y atrasadas", due)}
    ${section("Sin fecha", noDate)}
    ${section("Próximas", future)}
    ${!tasks.length ? `<p class="empty">Sin tareas pendientes.</p>` : ""}
    <button class="btn-add" data-action="new-task" data-sub="${subId}">+ Nueva tarea</button>
  </main>`;
}

function taskRow(t, withCrumb) {
  const d = occDate(t);
  const expanded = S.expandedTask === t.id;
  const status = d ? dueStatus(d) : "";
  const completedWaiting = t.recurrence && d && d > todayStr();
  const chips = [];
  if (d) {
    chips.push(`<span class="chip chip-${status}">${completedWaiting ? "próxima: " : ""}${fmtShort(d)}${t.due_time ? " · " + fmtTime(t.due_time) : ""}</span>`);
  }
  if (t.recurrence) chips.push(`<span class="chip chip-rec">↻ ${describeRecurrence(t.recurrence)}</span>`);
  const crumb = withCrumb ? crumbOf(t) : "";
  return `<div class="task ${expanded ? "expanded" : ""}">
    <button class="check" data-action="complete" data-id="${t.id}" aria-label="Marcar realizada"></button>
    <div class="task-body" data-action="expand" data-id="${t.id}">
      <div class="task-title">${esc(t.title)}</div>
      ${crumb}
      ${chips.length ? `<div class="task-meta">${chips.join("")}</div>` : ""}
      ${expanded ? `
        ${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ""}
        <div class="task-actions">
          <button class="btn-small" data-action="edit-task" data-id="${t.id}">Editar</button>
          <button class="btn-small btn-danger" data-action="del-task" data-id="${t.id}">Eliminar</button>
        </div>` : ""}
    </div>
  </div>`;
}

function crumbOf(t) {
  const sub = S.subcategories.find((s) => s.id === t.subcategory_id);
  const cat = sub ? S.categories.find((c) => c.id === sub.category_id) : null;
  if (!sub) return "";
  return `<div class="crumb">${esc(cat?.name || "")} › ${esc(sub.name)}</div>`;
}

// --- Vista Próximas ---
function renderProximas() {
  const today = todayStr();
  let items = applyFilter(S.tasks.filter((t) => isActive(t) && occDate(t)), S.proxFilter);
  items.sort((a, b) => {
    const da = occDate(a), db = occDate(b);
    if (da !== db) return da < db ? -1 : 1;
    return (a.due_time || "99") < (b.due_time || "99") ? -1 : 1;
  });

  const groups = [
    { title: "Atrasadas", test: (d) => d < today },
    { title: "Hoy", test: (d) => d === today },
    { title: "Mañana", test: (d) => d === addDaysStr(today, 1) },
    { title: "Próximos 7 días", test: (d) => d > addDaysStr(today, 1) && d <= addDaysStr(today, 7) },
    { title: "Más adelante", test: (d) => d > addDaysStr(today, 7) },
  ];
  const body = groups.map((g) => {
    const arr = items.filter((t) => g.test(occDate(t)));
    return arr.length ? `<h2 class="section-title">${g.title}</h2>${arr.map((t) => taskRow(t, true)).join("")}` : "";
  }).join("");

  return `${header("Próximas", null)}
  <main class="content">
    ${filterBar("prox", S.proxFilter)}
    ${body || `<p class="empty">No hay tareas con fecha${S.proxFilter.cat ? " en este filtro" : ""}.</p>`}
  </main>`;
}

// --- Vista Todas (todas las tareas, con o sin fecha) ---
function renderTodas() {
  const items = applyFilter(S.tasks.filter(isActive), S.todasFilter);
  const sortKey = (t) => {
    const d = occDate(t);
    if (!d) return "1|";                       // sin fecha, al medio
    return (d <= todayStr() ? "0|" : "2|") + d; // vencidas/hoy primero, futuras al final
  };
  const body = sortByPosition(S.categories).map((c) => {
    const subs = sortByPosition(S.subcategories.filter((s) => s.category_id === c.id));
    return subs.map((s) => {
      const arr = items.filter((t) => t.subcategory_id === s.id)
        .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
      if (!arr.length) return "";
      return `<h2 class="section-title">${esc(c.name)} › ${esc(s.name)}</h2>
        <div class="c${c.color % PALETTE_N}">${arr.map((t) => taskRow(t, false)).join("")}</div>`;
    }).join("");
  }).join("");

  return `${header("Todas", null)}
  <main class="content">
    ${filterBar("todas", S.todasFilter)}
    ${body || `<p class="empty">No hay tareas${S.todasFilter.cat ? " en este filtro" : " todavía"}.</p>`}
  </main>`;
}

// Barra de filtro con categoría + subcategorías multi-selección (Próximas, Todas e Historial)
function filterBar(kind, f) {
  const cats = sortByPosition(S.categories);
  const chip = (action, id, label, active, colorCls, extra = "") =>
    `<button class="fchip ${active ? "active" : ""} ${colorCls || ""} ${extra}" data-action="${action}" data-id="${id}">${esc(label)}</button>`;
  let html = `<div class="fchips">
    ${chip(`filter-${kind}`, "", "Todas", !f.cat)}
    ${cats.map((c) => chip(`filter-${kind}`, c.id, c.name, f.cat === c.id, `c${c.color % PALETTE_N}`)).join("")}
  </div>`;
  if (f.cat) {
    const cat = S.categories.find((c) => c.id === f.cat);
    const subs = sortByPosition(S.subcategories.filter((s) => s.category_id === f.cat));
    if (subs.length) {
      html += `<div class="fchips fchips-sub">
        ${subs.map((s) => chip(`filter-${kind}-sub`, s.id, s.name, f.subs.includes(s.id), `c${(cat?.color ?? 0) % PALETTE_N}`, "fchip-sm")).join("")}
      </div>`;
    }
  }
  return html;
}

// Aplica el filtro {cat, subs} a una lista de tareas
function applyFilter(tasks, f) {
  if (!f.cat) return tasks;
  if (f.subs.length) return tasks.filter((t) => f.subs.includes(t.subcategory_id));
  const subIds = S.subcategories.filter((s) => s.category_id === f.cat).map((s) => s.id);
  return tasks.filter((t) => subIds.includes(t.subcategory_id));
}

// --- Historial ---
function renderHistorial() {
  let comps = [...S.completions].sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));
  // el historial guarda nombres (snapshot), así que se filtra por nombre
  const f = S.histFilter;
  if (f.cat) {
    const cat = S.categories.find((c) => c.id === f.cat);
    if (cat) comps = comps.filter((c) => c.category_name === cat.name);
    if (f.subs.length) {
      const subNames = S.subcategories.filter((s) => f.subs.includes(s.id)).map((s) => s.name);
      comps = comps.filter((c) => subNames.includes(c.subcategory_name));
    }
  }
  const groups = {};
  for (const c of comps) {
    const d = new Date(c.completed_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    (groups[key] ||= []).push(c);
  }
  const body = Object.keys(groups).map((day) => `
    <h2 class="section-title">${fmtShort(day)}</h2>
    ${groups[day].map((c) => {
      const time = new Date(c.completed_at);
      const hh = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
      return `<div class="task done-row">
        <span class="check checked">✓</span>
        <div class="task-body">
          <div class="task-title">${esc(c.title)}</div>
          <div class="crumb">${esc(c.category_name || "")}${c.subcategory_name ? " › " + esc(c.subcategory_name) : ""} · ${hh}</div>
        </div>
        <button class="comp-del" data-action="del-comp" data-id="${c.id}" aria-label="Borrar registro">✕</button>
      </div>`;
    }).join("")}`).join("");

  return `${header("Historial", null)}
  <main class="content">
    ${filterBar("hist", S.histFilter)}
    ${body || `<p class="empty">Aún no hay tareas realizadas${S.histFilter.cat ? " en este filtro" : ""}.</p>`}
  </main>`;
}

// ---------- Modales ----------
function openModal(html) {
  const m = document.getElementById("modal");
  m.innerHTML = `<div class="modal-backdrop" data-action="close-modal"></div><div class="modal-card">${html}</div>`;
  m.classList.add("open");
  const first = m.querySelector("input,textarea,select");
  if (first) setTimeout(() => first.focus(), 50);
}

function closeModal() {
  const m = document.getElementById("modal");
  m.classList.remove("open");
  m.innerHTML = "";
}

function catModal(cat) {
  openModal(`<h2>${cat ? "Editar categoría" : "Nueva categoría"}</h2>
  <form data-form="save-cat" data-id="${cat?.id || ""}">
    <input name="name" placeholder="Nombre" required value="${esc(cat?.name || "")}" />
    <div class="modal-actions">
      ${cat ? `
        <button type="button" class="btn-small" data-action="move-cat" data-id="${cat.id}" data-dir="-1">↑ Subir</button>
        <button type="button" class="btn-small" data-action="move-cat" data-id="${cat.id}" data-dir="1">↓ Bajar</button>
        <button type="button" class="btn-small btn-danger" data-action="del-cat" data-id="${cat.id}">Eliminar</button>` : ""}
      <button type="submit" class="btn-primary">Guardar</button>
    </div>
  </form>`);
}

function subModal(sub, catId) {
  openModal(`<h2>${sub ? "Editar subcategoría" : "Nueva subcategoría"}</h2>
  <form data-form="save-sub" data-id="${sub?.id || ""}" data-cat="${sub?.category_id || catId}">
    <input name="name" placeholder="Nombre" required value="${esc(sub?.name || "")}" />
    <div class="modal-actions">
      ${sub ? `
        <button type="button" class="btn-small" data-action="move-sub" data-id="${sub.id}" data-dir="-1">↑ Subir</button>
        <button type="button" class="btn-small" data-action="move-sub" data-id="${sub.id}" data-dir="1">↓ Bajar</button>
        <button type="button" class="btn-small btn-danger" data-action="del-sub" data-id="${sub.id}">Eliminar</button>` : ""}
      <button type="submit" class="btn-primary">Guardar</button>
    </div>
  </form>`);
}

function taskModal(task, subId) {
  const rec = task?.recurrence;
  const dateVal = task ? (rec ? task.next_due : task.due_date) || "" : "";
  const opt = (v, label) => `<option value="${v}" ${rec?.tipo === v ? "selected" : ""}>${label}</option>`;
  const needsPicker = !task && !subId;
  const subPicker = needsPicker ? `
    <label>Subcategoría
      <select name="subcat" required>
        <option value="">Elegir…</option>
        ${sortByPosition(S.categories).map((c) => `
          <optgroup label="${esc(c.name)}">
            ${sortByPosition(S.subcategories.filter((s) => s.category_id === c.id))
              .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
          </optgroup>`).join("")}
      </select>
    </label>` : "";
  openModal(`<h2>${task ? "Editar tarea" : "Nueva tarea"}</h2>
  <form data-form="save-task" data-id="${task?.id || ""}" data-sub="${task?.subcategory_id || subId || ""}">
    <input name="title" placeholder="Título" required value="${esc(task?.title || "")}" />
    ${subPicker}
    <textarea name="description" placeholder="Descripción (opcional)" rows="3">${esc(task?.description || "")}</textarea>
    <div class="form-row">
      <label>Fecha <input type="date" name="date" value="${dateVal}" /></label>
      <label>Hora <input type="time" name="time" value="${task?.due_time ? task.due_time.slice(0, 5) : ""}" /></label>
    </div>
    <label>Repetir
      <select name="repeat" data-action-change="toggle-dia">
        <option value="">No se repite</option>
        ${opt("diaria", "Cada día")}
        ${opt("semanal", "Cada semana")}
        ${opt("quincenal", "Cada 15 días")}
        ${opt("mensual", "Cada mes")}
        ${opt("trimestral", "Cada 3 meses")}
        ${opt("anual", "Cada año")}
        ${opt("dia_del_mes", "Día específico del mes")}
      </select>
    </label>
    <label id="dia-row" style="display:${rec?.tipo === "dia_del_mes" ? "block" : "none"}">Día del mes (1–31)
      <input type="number" name="dia" min="1" max="31" value="${rec?.dia || ""}" />
    </label>
    <p class="hint" id="rec-hint" style="display:none">Las tareas que se repiten necesitan una fecha; si no eliges una, se usa la más cercana.</p>
    <div class="modal-actions">
      <button type="submit" class="btn-primary">Guardar</button>
    </div>
  </form>`);
}

// ---------- Acciones ----------
async function completeTask(id) {
  const t = S.tasks.find((x) => x.id === id);
  if (!t) return;
  const sub = S.subcategories.find((s) => s.id === t.subcategory_id);
  const cat = sub ? S.categories.find((c) => c.id === sub.category_id) : null;
  const prevPatch = t.recurrence ? { next_due: t.next_due } : { done: t.done };
  try {
    if (t.recurrence) {
      const base = t.next_due || t.due_date || todayStr();
      const next = advancePastToday(base, t.recurrence, todayStr());
      await DB.update("tasks", id, { next_due: next });
    } else {
      await DB.update("tasks", id, { done: true });
    }
    const comp = await DB.insert("completions", {
      task_id: id,
      title: t.title,
      category_name: cat?.name || null,
      subcategory_name: sub?.name || null,
      occurrence_date: occDate(t) || null,
    });
    S.undo = { taskId: id, prevPatch, completionId: comp.id };
    showToast("Tarea realizada ✓", "Deshacer", undoComplete);
    await refreshData();
  } catch (e) {
    showToast("⚠️ " + e.message);
  }
}

async function undoComplete() {
  const u = S.undo;
  if (!u) return;
  S.undo = null;
  try {
    await DB.update("tasks", u.taskId, u.prevPatch);
    await DB.remove("completions", u.completionId);
    await refreshData();
  } catch (e) {
    showToast("⚠️ " + e.message);
  }
}

function toggleSub(filter, subId) {
  const i = filter.subs.indexOf(subId);
  if (i >= 0) filter.subs.splice(i, 1);
  else filter.subs.push(subId);
}

let moveInFlight = false;

async function moveItem(table, id, dir) {
  if (moveInFlight) return; // ignorar clics mientras se guarda el movimiento anterior
  moveInFlight = true;
  try {
    await doMove(table, id, dir);
  } finally {
    moveInFlight = false;
  }
}

async function doMove(table, id, dir) {
  const all = table === "categories"
    ? sortByPosition(S.categories)
    : sortByPosition(S.subcategories.filter(
        (s) => s.category_id === S.subcategories.find((x) => x.id === id)?.category_id
      ));
  const idx = all.findIndex((x) => x.id === id);
  const other = all[idx + dir];
  if (!other) return;
  // normalizar posiciones para que el swap sea estable
  const posA = idx, posB = idx + dir;
  await DB.update(table, all[idx].id, { position: posB });
  await DB.update(table, other.id, { position: posA });
  const rest = all.filter((_, i) => i !== idx && i !== idx + dir);
  for (const [i, row] of all.entries()) {
    if (rest.includes(row) && row.position !== i) await DB.update(table, row.id, { position: i });
  }
  await refreshData();
}

function showToast(msg, actionLabel, actionFn) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button id="toast-action">${esc(actionLabel)}</button>` : ""}`;
  el.classList.add("show");
  if (actionLabel) {
    document.getElementById("toast-action").onclick = () => {
      el.classList.remove("show");
      actionFn();
    };
  }
  clearTimeout(S.undoTimer);
  S.undoTimer = setTimeout(() => el.classList.remove("show"), 5000);
}

// ---------- Eventos ----------
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;

  if (a === "close-modal") return closeModal();
  if (a === "toggle-theme") {
    localStorage.setItem(THEME_KEY, THEME_CYCLE[themePref()]);
    applyTheme();
    showToast("Tema: " + THEME_LABEL[themePref()]);
    return render();
  }
  if (a === "logout") {
    if (confirm("¿Cerrar sesión?")) { DB.clearCache(); await DB.signOut(); render(); }
    return;
  }
  if (a === "expand") {
    S.expandedTask = S.expandedTask === id ? null : id;
    return render();
  }
  if (a === "complete") return completeTask(id);

  if (a === "new-cat") return catModal(null);
  if (a === "edit-cat") return catModal(S.categories.find((c) => c.id === id));
  if (a === "new-sub") return subModal(null, el.dataset.cat);
  if (a === "edit-sub") return subModal(S.subcategories.find((s) => s.id === id));
  if (a === "new-task") return taskModal(null, el.dataset.sub);
  if (a === "new-task-any") {
    if (!S.subcategories.length) return showToast("Crea primero una categoría con una subcategoría");
    return taskModal(null, null);
  }
  if (a === "edit-task") return taskModal(S.tasks.find((t) => t.id === id));

  if (a === "del-cat") {
    const c = S.categories.find((x) => x.id === id);
    if (confirm(`¿Eliminar "${c.name}"? Se eliminarán también sus subcategorías y tareas.`)) {
      closeModal();
      try { await DB.remove("categories", id); } catch (err) { showToast("⚠️ " + err.message); }
      location.hash = "#/";
      await refreshData();
    }
    return;
  }
  if (a === "del-sub") {
    const s = S.subcategories.find((x) => x.id === id);
    if (confirm(`¿Eliminar "${s.name}"? Se eliminarán también sus tareas.`)) {
      closeModal();
      const catId = s.category_id;
      try { await DB.remove("subcategories", id); } catch (err) { showToast("⚠️ " + err.message); }
      location.hash = `#/cat/${catId}`;
      await refreshData();
    }
    return;
  }
  if (a === "del-task") {
    const t = S.tasks.find((x) => x.id === id);
    if (confirm(`¿Eliminar la tarea "${t.title}"?`)) {
      try { await DB.remove("tasks", id); } catch (err) { showToast("⚠️ " + err.message); }
      await refreshData();
    }
    return;
  }

  // mover sin cerrar el modal: se puede apretar varias veces seguidas
  if (a === "move-cat") return moveItem("categories", id, Number(el.dataset.dir));
  if (a === "move-sub") return moveItem("subcategories", id, Number(el.dataset.dir));

  if (a === "del-comp") {
    if (confirm("¿Borrar este registro del historial?")) {
      try { await DB.remove("completions", id); } catch (err) { showToast("⚠️ " + err.message); }
      await refreshData();
    }
    return;
  }

  if (a === "filter-prox") { S.proxFilter = { cat: id, subs: [] }; return render(); }
  if (a === "filter-prox-sub") { toggleSub(S.proxFilter, id); return render(); }
  if (a === "filter-todas") { S.todasFilter = { cat: id, subs: [] }; return render(); }
  if (a === "filter-todas-sub") { toggleSub(S.todasFilter, id); return render(); }
  if (a === "filter-hist") { S.histFilter = { cat: id, subs: [] }; return render(); }
  if (a === "filter-hist-sub") { toggleSub(S.histFilter, id); return render(); }
});

document.addEventListener("change", (e) => {
  if (e.target.matches('select[name="repeat"]')) {
    const form = e.target.closest("form");
    form.querySelector("#dia-row").style.display = e.target.value === "dia_del_mes" ? "block" : "none";
    form.querySelector("#rec-hint").style.display = e.target.value ? "block" : "none";
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const fd = new FormData(form);

  try {
    if (kind === "login") {
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Entrando…";
      try {
        await DB.signIn(fd.get("email").trim(), fd.get("password"));
        const migrated = await DB.migrateLocalToRemote();
        if (migrated) showToast("Datos locales migrados a tu cuenta ✓");
        await refreshData();
      } catch (err) {
        document.getElementById("login-error").textContent = err.message;
        btn.disabled = false; btn.textContent = "Entrar";
      }
      return;
    }

    if (kind === "save-cat") {
      const name = fd.get("name").trim();
      if (!name) return;
      if (form.dataset.id) {
        await DB.update("categories", form.dataset.id, { name });
      } else {
        await DB.insert("categories", {
          name,
          position: S.categories.length,
          color: S.categories.length % PALETTE_N,
        });
      }
      closeModal();
      return refreshData();
    }

    if (kind === "save-sub") {
      const name = fd.get("name").trim();
      if (!name) return;
      if (form.dataset.id) {
        await DB.update("subcategories", form.dataset.id, { name });
      } else {
        const catId = form.dataset.cat;
        await DB.insert("subcategories", {
          name,
          category_id: catId,
          position: S.subcategories.filter((s) => s.category_id === catId).length,
        });
      }
      closeModal();
      return refreshData();
    }

    if (kind === "save-task") {
      const title = fd.get("title").trim();
      if (!title) return;
      const repeat = fd.get("repeat");
      let date = fd.get("date") || null;
      const time = fd.get("time") || null;
      let recurrence = null;
      let next_due = null;

      if (repeat) {
        if (repeat === "dia_del_mes") {
          const dia = Math.min(31, Math.max(1, Number(fd.get("dia") || 1)));
          recurrence = { tipo: "dia_del_mes", dia };
          date = date || firstDayOfMonthOccurrence(dia, todayStr());
        } else {
          date = date || todayStr();
          recurrence = { tipo: repeat };
          if (["mensual", "trimestral", "anual"].includes(repeat)) {
            recurrence.dia_ancla = Number(date.split("-")[2]);
          }
        }
        next_due = date;
      }

      const patch = {
        title,
        description: fd.get("description").trim() || null,
        due_date: date,
        due_time: time,
        recurrence,
        next_due,
        done: false,
      };
      if (form.dataset.id) {
        await DB.update("tasks", form.dataset.id, patch);
      } else {
        const targetSub = form.dataset.sub || fd.get("subcat");
        if (!targetSub) return;
        await DB.insert("tasks", { ...patch, subcategory_id: targetSub });
      }
      closeModal();
      return refreshData();
    }
  } catch (err) {
    showToast("⚠️ " + err.message);
  }
});

// En PC: la rueda del mouse desplaza horizontalmente las filas de chips
document.addEventListener("wheel", (e) => {
  const row = e.target.closest(".fchips");
  if (row && row.scrollWidth > row.clientWidth && !e.deltaX && e.deltaY) {
    row.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

window.addEventListener("hashchange", () => {
  S.expandedTask = null;
  render();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.remote && S.session && S.loaded) {
    refreshData();
  }
});

// ---------- Arranque ----------
async function main() {
  applyTheme();
  render(); // "Cargando…"
  try {
    await DB.init((s) => { S.session = s; if (!s) render(); });
  } catch (e) {
    showToast("⚠️ No se pudo conectar: " + e.message);
  }
  S.remote = DB.isRemote();
  S.session = DB.getSession();
  if (S.remote && S.session) hydrateFromCache();
  render();
  if (!S.remote || S.session) await refreshData();
}

main();
