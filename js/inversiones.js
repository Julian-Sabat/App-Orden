// Sección Inversiones: portafolio cripto, trades y deuda.
//
// La data del portafolio NO pasa por ningún intermediario: el CSV exportado de
// CoinMarketCap se parsea en este archivo (en el dispositivo) y va directo a
// Supabase; los precios se piden desde acá a la API pública de CoinGecko.
//
// Base de costo: promedio móvil. Cada venta descuenta costo al promedio vigente,
// así realizado + no realizado = PnL real. Ojo al comparar con CoinMarketCap:
// CMC divide TODAS las compras históricas por TODAS las cantidades compradas, sin
// descontar lo ya vendido, así que su "Avg Buy Price" queda más alto en cualquier
// token que hayas vendido alguna vez (verificado contra el export: en ALVA CMC da
// 0.03740 y el promedio móvil 0.035813; en NEXO, sin ventas, ambos coinciden).
// Por eso la vista de detalle muestra los dos.

import * as DB from "./db.js";
import * as PXM from "./pionex.js";
import { exportarInversiones } from "./inv_export.js";

export const INV = {
  transactions: [],
  settings: null,
  tokens: [],
  prices: {},          // symbol -> { usd, change24h, change7d, change30d }
  loaded: false,
  loading: false,
  pricesAt: null,
  tab: "resumen",      // resumen | historial
  filterSymbol: "",
  filterPortfolio: "", // "" = todos los grupos
  expanded: null,      // símbolo con detalle abierto
  cerradasAbierto: false,   // la sección de cerradas arranca plegada
  botsCerradosAbierto: false,
};

let ctx = {};          // utilidades que presta app.js: render, showToast, openModal, closeModal

export function init(context) {
  ctx = context;
}

const EPS = 1e-8;
const PRIV_KEY = "orden_inv_privacy";
const PRICE_CACHE_KEY = "orden_inv_precios";
const PRICE_TTL_MS = 5 * 60 * 1000;
const CG = "https://api.coingecko.com/api/v3";

// ---------- Utilidades ----------

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function privacyOn() {
  return localStorage.getItem(PRIV_KEY) === "1";
}

export function togglePrivacy() {
  localStorage.setItem(PRIV_KEY, privacyOn() ? "0" : "1");
}

// Montos: con privacidad activa nunca se escriben en el DOM, se reemplazan antes
// de renderizar (no basta ocultarlos por CSS: quedarían en el HTML a la vista).
function money(v, dec = 2) {
  if (privacyOn()) return "••••";
  return fmtUSD(v, dec);
}

function fmtUSD(v, dec = 2) {
  if (v == null || !isFinite(v)) return "—";
  const neg = v < 0;
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (neg ? "-$" : "$") + s;
}

// Precios de tokens: los micro-caps necesitan muchos decimales para no verse como 0
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  if (v === 0) return "$0";
  const dec = v >= 1 ? 4 : v >= 0.01 ? 5 : v >= 0.0001 ? 7 : 9;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: dec });
}

function fmtQty(v) {
  if (privacyOn()) return "••••";
  if (v == null || !isFinite(v)) return "—";
  const dec = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dec });
}

