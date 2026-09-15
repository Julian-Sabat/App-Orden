// Pionex: saldos spot y bots (spot grid y futures grid), leídos en vivo.
//
// La app nunca ve la API key: llama a la Edge Function "pionex" de Supabase, que
// firma los requests y devuelve la respuesta cruda. Acá se normaliza y se calcula.
//
// PnL de un bot activo, en dos versiones:
//   - PnL actual: lo que vale hoy el bot menos lo invertido. Baja cuando retiras
//     ganancias de la grilla, porque esa plata ya no está dentro del bot.
//   - PnL total: el actual + todo lo retirado. Retirar no lo mueve.
// Los cálculos salen solo de la documentación oficial (pionex.com/docs/api-docs/bot-api);
// no se validaron contra una respuesta real. Ver los supuestos marcados con "Supuesto".

import * as DB from "./db.js";

export const PX = {
  data: null,          // respuesta de la función
  at: null,
  error: null,         // último error, se muestra en el grupo
  disponible: null,    // null = no se sabe todavía; false = la función no está publicada
  loading: false,
};

const CACHE_KEY = "orden_pionex";
const MOCK_KEY = "orden_pionex_mock";   // desarrollo: respuesta simulada en modo local
const TTL_MS = 5 * 60 * 1000;
const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "DAI", "TUSD", "USD"]);

export function leerCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    PX.data = c.data || null;
    PX.at = c.at || null;
    if (PX.data) PX.disponible = true;
  } catch (e) { /* cache corrupto: se repuebla */ }
}

export function borrarCache() {
  localStorage.removeItem(CACHE_KEY);
  PX.data = null; PX.at = null; PX.error = null; PX.disponible = null;
}

export function fresco() {
  return PX.at && Date.now() - PX.at < TTL_MS;
}

export async function refresh() {
  if (PX.loading) return;
  PX.loading = true;
  try {
    let data;
    if (!DB.isRemote()) {
      const mock = localStorage.getItem(MOCK_KEY);
      if (!mock) { PX.disponible = false; return; }
      data = JSON.parse(mock);
    } else {
      data = await DB.invokeFunction("pionex");
    }
    PX.data = data;
    PX.at = data.at || Date.now();
    PX.disponible = true;
    PX.error = data.errores?.length ? data.errores.join(" · ") : null;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, at: PX.at })); } catch (e) { /* storage lleno */ }
  } catch (e) {
    // 404 = la función no está publicada todavía: el grupo simplemente no aparece.
    if (e.status === 404) PX.disponible = PX.data ? true : false;
    else { PX.disponible = true; PX.error = e.message; }
  } finally {
    PX.loading = false;
  }
}

// ---------- Normalización ----------

function n(v) {
  if (v == null || v === "") return null;
  const x = Number(v);
  return isFinite(x) ? x : null;
}
const z = (v) => n(v) ?? 0;

// USD por unidad de una moneda, con los tickers de Pionex. USDT se toma como 1 USD.
export function usdDe(coin) {
  const t = PX.data?.tickers?.spot || {};
  if (coin === "USDT") return 1;
  if (t[`${coin}_USDT`] != null) return t[`${coin}_USDT`];
  if (STABLES.has(coin)) return 1;
  return null;
}

// Precio del par del bot, en moneda quote.
function precioPar(base, quote, perp) {
  const sp = PX.data?.tickers?.spot || {};
  const pp = PX.data?.tickers?.perp || {};
  if (perp) {
    // Supuesto: los perpetuos usan "BTC_USDT_PERP"; la doc no da el formato del símbolo.
    const v = pp[`${base}_${quote}_PERP`] ?? pp[`${base}_${quote}`];
    if (v != null) return v;
  }
  if (sp[`${base}_${quote}`] != null) return sp[`${base}_${quote}`];
  const b = usdDe(base), q = usdDe(quote);
  return b != null && q ? b / q : null;
}

export function saldos() {
  return (PX.data?.balances || [])
    .map((b) => ({ coin: b.coin, qty: z(b.free) + z(b.frozen) }))
    .filter((b) => b.qty > 0);
}

function tipoBot(t) {
  if (/future/i.test(t || "")) return "futures";
  if (/grid/i.test(t || "")) return "spot";     // "spot_grid" en el listado, "grid_v5" en el detalle
  return null;                                  // smart copy u otros: fuera de alcance
}

