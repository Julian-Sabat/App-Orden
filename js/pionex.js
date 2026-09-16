// Pionex: saldos spot y bots (spot grid y futures grid), leídos en vivo.
//
// La app nunca ve la API key: llama a la Edge Function "pionex" de Supabase, que
// firma los requests y devuelve la respuesta cruda. Acá se normaliza y se calcula.
//
// PnL de un bot activo, en dos versiones:
//   - PnL actual: lo que vale hoy el bot menos lo invertido. Baja cuando retiras
//     ganancias de la grilla, porque esa plata ya no está dentro del bot.
//   - PnL total: el actual + todo lo retirado. Retirar no lo mueve.
//
// Fórmulas validadas contra la respuesta real de la cuenta (2026-09-15), no solo la doc:
// la API trae campos no documentados (totalRealizedProfit, profitExited, gridProfit en
// futuros) y `quoteInvestment` crece al reinvertir ganancias. En futuros, el cálculo por
// caja de abajo coincide con el propio de Pionex (totalRealizedProfit + funding + no
// realizado) con 1-2 USD de diferencia, que son comisiones. Ver "Supuesto" para lo que
// no se pudo contrastar (spot grid: no hay bots activos para comparar).

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
    // Verificado: el ticker perpetuo es "SOL_USDT_PERP" (y el bot trae base "SOL.PERP").
    const v = pp[`${base}_${quote}_PERP`];
    if (v != null) return v;
  }
  if (sp[`${base}_${quote}`] != null) return sp[`${base}_${quote}`];
  const b = usdDe(base), q = usdDe(quote);
  return b != null && q ? b / q : null;
}