function fmtPct(v) {
  if (v == null || !isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

// En las tres columnas de cambio no entra "+1266.52%": un decimal alcanza.
function fmtPctCorto(v) {
  if (v == null || !isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

function fmtFecha(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${d.getDate()} ${MESES[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
}

const TIPO_LABEL = { buy: "Compra", sell: "Venta", transferIn: "Entrada", transferOut: "Salida" };

// ---------- Carga ----------

export async function load(force) {
  if (INV.loaded && !force) return;
  INV.loading = true;
  try {
    const data = await DB.fetchInv();
    INV.transactions = data.inv_transactions;
    INV.tokens = data.inv_tokens;
    INV.settings = data.inv_settings[0] || null;
    INV.loaded = true;
    readPriceCache();
    PXM.leerCache();
  } catch (e) {
    ctx.showToast("⚠️ " + e.message);
  } finally {
    INV.loading = false;
  }
}

// ---------- Posiciones ----------

export const SIN_GRUPO = "Sin clasificar";
// Clave interna del grupo Pionex: no puede chocar con un portafolio de CMC que se llame "Pionex".
export const PIONEX = "__pionex__";

function pionexActivo() {
  return PXM.PX.disponible !== false && !!PXM.PX.data;
}

export function borrarCachePionex() {
  PXM.borrarCache();
}

// Al entrar a la sección: Pionex primero (puede traer monedas nuevas), después precios.
export async function refrescarSiViejo() {
  let cambio = false;
  if (PXM.PX.disponible !== false && !PXM.fresco()) { await PXM.refresh(); cambio = true; }
  if (!preciosFrescos() || faltanCambiosPionex()) { await refreshPrices(true); cambio = true; }
  return cambio;
}

// Un saldo de Pionex puede llegar después del último pedido a CoinGecko (cache de precios
// fresco de los tokens de CMC): sin esto, sus cambios 30d/7d/1d no aparecían hasta tocar ↻.
// Los ya buscados sin éxito en CoinGecko (coingecko_id null guardado) no fuerzan otro pedido.
function faltanCambiosPionex() {
  return positionsPionex().some((p) => {
    if (INV.prices[p.symbol]) return false;
    const tk = INV.tokens.find((t) => t.symbol === p.symbol);
    return !(tk && (tk.manual_price != null || tk.coingecko_id === null));
  });
}

// Clave de grupo de un movimiento. El import la toma del nombre del archivo.
export function grupoDe(tx) {
  return (tx.portfolio || "").trim() || SIN_GRUPO;
}

// Nombre visible de un grupo: el que el usuario le puso, o la clave tal cual.
export function labelGrupo(key) {
  const labels = INV.settings?.portfolio_labels || {};
  return labels[key] || (key === PIONEX ? "Pionex" : key);
}

// Grupos existentes, ordenados por valor de sus posiciones abiertas.
export function grupos() {
  const keys = [...new Set(INV.transactions.map(grupoDe))];
  if (pionexActivo()) keys.push(PIONEX);
  return keys
    .map((k) => ({ key: k, label: labelGrupo(k), valor: resumen(k).valor }))
    .sort((a, b) => b.valor - a.valor);
}

// Reconstruye la tenencia actual recorriendo las transacciones en orden cronológico.
// Con `pf`, solo las de ese grupo: cada grupo lleva su propia base de costo, igual
// que en CoinMarketCap, así el promedio de un token no se mezcla entre portafolios.
export function positions(pf) {
  const bySym = new Map();
  const base = pf ? INV.transactions.filter((t) => grupoDe(t) === pf) : INV.transactions;
  const orden = [...base].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  for (const t of orden) {
    const sym = t.symbol;
    let p = bySym.get(sym);
    if (!p) {
      p = { symbol: sym, name: t.name || null, qty: 0, cost: 0, realized: 0,
            buyQty: 0, buyCost: 0, nTx: 0, first: t.ts, last: t.ts, sinPrecio: 0 };
      bySym.set(sym, p);
    }
    p.nTx++;
    p.last = t.ts;
    if (t.name && !p.name) p.name = t.name;

    const qty = Number(t.amount) || 0;
    let total = t.total_value == null ? null : Number(t.total_value);
    if (total == null && t.price != null) total = Number(t.price) * qty;
    if (total == null) p.sinPrecio++;

    if (t.type === "buy" || t.type === "transferIn") {
      p.qty += qty;
      p.cost += total || 0;
      if (t.type === "buy") { p.buyQty += qty; p.buyCost += total || 0; }
    } else {
      // Venta/salida: descuenta al costo promedio vigente. Si se vende más de lo
      // registrado (dust del exchange), solo se descuenta lo que había.
      const avg = p.qty > EPS ? p.cost / p.qty : 0;
      const usado = Math.min(qty, Math.max(p.qty, 0));
      if (t.type === "sell") p.realized += (total || 0) - avg * usado;
      p.qty -= qty;
      p.cost -= avg * usado;
    }
  }

  const hidden = new Set(INV.tokens.filter((t) => t.hidden).map((t) => t.symbol));
  const out = [];
  for (const p of bySym.values()) {
    // El export de CoinMarketCap solo trae el ticker; el nombre largo lo aporta
    // CoinGecko al resolver el símbolo y queda guardado en inv_tokens.
    if (!p.name) p.name = INV.tokens.find((t) => t.symbol === p.symbol)?.name || null;
    if (Math.abs(p.qty) < 1e-6) { p.qty = 0; p.cost = 0; }   // cerrada (o dust negativo)
    p.avgCost = p.qty > EPS ? p.cost / p.qty : null;
    p.avgCMC = p.buyQty > 0 ? p.buyCost / p.buyQty : null;   // convención de CoinMarketCap
    const px = priceOf(p.symbol);
    p.price = px;
    p.value = px != null ? p.qty * px : null;
    p.unrealized = px != null && p.qty > EPS ? p.value - p.cost : 0;
    p.unrealizedPct = p.cost > EPS && px != null ? (p.unrealized / p.cost) * 100 : null;
    p.total = p.realized + p.unrealized;
    p.abierta = p.qty > EPS;
    p.hidden = hidden.has(p.symbol);
    out.push(p);
  }
  out.sort((a, b) => (b.value || 0) - (a.value || 0) || (b.qty - a.qty));
  return out;
}

// Saldos spot de Pionex con forma de posición. No hay base de costo: la API entrega
// saldos, no el historial de compras. Precio: el ticker de Pionex, y si no hay, CoinGecko.
// Los saldos de menos de US$1 (polvo del exchange) no se listan ni suman.
function positionsPionex() {
  const hidden = new Set(INV.tokens.filter((t) => t.hidden).map((t) => t.symbol));
  return PXM.saldos()
    .map(({ coin, qty }) => {
      const px = PXM.usdDe(coin) ?? priceOf(coin);
      const c = PXM.costoDe(coin);
      // El costo promedio sale de las órdenes, pero se aplica al saldo real: si la moneda
      // además entró por un bot o una transferencia, las órdenes no explican todo el saldo.
      const cost = c && c.avg != null ? c.avg * qty : 0;
      const value = px == null ? null : qty * px;
      return {
        key: "px:" + coin, symbol: coin, pionex: true, qty, price: px, value,
        name: INV.tokens.find((t) => t.symbol === coin)?.name || null,
        cost, avgCost: c ? c.avg : null, realized: c ? c.realized : 0, nTx: c ? c.nOrdenes : 0,
        parcial: !!c && Math.abs(c.qty - qty) > Math.max(1e-6, qty * 0.01),
        unrealized: value != null && cost > 0 ? value - cost : 0,
        unrealizedPct: value != null && cost > 0 ? ((value - cost) / cost) * 100 : null,
        abierta: true,
      };
    })
    .filter((p) => !hidden.has(p.symbol) && p.value != null && p.value >= 1)
    .sort((a, b) => b.value - a.value);
}

export function resumen(pf) {
  const debt = Number(INV.settings?.debt || 0);

  if (pf === PIONEX) {
    const pos = positionsPionex();
    const bots = PXM.resumenBots();
    const valorSpot = pos.reduce((s, p) => s + p.value, 0);
    const valor = valorSpot + bots.valor;
    const costo = pos.reduce((s, p) => s + p.cost, 0);
    const unrealized = pos.reduce((s, p) => s + p.unrealized, 0);
    const realized = pos.reduce((s, p) => s + p.realized, 0);
    return { pos, abiertas: pos, valor, valorSpot, bots, costo, realized, unrealized,
             sinPrecio: bots.sinPrecio, debt, neto: valor - debt, filtrado: true, pionex: true };
  }

  const pos = positions(pf);
  let abiertas = pos.filter((p) => p.abierta && !p.hidden);
  let costo = abiertas.reduce((s, p) => s + p.cost, 0);
  let realized = pos.reduce((s, p) => s + p.realized, 0);
  let unrealized = abiertas.reduce((s, p) => s + p.unrealized, 0);
  let sinPrecio = abiertas.filter((p) => p.price == null).length;
  let valor = abiertas.reduce((s, p) => s + (p.value || 0), 0);

  // "Todos" incluye Pionex: sus saldos como filas aparte (no se mezclan con la base de
  // costo de CMC) y el valor de los bots en el total. Costo y PnL siguen siendo de CMC.
  let px = null;
  if (!pf && pionexActivo()) {
    px = resumen(PIONEX);
    abiertas = [...abiertas, ...px.pos].sort((a, b) => (b.value || 0) - (a.value || 0));
    valor += px.valor;
    sinPrecio += px.sinPrecio;
    costo += px.costo;              // el costo de los saldos spot de Pionex sí se conoce
    unrealized += px.unrealized;
    realized += px.realized;
  }
  // Con un grupo filtrado el neto no tiene sentido: la deuda es global, no del grupo.
  return { pos, abiertas, valor, costo, realized, unrealized, sinPrecio, debt,
           neto: valor - debt, filtrado: !!pf, px };
}

// ---------- Precios (CoinGecko, desde el dispositivo) ----------

function priceOf(symbol) {
  const tk = INV.tokens.find((t) => t.symbol === symbol);
  if (tk && tk.manual_price != null) return Number(tk.manual_price);
  const p = INV.prices[symbol];
  return p ? p.usd : null;
}

function readPriceCache() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    INV.prices = c.prices || {};
    INV.pricesAt = c.at || null;
  } catch (e) { /* cache corrupto: se repuebla al refrescar */ }
}

function writePriceCache() {
  try {
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ prices: INV.prices, at: INV.pricesAt }));
  } catch (e) { /* storage lleno: no es crítico */ }
}

export function preciosFrescos() {
  return INV.pricesAt && Date.now() - INV.pricesAt < PRICE_TTL_MS;
}

// Busca el id de CoinGecko de un símbolo. /search devuelve poco y es barato; se
// prefiere el coin con mejor market cap rank entre los que matchean el símbolo exacto.
async function resolverId(symbol) {
  const r = await fetch(`${CG}/search?query=${encodeURIComponent(symbol)}`);
  if (!r.ok) throw new Error(`CoinGecko respondió ${r.status}`);
  const j = await r.json();
  const cands = (j.coins || []).filter((c) => (c.symbol || "").toUpperCase() === symbol.toUpperCase());
  if (!cands.length) return null;
  cands.sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  return { id: cands[0].id, name: cands[0].name };
}

export async function refreshPrices(silencioso) {
  const abiertas = positions().filter((p) => p.abierta && !p.hidden);   // todos los grupos
  const pend = [];
  for (const p of abiertas) {
    const tk = INV.tokens.find((t) => t.symbol === p.symbol);
    if (tk && tk.manual_price != null) continue;          // precio fijado a mano
    if (tk && tk.coingecko_id) { pend.push({ sym: p.symbol, id: tk.coingecko_id }); continue; }
    pend.push({ sym: p.symbol, id: null, name: p.name });
  }
  // Saldos de Pionex: el precio ya viene del exchange, pero CoinGecko aporta los
  // cambios 30d/7d/1d de la fila. Solo los que valen algo, para no gastar /search en polvo.
  const yaEsta = new Set(pend.map((x) => x.sym));
  for (const p of positionsPionex()) {
    if (yaEsta.has(p.symbol)) continue;
    const tk = INV.tokens.find((t) => t.symbol === p.symbol);
    if (tk && tk.manual_price != null) continue;
    pend.push({ sym: p.symbol, id: tk?.coingecko_id || null, name: p.name });
  }

  // 1) resolver los símbolos que todavía no tienen id (una vez por símbolo)
  const sinResolver = pend.filter((x) => !x.id);
  for (const x of sinResolver) {
    try {
      const hit = await resolverId(x.sym);
      if (hit) {
        x.id = hit.id;
        await guardarToken(x.sym, { coingecko_id: hit.id, name: hit.name });
      } else {
        await guardarToken(x.sym, { coingecko_id: null });
      }
    } catch (e) {
      if (!silencioso) ctx.showToast("⚠️ " + e.message);
      break;   // rate limit o sin red: no seguir martillando
    }
  }

  // 2) un solo request con todos los ids. /coins/markets en vez de /simple/price
  // porque este trae los tres cambios (24h, 7d, 30d) sin pedir llamadas extra.
  const ids = [...new Set(pend.filter((x) => x.id).map((x) => x.id))];
  if (!ids.length) { INV.pricesAt = Date.now(); writePriceCache(); return; }
  try {
    const url = `${CG}/coins/markets?vs_currency=usd&per_page=250` +
                `&ids=${ids.map(encodeURIComponent).join(",")}` +
                `&price_change_percentage=24h,7d,30d`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`CoinGecko respondió ${r.status}`);
    const arr = await r.json();
    const porId = new Map((Array.isArray(arr) ? arr : []).map((c) => [c.id, c]));
    for (const x of pend) {
      const c = x.id ? porId.get(x.id) : null;
      if (!c) continue;
      // Al pedir price_change_percentage, los campos llegan con sufijo _in_currency;
      // el de 24h existe además sin sufijo, y sirve de respaldo.
      INV.prices[x.sym] = {
        usd: c.current_price,
        change24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
        change7d: c.price_change_percentage_7d_in_currency ?? null,
        change30d: c.price_change_percentage_30d_in_currency ?? null,
      };
    }
    INV.pricesAt = Date.now();
    writePriceCache();
  } catch (e) {
    if (!silencioso) ctx.showToast("⚠️ No se pudieron traer precios: " + e.message);
  }
}