// Un bot crudo → objeto con montos en USD. Devuelve null si no es spot/futures grid.
export function normalizarBot(raw, cerrado) {
  const tipo = tipoBot(raw.buOrderType);
  if (!tipo) return null;
  const d = raw.buOrderData || {};
  const base = raw.base || d.base, quote = raw.quote || d.quote;
  const qUsd = usdDe(quote) ?? 1;
  const px = precioPar(base, quote, tipo === "futures");
  const retirado = z(d.profitWithdrawn);

  const bot = {
    id: raw.buOrderId, tipo, base, quote, cerrado,
    nombre: raw.customizeName || raw.botName || null,
    creado: n(raw.createTime), cerradoEn: n(raw.closeTime),
    precio: px, retirado: retirado * qUsd,
    top: n(d.top), bottom: n(d.bottom), grillas: n(d.row),
    motivoCierre: d.reasonBy || null,
  };

  if (tipo === "spot") {
    // Supuesto: la inversión es lo configurado en quote + lo configurado en base valorizado
    // al precio de apertura (si invertiste solo USDT, baseTotalInvestment es 0).
    const inversion = (n(d.quoteTotalInvestment) ?? z(d.quoteInvestment)) +
                      (n(d.baseTotalInvestment) ?? z(d.baseInvestment)) * z(d.openPrice);
    bot.inversion = inversion * qUsd;
    bot.profitGrilla = n(d.gridProfit) == null ? null : n(d.gridProfit) * qUsd;
    bot.pnlPionex = n(d.realizedProfit) == null ? null : n(d.realizedProfit) * qUsd;

    if (!cerrado) {
      // Valor hoy = lo que el bot tiene adentro (base a precio de mercado + quote).
      // Lo retirado ya salió del bot: por eso el actual lo excluye y el total lo suma.
      const valor = px == null ? null : z(d.baseAmount) * px + z(d.quoteAmount);
      bot.valor = valor == null ? null : valor * qUsd;
      bot.pnlActual = bot.valor == null ? null : bot.valor - bot.inversion;
      bot.pnlTotal = bot.pnlActual == null ? null : bot.pnlActual + bot.retirado;
    } else {
      // Cerrado: la doc define realizedProfit como "grid profit + float P&L" total.
      // Supuesto: retirar ganancias no lo descuenta (no es una pérdida, es un traspaso).
      bot.valor = 0;
      bot.pnlTotal = bot.pnlPionex;
      bot.pnlActual = null;
    }
  } else {
    bot.trend = d.trend || null;          // long | short | no_trend
    bot.leverage = n(d.leverage);
    bot.liquidacion = n(d.liquidationPrice);
    bot.inversion = z(d.quoteInvestment) * qUsd;
    bot.funding = z(d.fundingFeePayment) * qUsd;          // la doc lo da negativo
    bot.profitGrilla = z(d.profitReduce) * qUsd;

    if (!cerrado) {
      // Supuesto: el signo de `position` no está documentado. En un grid short se
      // fuerza negativo y en long positivo; en neutral se respeta el que venga.
      let pos = z(d.position);
      if (bot.trend === "short") pos = -Math.abs(pos);
      else if (bot.trend === "long") pos = Math.abs(pos);
      bot.posicion = pos;
      bot.precioEntrada = n(d.positionOpenPrice);
      const flotante = px != null && bot.precioEntrada != null ? pos * (px - bot.precioEntrada) * qUsd : null;
      bot.flotante = flotante;
      // Supuesto: profitReduce es acumulado bruto (no descuenta lo retirado).
      bot.pnlTotal = flotante == null ? null : bot.profitGrilla + flotante + bot.funding;
      bot.pnlActual = bot.pnlTotal == null ? null : bot.pnlTotal - bot.retirado;
      bot.valor = bot.pnlActual == null ? null : bot.inversion + bot.pnlActual;
    } else {
      // Cerrado: lo que volvió a la cuenta principal − lo invertido + lo retirado antes.
      const usdtIn = n(d.usdtInvestment), usdtOut = n(d.unlockUsdtAmount);
      const qOut = n(d.unlockQuoteAmount);
      if (usdtIn && usdtOut != null) bot.pnlTotal = usdtOut - usdtIn + bot.retirado;
      else if (qOut != null && n(d.quoteInvestment)) bot.pnlTotal = (qOut - z(d.quoteInvestment)) * qUsd + bot.retirado;
      else bot.pnlTotal = null;
      bot.pnlActual = null;
      bot.valor = 0;
    }
  }
  bot.pnlTotalPct = bot.pnlTotal != null && bot.inversion > 0 ? (bot.pnlTotal / bot.inversion) * 100 : null;
  bot.pnlActualPct = bot.pnlActual != null && bot.inversion > 0 ? (bot.pnlActual / bot.inversion) * 100 : null;
  return bot;
}

export function botsActivos() {
  return (PX.data?.bots?.running || []).map((b) => normalizarBot(b, false)).filter(Boolean)
    .sort((a, b) => (b.valor || 0) - (a.valor || 0));
}

export function botsCerrados() {
  return (PX.data?.bots?.finished || []).map((b) => normalizarBot(b, true)).filter(Boolean)
    .sort((a, b) => (b.cerradoEn || 0) - (a.cerradoEn || 0));
}

const suma = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);

export function resumenBots() {
  const act = botsActivos(), cer = botsCerrados();
  return {
    activos: act, cerrados: cer,
    valor: suma(act, "valor"),
    inversion: suma(act, "inversion"),
    pnlTotal: suma(act, "pnlTotal"),
    pnlActual: suma(act, "pnlActual"),
    pnlCerrados: suma(cer, "pnlTotal"),
    sinPrecio: act.filter((b) => b.valor == null).length,
  };
}