// Costo de un saldo spot, reconstruido con las órdenes de la cuenta (promedio móvil,
// igual que el portafolio de CoinMarketCap). La comisión se cobra en la moneda comprada,
// así que se descuenta de lo recibido: verificado contra el saldo real de la cuenta.
export function costoDe(coin) {
  const ord = PX.data?.ordenes?.[`${coin}_USDT`];
  if (!ord?.length) return null;
  const cron = [...ord].sort((a, b) => z(a.createTime) - z(b.createTime));
  let qty = 0, cost = 0, realized = 0, buyQty = 0, buyCost = 0;
  for (const o of cron) {
    const size = z(o.filledSize), monto = z(o.filledAmount);
    if (size <= 0) continue;
    const feeBase = o.feeCoin === coin ? z(o.fee) : 0;
    const feeQuote = o.feeCoin && o.feeCoin !== coin ? z(o.fee) : 0;
    if (o.side === "BUY") {
      const recibido = size - feeBase;
      qty += recibido; cost += monto + feeQuote;
      buyQty += recibido; buyCost += monto + feeQuote;
    } else {
      const avg = qty > 1e-12 ? cost / qty : 0;
      const usado = Math.min(size, Math.max(qty, 0));
      realized += monto - feeQuote - avg * usado;
      qty -= size; cost -= avg * usado;
    }
  }
  const avg = qty > 1e-9 ? cost / qty : buyQty > 0 ? buyCost / buyQty : null;
  return { qty, cost, realized, avg, nOrdenes: cron.length };
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
  // Los bots de futuros traen base "SOL.PERP": sin limpiarlo no se encuentra el precio.
  const base = String(raw.base || d.base || "").replace(/\.PERP$/i, "");
  const quote = raw.quote || d.quote;
  const qUsd = usdDe(quote) ?? 1;
  const px = precioPar(base, quote, tipo === "futures");

  const bot = {
    id: raw.buOrderId, tipo, base, quote, cerrado,
    nombre: raw.customizeName || raw.botName || null,
    creado: n(raw.createTime), cerradoEn: n(raw.closeTime),
    precio: px,
    top: n(d.top), bottom: n(d.bottom), grillas: n(d.row),
    motivoCierre: d.reasonBy || null,
    profitGrilla: n(d.gridProfit) == null ? null : n(d.gridProfit) * qUsd,
  };

  if (tipo === "spot") {
    // Con reinversión automática la ganancia figura como retirada pero vuelve al bot:
    // sumarla otra vez la contaría doble. Supuesto: solo un bot spot cerrado para ver esto.
    const reinvertido = d.profitAutoReinvest ? z(d.profitReinvest) : 0;
    bot.retirado = Math.max(0, z(d.profitWithdrawn) - reinvertido) * qUsd;
    // usdtInvestment es lo que salió de tu cuenta. baseInvestment NO se suma: es la parte
    // de esa misma inversión que el bot convirtió a base al arrancar.
    bot.inversion = n(d.usdtInvestment) ||
      (z(d.quoteTotalInvestment) + z(d.baseTotalInvestment) * z(d.openPrice)) * qUsd;

    if (!cerrado) {
      // Supuesto (sin bots spot activos para contrastar): valor = lo que el bot tiene adentro.
      const valor = px == null ? null : z(d.baseAmount) * px + z(d.quoteAmount);
      bot.valor = valor == null ? null : valor * qUsd;
      bot.pnlActual = bot.valor == null ? null : bot.valor - bot.inversion;
      bot.pnlTotal = bot.pnlActual == null ? null : bot.pnlActual + bot.retirado;
    } else {
      // realizedProfit llega en 0 en un bot cerrado real: se usa lo que volvió a la cuenta.
      const salio = n(d.unlockUsdtAmount);
      bot.pnlTotal = salio != null ? salio + bot.retirado - bot.inversion : n(d.realizedProfit);
      bot.pnlActual = null;
      bot.valor = 0;
    }
  } else {
    bot.trend = d.trend || null;          // long | short | no_trend
    bot.leverage = n(d.leverage);
    // liquidationPrice llega en 0 mientras el bot corre: el precio real está en el estimado,
    // hacia abajo en un grid long y hacia arriba en uno short.
    bot.liquidacion = n(d.liquidationPrice) ||
      (d.trend === "short" ? n(d.estimateLiquidationPriceUp) : n(d.estimateLiquidationPriceDown)) || null;
    bot.funding = z(d.fundingFeePayment) * qUsd;          // viene negativo
    bot.retirado = z(d.profitWithdrawn) * qUsd;
    bot.bono = d.investmentFrom === "FUTURE_GRID_BONUS";
    if (bot.profitGrilla == null) bot.profitGrilla = z(d.profitReduce) * qUsd;
    // El profit de grilla del campo es bruto. La app de Pionex muestra solo la parte que
    // sigue adentro: bruto − retirado − reinvertido (verificado contra la app).
    bot.profitGrillaDentro = bot.profitGrilla == null ? null
      : bot.profitGrilla - bot.retirado - z(d.profitReinvest) * qUsd;
    // Inversión como la muestra la app (incluye lo reinvertido y el margen agregado).
    bot.inversion = z(d.quoteInvestment) * qUsd;
    // Capital neto para el cálculo por caja: descuenta la ganancia que se movió a inversión.
    const capital = (z(d.quoteInvestment) - z(d.profitExited) + z(d.extraMargin)) * qUsd;
    const pionex = n(d.totalRealizedProfit);
    // De dónde salió ese capital: lo puesto al crear el bot vs lo agregado después.
    // `profitExited` (ganancia movida a la inversión) queda aparte: infla quoteInvestment
    // pero no es plata tuya. Cuadre verificado contra la cuenta real (2026-09-16):
    // marginBalance ≈ capital + totalRealizedProfit + funding − retirado, con residuo ≈ totalFee.
    bot.capital = capital;
    bot.capInicial = (n(d.initQuoteInvestment) ?? z(d.initUsdtInvestment)) * qUsd;
    bot.capAgregado = capital - bot.capInicial;     // negativo si sacaste capital
    bot.reinvertido = z(d.profitExited) * qUsd;

    if (!cerrado) {
      // Supuesto: todos los bots reales son long con position positiva; en short se fuerza negativa.
      let pos = z(d.position);
      if (bot.trend === "short") pos = -Math.abs(pos);
      else if (bot.trend === "long") pos = Math.abs(pos);
      bot.posicion = pos;
      bot.precioEntrada = n(d.positionOpenPrice);
      const flotante = px != null && bot.precioEntrada != null ? pos * (px - bot.precioEntrada) * qUsd : null;
      bot.flotante = flotante;
      // Valor hoy = margen (caja del bot, ya descuenta lo retirado) + PnL no realizado.
      bot.valor = flotante == null ? null : z(d.marginBalance) * qUsd + flotante;
      // PnL total = el mismo número que la app de Pionex muestra como "ganancia total"
      // (verificado contra la app). Ni retirar ni reinvertir lo bajan: Pionex mueve esa
      // ganancia a la inversión, pero la sigue contando acá.
      const porCaja = flotante == null ? null : bot.valor + bot.retirado - capital;
      bot.pnlCaja = porCaja;
      bot.pnlTotal = pionex == null || flotante == null ? porCaja
                   : pionex * qUsd + bot.funding + flotante;
      // Actual = lo que queda dentro del bot, sin lo ya retirado a la cuenta.
      bot.pnlActual = bot.pnlTotal == null ? null : bot.pnlTotal - bot.retirado;
    } else {
      if (bot.bono) {
        // Bot con bono de Pionex: el capital no era tuyo, lo que volvió no sirve para medir.
        bot.pnlTotal = pionex == null ? null : (pionex - z(d.bonusFee)) * qUsd + bot.funding;
        bot.inversion = 0;
      } else {
        // Lo que volvió a la cuenta + lo retirado antes − el capital puesto.
        const salio = n(d.unlockUsdtAmount) ?? n(d.marginBalance);
        bot.pnlTotal = salio != null ? salio * qUsd + bot.retirado - capital
                     : pionex == null ? null : pionex * qUsd + bot.funding;
      }
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