// inv_settings tiene una fila por usuario, que puede no existir todavía.
async function guardarSettings(patch) {
  if (INV.settings) {
    const row = await DB.update("inv_settings", INV.settings.id, { ...patch, updated_at: new Date().toISOString() });
    INV.settings = row || { ...INV.settings, ...patch };
  } else {
    INV.settings = await DB.insert("inv_settings", patch);
  }
  return INV.settings;
}

async function guardarToken(symbol, patch) {
  const ex = INV.tokens.find((t) => t.symbol === symbol);
  if (ex) {
    const row = await DB.update("inv_tokens", ex.id, { ...patch, updated_at: new Date().toISOString() });
    Object.assign(ex, row || patch);
  } else {
    const row = await DB.insert("inv_tokens", { symbol, ...patch });
    INV.tokens.push(row);
  }
}

// ---------- CSV ----------

// Parser de CSV con comillas dobles y comas dentro de los campos (el export de
// CoinMarketCap trae "1,283.02"). Devuelve array de filas, cada una array de celdas.
export function parseCSV(text) {
  const filas = [];
  let fila = [], campo = "", enComillas = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (enComillas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; }
        else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((c) => c.trim() !== ""));
}

function num(s) {
  const t = String(s == null ? "" : s).trim().replace(/,/g, "");
  if (t === "" || t === "--" || t === ".") return null;
  const v = Number(t);
  return isFinite(v) ? v : null;
}

// "2026-08-27 19:55:00" + offset del encabezado -> ISO con zona explícita.
// El encabezado de CMC dice el huso con el que exportó: "Date (UTC-3:00)".
function offsetDelHeader(h) {
  const m = /UTC([+-])(\d{1,2}):?(\d{2})?/i.exec(h || "");
  if (!m) return null;
  const sign = m[1], hh = String(m[2]).padStart(2, "0"), mm = m[3] || "00";
  return `${sign}${hh}:${mm}`;
}

function aISO(fecha, offset) {
  const t = String(fecha).trim().replace(" ", "T");
  const conSeg = /T\d{2}:\d{2}$/.test(t) ? t + ":00" : t;
  const d = new Date(conSeg + (offset || "Z"));
  return isNaN(d) ? null : d.toISOString();
}

export function dedupeKey(isoTs, symbol, type, amount) {
  return [isoTs, String(symbol).toUpperCase(), type, Number(amount).toFixed(10)].join("|");
}

const TIPOS_CMC = new Set(["buy", "sell", "transferin", "transferout"]);
const TIPO_NORM = { buy: "buy", sell: "sell", transferin: "transferIn", transferout: "transferOut" };

// Convierte un CSV de transacciones de CoinMarketCap en filas listas para insertar.
export function parseCMCTransactions(text, portfolio) {
  const filas = parseCSV(text);
  if (!filas.length) throw new Error("El archivo está vacío.");
  const head = filas[0].map((h) => h.trim());
  const iFecha = head.findIndex((h) => /^date/i.test(h));
  const col = (re) => head.findIndex((h) => re.test(h));
  const iToken = col(/^token$/i), iTipo = col(/^type$/i), iPrecio = col(/^price/i);
  const iCant = col(/^amount$/i), iTotal = col(/^total value/i);
  const iFee = col(/^fee$/i), iFeeCur = col(/^fee currency/i), iNotas = col(/^notes$/i);

  if (iFecha < 0 || iToken < 0 || iTipo < 0 || iCant < 0) {
    throw new Error("No parece el CSV de transacciones de CoinMarketCap (faltan columnas Date/Token/Type/Amount).");
  }

  const offset = offsetDelHeader(head[iFecha]);
  const out = [], rechazadas = [];
  for (const f of filas.slice(1)) {
    const tipoRaw = (f[iTipo] || "").trim().toLowerCase();
    const iso = aISO(f[iFecha], offset);
    const cant = num(f[iCant]);
    if (!iso || !TIPOS_CMC.has(tipoRaw) || cant == null) {
      rechazadas.push((f[iFecha] || "?") + " " + (f[iToken] || "?") + " " + tipoRaw);
      continue;
    }
    const symbol = (f[iToken] || "").trim().toUpperCase();
    const type = TIPO_NORM[tipoRaw];
    const price = iPrecio >= 0 ? num(f[iPrecio]) : null;
    let total = iTotal >= 0 ? num(f[iTotal]) : null;
    if (total == null && price != null) total = price * cant;
    out.push({
      portfolio, ts: iso, symbol, type,
      price, amount: cant, total_value: total,
      fee: (iFee >= 0 ? num(f[iFee]) : null) || 0,
      fee_currency: (iFeeCur >= 0 ? (f[iFeeCur] || "").trim() : "") || "USD",
      notes: iNotas >= 0 ? (f[iNotas] || "").trim() || null : null,
      source: "cmc",
      dedupe_key: dedupeKey(iso, symbol, type, cant),
    });
  }
  return { filas: out, rechazadas };
}

function portfolioDeNombre(fileName) {
  const base = String(fileName || "").replace(/\.csv$/i, "");
  const m = /^(.*?)[_-]?transactions$/i.exec(base);
  const p = (m ? m[1] : base).replace(/[_-]+$/, "").trim();
  return p || "Principal";
}

export async function importarArchivos(fileList) {
  const files = [...fileList];
  let nuevas = 0, repetidas = 0, ignorados = [], rechazadas = 0, errores = [];

  for (const file of files) {
    let text;
    try { text = await file.text(); } catch (e) { errores.push(file.name + ": no se pudo leer"); continue; }
    // El export de CMC trae también un "overview" (posiciones a hoy). No se importa:
    // las posiciones se derivan de las transacciones, que son la fuente de verdad.
    if (/^"?Last updated/i.test(text.slice(0, 20)) || /_overview/i.test(file.name)) {
      ignorados.push(file.name);
      continue;
    }
    let parsed;
    try { parsed = parseCMCTransactions(text, portfolioDeNombre(file.name)); }
    catch (e) { errores.push(file.name + ": " + e.message); continue; }
    rechazadas += parsed.rechazadas.length;

    const yaHay = new Set(INV.transactions.map((t) => t.portfolio + "|" + t.dedupe_key));
    for (const row of parsed.filas) {
      if (yaHay.has(row.portfolio + "|" + row.dedupe_key)) { repetidas++; continue; }
      try {
        const ins = await DB.insert("inv_transactions", row);
        INV.transactions.push(ins);
        yaHay.add(row.portfolio + "|" + row.dedupe_key);
        nuevas++;
      } catch (e) {
        // 23505 = ya existía en la base aunque no estuviera en memoria
        if (/ya existe|duplicad|23505/i.test(e.message)) repetidas++;
        else errores.push(row.symbol + " " + row.ts + ": " + e.message);
      }
    }
  }
  return { nuevas, repetidas, ignorados, rechazadas, errores };
}

// ---------- Render ----------

export function renderInversiones() {
  if (!INV.loaded) return `<div class="loading">Cargando inversiones…</div>`;
  if (INV.filterPortfolio === PIONEX && !pionexActivo()) INV.filterPortfolio = "";
  const r = resumen(INV.filterPortfolio);
  const priv = privacyOn();

  const ojo = priv
    ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l18 18M10.6 10.7a2 2 0 002.8 2.8"/><path d="M9.4 5.2A9.7 9.7 0 0112 5c5 0 9 4.5 9 7 0 .9-.6 2.1-1.6 3.2M6.3 6.7C4 8.2 3 10.2 3 12c0 2.5 4 7 9 7 1.5 0 2.9-.4 4.1-1"/></svg>`
    : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12s3.6-7 9-7 9 7 9 7-3.6 7-9 7-9-7-9-7z"/><circle cx="12" cy="12" r="2.6"/></svg>`;

  const right = `
    <button class="icon-btn" data-action="inv-privacidad" aria-label="${priv ? "Mostrar montos" : "Ocultar montos"}" title="${priv ? "Mostrar montos" : "Ocultar montos"}">${ojo}</button>
    <button class="icon-btn" data-action="inv-precios" aria-label="Actualizar precios" title="Actualizar precios">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 10-2.3 6.1M20 6v5h-5"/></svg>
    </button>`;

  const head = `<header class="topbar">
    <span class="back-spacer"></span><h1>Inversiones</h1>
    <div class="topbar-right">${right}</div>
  </header>`;

  const tabs = `<div class="fchips inv-tabs">
    <button class="fchip ${INV.tab === "resumen" ? "active" : ""}" data-action="inv-tab" data-tab="resumen">Portafolio</button>
    <button class="fchip ${INV.tab === "historial" ? "active" : ""}" data-action="inv-tab" data-tab="historial">Movimientos</button>
  </div>`;

  const cuerpo = INV.tab === "resumen" ? vistaResumen(r) : vistaHistorial(r);
  return head + `<main class="content inv">` + tabs + cuerpo + `</main>`;
}

// Chips de grupo. Con un solo grupo igual se muestra, para poder renombrarlo.
function chipsGrupo() {
  const gs = grupos();
  if (!gs.length) return "";
  const activo = INV.filterPortfolio;
  const todos = gs.length > 1
    ? `<button class="fchip ${!activo ? "active" : ""}" data-action="inv-grupo" data-pf="">Todos</button>`
    : "";
  const chips = gs.map((g) =>
    `<button class="fchip ${activo === g.key ? "active" : ""}" data-action="inv-grupo" data-pf="${esc(g.key)}">${esc(g.label)}</button>`
  ).join("");
  const renombrar = activo
    ? `<button class="fchip fchip-accion" data-action="inv-renombrar" data-pf="${esc(activo)}" title="Renombrar grupo">✎</button>`
    : "";
  return `<div class="fchips fchips-grupo">${todos}${chips}${renombrar}</div>`;
}

function signo(v) {
  return v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "";
}

// Importar y exportar son acciones esporádicas: van al final, chicas, sin competir con
// las posiciones. Exportar siempre cubre el portafolio completo, no el grupo filtrado.
function accionesInv(conImportar) {
  const importar = conImportar
    ? `<button class="btn-small inv-importar" data-action="inv-importar">⬆ Importar CSV de CoinMarketCap</button>
       <input type="file" id="inv-file" accept=".csv,text/csv" multiple hidden />`
    : "";
  return `<div class="inv-acciones">
      <button class="btn-small inv-importar" data-action="inv-exportar">⬇ Descargar Excel</button>
      ${importar}
    </div>`;
}

function vistaResumen(r) {
  if (r.pionex) return vistaPionex(r);
  const frescura = INV.pricesAt
    ? `Precios de ${new Date(INV.pricesAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`
    : "Sin precios todavía — toca ↻ arriba";

  // Con un grupo filtrado el encabezado es el valor de ese grupo: la deuda es global
  // y restarla de un solo grupo daría un "neto" que no significa nada.
  const total = resumen().valor;
  const peso = total > 0 ? (r.valor / total) * 100 : null;
  const patrimonio = r.filtrado
    ? `
    <section class="inv-hero">
      <div class="inv-hero-label">${esc(labelGrupo(INV.filterPortfolio))}</div>
      <div class="inv-hero-value">${money(r.valor)}</div>
      <div class="inv-hero-sub">${esc(frescura)}${r.sinPrecio ? ` · ${r.sinPrecio} sin precio` : ""}</div>
      <div class="inv-hero-grid">
        <div><span>Peso en el total</span><strong>${peso == null ? "—" : peso.toFixed(1) + "%"}</strong></div>
        <div><span>Portafolio completo</span><strong>${money(total)}</strong></div>
      </div>
    </section>`
    : `
    <section class="inv-hero">
      <div class="inv-hero-label">Patrimonio neto</div>
      <div class="inv-hero-value ${signo(r.neto)}">${money(r.neto)}</div>
      <div class="inv-hero-sub">${esc(frescura)}${r.sinPrecio ? ` · ${r.sinPrecio} sin precio` : ""}</div>
      <div class="inv-hero-grid">
        <div><span>Portafolio</span><strong>${money(r.valor)}</strong></div>
        <div><span>Deuda</span><strong class="${r.debt > 0 ? "neg" : ""}">${money(r.debt)}</strong>
          <button class="btn-small inv-debt-btn" data-action="inv-deuda">Ajustar</button></div>
      </div>
    </section>`;

  const pnl = `
    <section class="inv-pnl">
      <div><span>Costo</span><strong>${money(r.costo)}</strong></div>
      <div><span>No realizado</span><strong class="${signo(r.unrealized)}">${money(r.unrealized)}</strong></div>
      <div><span>Realizado</span><strong class="${signo(r.realized)}">${money(r.realized)}</strong></div>
    </section>`;

  const abiertas = r.abiertas;
  const cerradas = r.pos.filter((p) => !p.abierta && p.nTx > 0);

  const lista = abiertas.length
    ? abiertas.map((p) => filaPosicion(p, r.valor)).join("")
    : `<div class="empty">Todavía no hay posiciones. Importa el CSV de CoinMarketCap o agrega un movimiento con el +.</div>`;

  // En "Todos" los bots no se listan uno a uno: una tarjeta resumen lleva al grupo Pionex.
  const b = r.px?.bots;
  const botsResumen = b && (b.activos.length || b.cerrados.length) ? `
    <button class="card inv-bots-resumen" data-action="inv-grupo" data-pf="${PIONEX}">
      <div class="inv-pos-id">
        <span class="inv-sym">Bots ${esc(labelGrupo(PIONEX))}</span>
        <span class="inv-name">${b.activos.length} activo${b.activos.length === 1 ? "" : "s"} · ${b.cerrados.length} cerrado${b.cerrados.length === 1 ? "" : "s"}</span>
      </div>
      <div class="inv-pos-num">
        <span class="inv-val">${money(b.valor)}</span>
        <span class="inv-pnl ${signo(b.pnlTotal)}">PnL total ${money(b.pnlTotal)}</span>
      </div>
    </button>` : "";

  const acciones = accionesInv(true);

  const cerradasHtml = cerradas.length
    ? `<button class="inv-cerradas-head" data-action="inv-toggle-cerradas" aria-expanded="${INV.cerradasAbierto}">
         <span class="section-title">Cerradas (${cerradas.length})</span>
         <span class="inv-chevron ${INV.cerradasAbierto ? "abierto" : ""}">›</span>
       </button>
       ${INV.cerradasAbierto ? `<div class="inv-cerradas">${cerradas.map((p) => `
         <div class="inv-cerrada">
           <span class="inv-sym">${esc(p.symbol)}</span>
           <span class="${signo(p.realized)}">${money(p.realized)}</span>
         </div>`).join("")}</div>` : ""}`
    : "";

  return chipsGrupo() + patrimonio + pnl +
    `<h2 class="section-title">Posiciones (${abiertas.length})</h2>` + lista + botsResumen + cerradasHtml + acciones;
}

// ---------- Vista del grupo Pionex ----------

const hora = (ms) => new Date(ms).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
const TIPO_BOT = { spot: "Spot grid", futures: "Futures grid" };
const TREND = { long: "Long", short: "Short", no_trend: "Neutral" };
const MOTIVO = { user_cancel: "cerrado por ti", loss_stop: "stop loss", profit_stop: "take profit",
                 force_liquidation: "liquidado", not_enough_balance: "sin saldo", create_failed: "falló al crear" };

function dias(desde, hasta) {
  if (!desde) return null;
  return Math.max(0, Math.floor(((hasta || Date.now()) - desde) / 86400000));
}

function vistaPionex(r) {
  const { PX } = PXM;
  const b = r.bots;
  const total = resumen().valor;
  const peso = total > 0 ? (r.valor / total) * 100 : null;
  const estado = PX.loading ? "Actualizando…" : PX.at ? `Datos de ${hora(PX.at)}` : "Sin datos todavía — toca ↻ arriba";

  const hero = `
    <section class="inv-hero">
      <div class="inv-hero-label">${esc(labelGrupo(PIONEX))}</div>
      <div class="inv-hero-value">${money(r.valor)}</div>
      <div class="inv-hero-sub">${esc(estado)}${peso == null ? "" : ` · ${peso.toFixed(1)}% del total`}${r.sinPrecio ? ` · ${r.sinPrecio} bot(s) sin precio` : ""}</div>
      ${PX.error ? `<div class="inv-aviso">⚠️ ${esc(PX.error)}</div>` : ""}
      <div class="inv-hero-grid">
        <div><span>Bots activos</span><strong>${money(b.valor)}</strong></div>
        <div><span>Saldo spot</span><strong>${money(r.valorSpot)}</strong></div>
      </div>
    </section>`;

  const pnl = `
    <section class="inv-pnl">
      <div><span>PnL total bots</span><strong class="${signo(b.pnlTotal)}">${money(b.pnlTotal)}</strong></div>
      <div><span>PnL actual bots</span><strong class="${signo(b.pnlActual)}">${money(b.pnlActual)}</strong></div>
      <div><span>PnL cerrados</span><strong class="${signo(b.pnlCerrados)}">${money(b.pnlCerrados)}</strong></div>
    </section>`;

  const activos = b.activos.length
    ? b.activos.map(filaBot).join("")
    : `<div class="empty">No hay bots activos.</div>`;

  const saldos = r.pos.length
    ? r.pos.map((p) => filaPosicion(p, r.valor)).join("")
    : `<div class="empty">Sin saldos spot sobre US$1.</div>`;

  const cerrados = b.cerrados.length
    ? `<button class="inv-cerradas-head" data-action="inv-toggle-bots-cerrados" aria-expanded="${INV.botsCerradosAbierto}">
         <span class="section-title">Bots cerrados (${b.cerrados.length})</span>
         <span class="inv-cerradas-suma ${signo(b.pnlCerrados)}">${money(b.pnlCerrados)}</span>
         <span class="inv-chevron ${INV.botsCerradosAbierto ? "abierto" : ""}">›</span>
       </button>
       ${INV.botsCerradosAbierto ? `<div class="inv-tx-list">${b.cerrados.map(filaBotCerrado).join("")}</div>` : ""}`
    : "";

  return chipsGrupo() + hero + pnl +
    `<h2 class="section-title">Bots activos (${b.activos.length})</h2>` + activos +
    `<h2 class="section-title">Saldo spot (${r.pos.length})</h2>` + saldos + cerrados +
    accionesInv(false);
}

function filaBot(b) {
  const key = "bot:" + b.id;
  const abierto = INV.expanded === key;
  const d = dias(b.creado);
  const sub = [TIPO_BOT[b.tipo],
               b.tipo === "futures" ? [TREND[b.trend], b.leverage ? b.leverage + "x" : ""].filter(Boolean).join(" ") : "",
               d == null ? "" : `${d} d`].filter(Boolean).join(" · ");

  const celda = (label, v, cls) => `<div class="${cls || ""}"><span>${label}</span><b class="${signo(v)}">${money(v)}</b></div>`;
  // Desglose del capital. Las tres celdas van siempre, con "—" cuando no hay nada:
  // así cada dato queda en el mismo lugar en todos los bots.
  const opc = (v) => (Math.abs(v) > 0.01 ? Math.abs(v) : null);
  const capital = b.capInicial == null ? "" :
    `<div><span>Capital inicial</span><b>${money(b.capInicial)}</b></div>
     <div><span>${b.capAgregado < -0.01 ? "Sacado después" : "Agregado después"}</span><b>${money(opc(b.capAgregado))}</b></div>
     <div><span>Ganancia reinvertida</span><b>${money(opc(b.reinvertido))}</b></div>`;

  const detalle = abierto ? `
    <div class="inv-detalle">
      <div><span>Inversión</span><b>${money(b.inversion)}</b></div>
      ${capital}
      <div><span>Retirado</span><b>${money(b.retirado)}</b></div>
      <div><span>Profit de grilla</span><b class="${signo(b.profitGrilla)}">${money(b.profitGrilla)}${
        b.profitGrillaDentro == null ? "" : ` <small>(${money(b.profitGrillaDentro)} dentro)</small>`}</b></div>
      <div><span>Precio actual</span><b>${fmtPrice(b.precio)}</b></div>
      ${b.tipo === "futures" ? `
        <div><span>Posición</span><b>${fmtQty(b.posicion)} @ ${fmtPrice(b.precioEntrada)}</b></div>
        ${celda("No realizado", b.flotante)}
        ${celda("Funding", b.funding)}
        ${celda("Comisiones", b.comisiones)}
        ${celda("PnL total por caja", b.pnlCaja)}
        <div><span>Liquidación</span><b>${fmtPrice(b.liquidacion)}</b></div>` : ""}
      <div><span>Rango</span><b>${fmtPrice(b.bottom)} – ${fmtPrice(b.top)}</b></div>
      <div><span>Grillas</span><b>${b.grillas ?? "—"}</b></div>
      <div><span>Creado</span><b>${b.creado ? fmtFecha(b.creado) : "—"}</b></div>
      ${b.nombre ? `<div><span>Nombre</span><b class="inv-detalle-nombre">${esc(b.nombre)}</b></div>` : ""}
    </div>` : "";

  return `<article class="card inv-pos inv-bot ${abierto ? "expanded" : ""}">
    <div class="inv-pos-main" data-action="inv-expandir" data-sym="${esc(key)}">
      <div class="inv-pos-id">
        <span class="inv-sym">${esc(b.base)}<span class="inv-quote">/${esc(b.quote)}</span></span>
        <span class="inv-name">${esc(sub)}</span>
      </div>
      <div class="inv-cambios inv-bot-pnls">
        ${celda("Total", b.pnlTotal)}${celda("Actual", b.pnlActual)}${celda("Grilla", b.profitGrilla)}
      </div>
      <div class="inv-pos-num">
        <span class="inv-val">${money(b.valor)}</span>
        <span class="inv-pnl ${signo(b.pnlTotal)}">${b.pnlTotal == null ? "sin precio" : fmtPct(b.pnlTotalPct)}</span>
      </div>
    </div>
    ${detalle}
  </article>`;
}

function filaBotCerrado(b) {
  const d = dias(b.creado, b.cerradoEn);
  const sub = [TIPO_BOT[b.tipo] + (b.bono ? " (bono)" : ""),
               b.cerradoEn ? `cerrado ${fmtFecha(b.cerradoEn)}` : "",
               d == null ? "" : `${d} d`,
               MOTIVO[b.motivoCierre] || b.motivoCierre || ""].filter(Boolean).join(" · ");
  return `<article class="card inv-tx">
    <div class="inv-tx-main">
      <div>
        <div class="inv-tx-top"><span class="inv-sym">${esc(b.base)}<span class="inv-quote">/${esc(b.quote)}</span></span></div>
        <div class="inv-tx-sub">${esc(sub)}</div>
      </div>
      <div class="inv-bot-cerrado-num">
        <span class="${signo(b.pnlTotal)}">${money(b.pnlTotal)}</span>
        <span class="inv-sub">${b.pnlTotalPct == null ? (b.pnlTotal == null ? "sin datos" : "") : fmtPct(b.pnlTotalPct)}</span>
      </div>
    </div>
  </article>`;
}

function filaPosicion(p, valorTotal) {
  const peso = valorTotal > 0 && p.value != null ? (p.value / valorTotal) * 100 : null;
  const key = p.key || p.symbol;
  const abierto = INV.expanded === key;
  const detalle = abierto && p.pionex ? `
    <div class="inv-detalle">
      <div><span>Cantidad</span><b>${fmtQty(p.qty)}</b></div>
      <div><span>Nombre</span><b class="inv-detalle-nombre">${esc(p.name || "—")}</b></div>
      <div><span>Costo prom.</span><b>${p.avgCost == null ? "—" : privacyOn() ? "••••" : fmtPrice(p.avgCost)}</b></div>
      <div><span>Costo total</span><b>${p.cost > 0 ? money(p.cost) : "—"}</b></div>
      <div><span>No realizado</span><b class="${signo(p.unrealized)}">${p.cost > 0 ? `${money(p.unrealized)} (${fmtPct(p.unrealizedPct)})` : "—"}</b></div>
      <div><span>Realizado</span><b class="${signo(p.realized)}">${p.nTx ? money(p.realized) : "—"}</b></div>
      <div><span>Órdenes spot</span><b>${p.nTx || "—"}</b></div>
      <div class="inv-detalle-acciones">
        <button class="btn-small" data-action="inv-token" data-sym="${esc(p.symbol)}">Precio / fuente</button>
      </div>
      ${p.parcial ? `<div class="inv-detalle-aviso">El saldo no coincide con las órdenes de compra: parte puede venir de un bot o de una transferencia, así que el costo es aproximado.</div>` : ""}
      ${p.nTx ? "" : `<div class="inv-detalle-aviso">Sin órdenes de compra en Pionex para esta moneda: no hay costo que calcular.</div>`}
    </div>` : abierto ? `
    <div class="inv-detalle">
      <div><span>Cantidad</span><b>${fmtQty(p.qty)}</b></div>
      <div><span>Nombre</span><b class="inv-detalle-nombre">${esc(p.name || "—")}</b></div>
      <div><span>Costo prom.</span><b>${privacyOn() ? "••••" : fmtPrice(p.avgCost)}</b></div>
      <div><span>Costo total</span><b>${money(p.cost)}</b></div>
      <div><span>No realizado</span><b class="${signo(p.unrealized)}">${money(p.unrealized)} (${fmtPct(p.unrealizedPct)})</b></div>
      <div><span>Realizado</span><b class="${signo(p.realized)}">${money(p.realized)}</b></div>
      <div><span>Prom. según CMC</span><b>${privacyOn() ? "••••" : fmtPrice(p.avgCMC)}</b></div>
      <div><span>Movimientos</span><b>${p.nTx}</b></div>
      <div class="inv-detalle-acciones">
        <button class="btn-small" data-action="inv-ver-mov" data-sym="${esc(p.symbol)}">Ver movimientos</button>
        <button class="btn-small" data-action="inv-token" data-sym="${esc(p.symbol)}">Precio / fuente</button>
      </div>
    </div>` : "";

  // Cambios del PRECIO del token (no de la posición): lo que hizo el mercado.
  const px = INV.prices[p.symbol] || {};
  const cambio = (label, v) =>
    `<div><span>${label}</span><b class="${signo(v)}">${v == null ? "—" : fmtPctCorto(v)}</b></div>`;

  return `<article class="card inv-pos ${abierto ? "expanded" : ""}">
    <div class="inv-pos-main" data-action="inv-expandir" data-sym="${esc(key)}">
      <div class="inv-pos-id">
        <span class="inv-sym">${esc(p.symbol)}${p.pionex && INV.filterPortfolio !== PIONEX ? ` <span class="inv-origen">Pionex</span>` : ""}</span>
        <span class="inv-name">${fmtPrice(p.price)}</span>
        <span class="inv-pos-peso">${peso == null ? "" : `${peso.toFixed(1)}% del portafolio`}</span>
      </div>
      <div class="inv-cambios">
        ${cambio("30d", px.change30d)}${cambio("7d", px.change7d)}${cambio("1d", px.change24h)}
      </div>
      <div class="inv-pos-num">
        <span class="inv-val">${money(p.value)}</span>
        <span class="inv-pnl ${signo(p.unrealized)}">${p.price == null ? "sin precio" : p.unrealizedPct == null ? "" : fmtPct(p.unrealizedPct)}</span>
      </div>
    </div>
    ${detalle}
  </article>`;
}

function vistaHistorial(r) {
  let tx = [...INV.transactions].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  if (INV.filterPortfolio) tx = tx.filter((t) => grupoDe(t) === INV.filterPortfolio);
  const enGrupo = tx;
  if (INV.filterSymbol) tx = tx.filter((t) => t.symbol === INV.filterSymbol);

  const symbols = [...new Set(enGrupo.map((t) => t.symbol))].sort();
  const chips = `<div class="fchips">
    <button class="fchip ${!INV.filterSymbol ? "active" : ""}" data-action="inv-filtro" data-sym="">Todos</button>
    ${symbols.map((s) => `<button class="fchip ${INV.filterSymbol === s ? "active" : ""}" data-action="inv-filtro" data-sym="${esc(s)}">${esc(s)}</button>`).join("")}
  </div>`;

  if (INV.filterPortfolio === PIONEX) {
    return chipsGrupo() + `<div class="empty">Pionex se lee en vivo desde su API: muestra saldos y bots, no un historial de movimientos. Sus órdenes spot sí van en el Excel.</div>` + accionesInv(false);
  }
  if (!tx.length) return chipsGrupo() + chips + `<div class="empty">Sin movimientos.</div>` + accionesInv(false);

  const filas = tx.map((t) => {
    const total = t.total_value == null ? null : Number(t.total_value);
    const entra = t.type === "buy" || t.type === "transferIn";
    return `<article class="card inv-tx">
      <div class="inv-tx-main">
        <div>
          <div class="inv-tx-top">
            <span class="inv-tipo ${t.type}">${TIPO_LABEL[t.type] || t.type}</span>
            <span class="inv-sym">${esc(t.symbol)}</span>
            ${t.source === "cmc" ? `<span class="inv-origen">CMC</span>` : ""}
          </div>
          <div class="inv-tx-sub">${fmtFecha(t.ts)} · ${fmtQty(Number(t.amount))} @ ${fmtPrice(t.price == null ? null : Number(t.price))}</div>
        </div>
        <div class="inv-tx-num">
          <span class="${entra ? "" : "pos"}">${total == null ? "—" : (entra ? "-" : "+") + money(total).replace("-", "")}</span>
          <button class="comp-del" data-action="inv-borrar-tx" data-id="${t.id}" aria-label="Borrar movimiento">✕</button>
        </div>
      </div>
    </article>`;
  }).join("");

  return chipsGrupo() + chips + `<div class="inv-tx-list">${filas}</div>` + accionesInv(false);
}

// ---------- Modales ----------

function modalDeuda() {
  const d = Number(INV.settings?.debt || 0);
  return `<h2>Deuda</h2>
    <form data-form="inv-deuda">
      <label>Saldo actual (USD)
        <input type="number" name="debt" step="0.01" value="${d}" required />
      </label>
      <div class="inv-quick">
        <button type="button" class="btn-small" data-action="inv-deuda-delta" data-delta="-100">−100</button>
        <button type="button" class="btn-small" data-action="inv-deuda-delta" data-delta="-500">−500</button>
        <button type="button" class="btn-small" data-action="inv-deuda-delta" data-delta="500">+500</button>
        <button type="button" class="btn-small" data-action="inv-deuda-delta" data-delta="1000">+1000</button>
      </div>
      <label>Nota (opcional)
        <input type="text" name="debt_note" value="${esc(INV.settings?.debt_note || "")}" placeholder="Ej: crédito de consumo" />
      </label>
      <p class="hint">Es un saldo único: se resta del portafolio para el patrimonio neto.</p>
      <div class="modal-actions">
        <button type="button" class="btn-small" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`;
}

function modalTrade() {
  const hoy = new Date();
  const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
  const hora = `${String(hoy.getHours()).padStart(2, "0")}:${String(hoy.getMinutes()).padStart(2, "0")}`;
  const portfolios = [...new Set(INV.transactions.map((t) => t.portfolio))];
  const pf = portfolios[0] || "Principal";
  return `<h2>Nuevo movimiento</h2>
    <form data-form="inv-trade">
      <div class="form-row">
        <label>Token<input type="text" name="symbol" required placeholder="NEXO" autocapitalize="characters" /></label>
        <label>Tipo<select name="type">
          <option value="buy">Compra</option><option value="sell">Venta</option>
          <option value="transferIn">Entrada</option><option value="transferOut">Salida</option>
        </select></label>
      </div>
      <div class="form-row">
        <label>Fecha<input type="date" name="date" value="${fecha}" required /></label>
        <label>Hora<input type="time" name="time" value="${hora}" /></label>
      </div>
      <div class="form-row">
        <label>Cantidad<input type="number" name="amount" step="any" required /></label>
        <label>Precio USD<input type="number" name="price" step="any" placeholder="opcional" /></label>
      </div>
      <label>Total USD (si lo dejas vacío se calcula cantidad × precio)
        <input type="number" name="total_value" step="any" placeholder="opcional" /></label>
      <label>Portafolio<input type="text" name="portfolio" value="${esc(pf)}" /></label>
      <div class="modal-actions">
        <button type="button" class="btn-small" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`;
}

function modalRenombrar(pf) {
  const actual = labelGrupo(pf);
  const renombrado = actual !== pf;
  return `<h2>Renombrar grupo</h2>
    <form data-form="inv-renombrar" data-pf="${esc(pf)}">
      <label>Nombre visible
        <input type="text" name="label" value="${esc(actual)}" required maxlength="40" /></label>
      ${pf === PIONEX
        ? `<p class="hint">Es el grupo que se lee en vivo desde la API de Pionex.</p>`
        : `<p class="hint">Internamente el grupo sigue llamándose <b>${esc(pf)}</b>, que es como viene del
        archivo de CoinMarketCap. Por eso volver a importar ese export no crea un grupo duplicado.</p>`}
      <div class="modal-actions">
        ${renombrado ? `<button type="button" class="btn-small" data-action="inv-restaurar-nombre" data-pf="${esc(pf)}">Volver al original</button>` : ""}
        <button type="button" class="btn-small" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`;
}

function modalToken(sym) {
  const tk = INV.tokens.find((t) => t.symbol === sym) || {};
  return `<h2>${esc(sym)}</h2>
    <form data-form="inv-token" data-sym="${esc(sym)}">
      <label>ID en CoinGecko
        <input type="text" name="coingecko_id" value="${esc(tk.coingecko_id || "")}" placeholder="ej: nexo" /></label>
      <p class="hint">El id aparece en la URL de CoinGecko: coingecko.com/en/coins/<b>nexo</b>. Déjalo vacío si el token no está listado.</p>
      <label>Precio manual USD (gana sobre CoinGecko)
        <input type="number" name="manual_price" step="any" value="${tk.manual_price ?? ""}" placeholder="opcional" /></label>
      <label class="check-row"><input type="checkbox" name="hidden" ${tk.hidden ? "checked" : ""} /> Ocultar del portafolio</label>
      <div class="modal-actions">
        <button type="button" class="btn-small" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn-primary">Guardar</button>
      </div>
    </form>`;
}

// ---------- Acciones ----------

// Devuelve true si manejó la acción.
export async function handleAction(a, el) {
  if (a === "inv-privacidad") { togglePrivacy(); ctx.render(); return true; }

  if (a === "inv-tab") { INV.tab = el.dataset.tab; INV.expanded = null; ctx.render(); return true; }

  if (a === "inv-filtro") { INV.filterSymbol = el.dataset.sym || ""; ctx.render(); return true; }

  if (a === "inv-grupo") {
    INV.filterPortfolio = el.dataset.pf || "";
    INV.filterSymbol = "";       // el token filtrado puede no existir en el grupo nuevo
    INV.expanded = null;
    ctx.render();
    return true;
  }

  if (a === "inv-renombrar") { ctx.openModal(modalRenombrar(el.dataset.pf)); return true; }

  if (a === "inv-toggle-bots-cerrados") {
    INV.botsCerradosAbierto = !INV.botsCerradosAbierto;
    ctx.render();
    return true;
  }

  if (a === "inv-toggle-cerradas") {
    INV.cerradasAbierto = !INV.cerradasAbierto;
    ctx.render();
    return true;
  }

  if (a === "inv-restaurar-nombre") {
    const pf = el.dataset.pf;
    const labels = { ...(INV.settings?.portfolio_labels || {}) };
    delete labels[pf];
    await guardarSettings({ portfolio_labels: labels });
    ctx.closeModal();
    ctx.render();
    return true;
  }

  if (a === "inv-expandir") {
    INV.expanded = INV.expanded === el.dataset.sym ? null : el.dataset.sym;
    ctx.render();
    return true;
  }

  if (a === "inv-ver-mov") {
    INV.tab = "historial"; INV.filterSymbol = el.dataset.sym; ctx.render(); return true;
  }

  if (a === "inv-precios") {
    ctx.showToast("Actualizando precios…");
    if (PXM.PX.disponible !== false || !DB.isRemote()) { await PXM.refresh(); ctx.render(); }
    await refreshPrices();
    ctx.render();
    return true;
  }

  if (a === "inv-deuda") { ctx.openModal(modalDeuda()); return true; }

  if (a === "inv-deuda-delta") {
    const input = document.querySelector('form[data-form="inv-deuda"] input[name="debt"]');
    if (input) input.value = (Number(input.value || 0) + Number(el.dataset.delta)).toFixed(2);
    return true;
  }

  if (a === "inv-trade") { ctx.openModal(modalTrade()); return true; }

  if (a === "inv-token") { ctx.openModal(modalToken(el.dataset.sym)); return true; }

  if (a === "inv-exportar") {
    try {
      // Sin await antes de generar: en iOS la hoja de compartir solo se abre si sale
      // dentro del mismo gesto del usuario.
      const res = exportarInversiones();
      ctx.showToast(res.via === "compartido" ? `✓ ${res.nombre} listo para compartir` : `✓ ${res.nombre}`);
    } catch (e) {
      ctx.showToast("⚠️ No se pudo generar el Excel: " + e.message);
    }
    return true;
  }

  if (a === "inv-importar") {
    const input = document.getElementById("inv-file");
    if (!input) return true;
    input.onchange = async () => {
      if (!input.files?.length) return;
      ctx.showToast("Importando…");
      const res = await importarArchivos(input.files);
      input.value = "";
      let msg = `${res.nuevas} movimiento${res.nuevas === 1 ? "" : "s"} nuevo${res.nuevas === 1 ? "" : "s"}`;
      if (res.repetidas) msg += `, ${res.repetidas} ya estaban`;
      if (res.rechazadas) msg += `, ${res.rechazadas} sin formato válido`;
      if (res.ignorados.length) msg += `, ${res.ignorados.length} archivo(s) de resumen ignorados`;
      ctx.showToast((res.errores.length ? "⚠️ " : "✓ ") + msg + (res.errores.length ? ` · ${res.errores[0]}` : ""));
      if (res.nuevas) await refreshPrices(true);
      ctx.render();
    };
    input.click();
    return true;
  }

  if (a === "inv-borrar-tx") {
    const id = el.dataset.id;
    const t = INV.transactions.find((x) => x.id === id);
    if (!t) return true;
    if (!confirm(`¿Borrar ${TIPO_LABEL[t.type] || t.type} de ${t.symbol} del ${fmtFecha(t.ts)}?`)) return true;
    try {
      await DB.remove("inv_transactions", id);
      INV.transactions = INV.transactions.filter((x) => x.id !== id);
      ctx.showToast("Movimiento borrado");
    } catch (e) {
      ctx.showToast("⚠️ " + e.message);
    }
    ctx.render();
    return true;
  }

  return false;
}

// Devuelve true si manejó el submit.
export async function handleSubmit(kind, fd, form) {
  if (kind === "inv-deuda") {
    const debt = Number(fd.get("debt") || 0);
    const debt_note = (fd.get("debt_note") || "").trim() || null;
    await guardarSettings({ debt, debt_note });
    ctx.closeModal();
    ctx.render();
    return true;
  }

  if (kind === "inv-trade") {
    const symbol = (fd.get("symbol") || "").trim().toUpperCase();
    const amount = Number(fd.get("amount"));
    if (!symbol || !isFinite(amount) || amount <= 0) {
      ctx.showToast("⚠️ Revisa token y cantidad");
      return true;
    }
    const date = fd.get("date");
    const time = fd.get("time") || "00:00";
    const ts = new Date(`${date}T${time}:00`).toISOString();
    const price = fd.get("price") === "" ? null : Number(fd.get("price"));
    let total = fd.get("total_value") === "" ? null : Number(fd.get("total_value"));
    if (total == null && price != null) total = price * amount;
    const type = fd.get("type");
    const portfolio = (fd.get("portfolio") || "").trim() || "Principal";

    const row = {
      portfolio, ts, symbol, type, price, amount, total_value: total,
      fee: 0, fee_currency: "USD", source: "manual",
      dedupe_key: dedupeKey(ts, symbol, type, amount),
    };
    if (INV.transactions.some((t) => t.portfolio === portfolio && t.dedupe_key === row.dedupe_key)) {
      ctx.showToast("⚠️ Ya existe ese movimiento (mismo token, tipo, fecha y cantidad)");
      return true;
    }
    const ins = await DB.insert("inv_transactions", row);
    INV.transactions.push(ins);
    ctx.closeModal();
    await refreshPrices(true);
    ctx.render();
    return true;
  }

  if (kind === "inv-renombrar") {
    const pf = form.dataset.pf;
    const label = (fd.get("label") || "").trim();
    if (!label) { ctx.showToast("⚠️ Ponle un nombre"); return true; }
    const labels = { ...(INV.settings?.portfolio_labels || {}) };
    if (label === pf) delete labels[pf]; else labels[pf] = label;
    await guardarSettings({ portfolio_labels: labels });
    ctx.closeModal();
    ctx.render();
    return true;
  }

  if (kind === "inv-token") {
    const sym = form.dataset.sym;
    const cg = (fd.get("coingecko_id") || "").trim() || null;
    const mp = fd.get("manual_price") === "" ? null : Number(fd.get("manual_price"));
    await guardarToken(sym, { coingecko_id: cg, manual_price: mp, hidden: !!fd.get("hidden") });
    ctx.closeModal();
    await refreshPrices(true);
    ctx.render();
    return true;
  }

  return false;
}
