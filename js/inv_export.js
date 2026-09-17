// Exportación de la sección Inversiones a un .xlsx.
//
// Arma las hojas con los mismos cálculos que muestra la app (no re-implementa nada:
// usa positions/resumen de inversiones.js y los bots normalizados de pionex.js), y
// delega el armado del archivo en xlsx.js.
//
// Alcance: SIEMPRE el portafolio completo, sin importar el grupo filtrado en pantalla,
// y con los montos reales aunque el modo privacidad esté activo — el archivo es local.

import * as INVM from "./inversiones.js";
import * as PXM from "./pionex.js";
import { descargarXLSX } from "./xlsx.js";

// Ojo: INV y PIONEX se leen a través de INVM dentro de las funciones, nunca se
// desestructuran acá arriba. inversiones.js importa este módulo y este importa aquel:
// con ese ciclo, al evaluarse este archivo los bindings del otro todavía no existen.

const TIPO_LABEL = { buy: "Compra", sell: "Venta", transferIn: "Entrada", transferOut: "Salida" };
const TIPO_BOT = { spot: "Spot grid", futures: "Futures grid" };
const TREND = { long: "Long", short: "Short", no_trend: "Neutral" };
const MOTIVO = { user_cancel: "Cerrado por el usuario", loss_stop: "Stop loss", profit_stop: "Take profit",
                 force_liquidation: "Liquidado", not_enough_balance: "Sin saldo", create_failed: "Falló al crear" };

// Celdas: los porcentajes se guardan como fracción porque el formato de Excel es 0.0%.
const usd = (v) => (v == null || !isFinite(v) ? null : { v, f: "usd" });
const num = (v, f) => (v == null || !isFinite(v) ? null : { v, f });
// El formato de cantidad siempre pinta el separador decimal ("60.000,"), así que a los
// enteros se les da el formato sin decimales.
const qty = (v) => (v == null || !isFinite(v) ? null : { v, f: Number.isInteger(v) ? "entero" : "cantidad" });
const pct = (v) => (v == null || !isFinite(v) ? null : { v: v / 100, f: "pct" });
const fecha = (v) => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? null : { v: d, f: "fechahora" };
};
const head = (arr) => arr.map((t) => ({ v: t, head: true }));
const titulo = (t) => [{ v: t, titulo: true }];
const par = (label, celda) => [{ v: label, b: true }, celda];

function pionexActivo() {
  return PXM.PX.disponible !== false && !!PXM.PX.data;
}

// Grupos de CoinMarketCap (los de Pionex se tratan aparte: no tienen base de costo propia).
function gruposCMC() {
  return [...new Set(INVM.INV.transactions.map(INVM.grupoDe))].sort();
}

// ---------- Hoja: Resumen ----------

function hojaResumen() {
  const r = INVM.resumen();
  const total = r.valor;
  const rows = [];

  rows.push(titulo("Inversiones — resumen"));
  rows.push(par("Generado", fecha(new Date())));
  rows.push(par("Precios de", fecha(INVM.INV.pricesAt)));
  if (pionexActivo()) rows.push(par("Datos de Pionex", fecha(PXM.PX.at)));
  rows.push([]);

  rows.push(par("Patrimonio neto", { v: r.neto, f: "usd", b: true }));
  rows.push(par("Valor del portafolio", usd(r.valor)));
  rows.push(par("Deuda", usd(r.debt)));
  if (INVM.INV.settings?.debt_note) rows.push(par("Nota de la deuda", INVM.INV.settings.debt_note));
  rows.push([]);

  rows.push(par("Costo de las posiciones abiertas", usd(r.costo)));
  rows.push(par("PnL no realizado", usd(r.unrealized)));
  rows.push(par("PnL realizado", usd(r.realized)));
  if (r.sinPrecio) rows.push(par("Posiciones sin precio", num(r.sinPrecio, "entero")));
  rows.push([]);

  rows.push(titulo("Por grupo"));
  rows.push(head(["Grupo", "Valor", "Costo", "PnL no realizado", "PnL realizado", "Peso"]));
  for (const g of INVM.grupos()) {
    const rg = INVM.resumen(g.key);
    rows.push([g.label, usd(rg.valor), usd(rg.costo), usd(rg.unrealized), usd(rg.realized),
               pct(total > 0 ? (rg.valor / total) * 100 : null)]);
  }
  rows.push([{ v: "Total", b: true }, { v: r.valor, f: "usd", b: true }, { v: r.costo, f: "usd", b: true },
             { v: r.unrealized, f: "usd", b: true }, { v: r.realized, f: "usd", b: true },
             total > 0 ? { v: 1, f: "pct", b: true } : null]);

  if (pionexActivo()) {
    const rp = INVM.resumen(INVM.PIONEX);
    const b = rp.bots;
    rows.push([]);
    rows.push(titulo("Pionex"));
    rows.push(par("Valor de los bots activos", usd(b.valor)));
    rows.push(par("Saldo spot", usd(rp.valorSpot)));
    rows.push(par("Inversión en bots activos", usd(b.inversion)));
    rows.push(par("PnL total de bots activos", usd(b.pnlTotal)));
    rows.push(par("PnL actual de bots activos", usd(b.pnlActual)));
    rows.push(par("PnL de bots cerrados", usd(b.pnlCerrados)));
    rows.push(par("Bots activos", num(b.activos.length, "entero")));
    rows.push(par("Bots cerrados", num(b.cerrados.length, "entero")));
    if (PXM.PX.error) rows.push(par("Aviso de la API", PXM.PX.error));
  }

  return { name: "Resumen", cols: [34, 16, 16, 18, 16, 10], rows };
}

// ---------- Hoja: Estado actual ----------

const COLS_ESTADO = [
  "Grupo", "Tipo", "Símbolo", "Nombre", "Cantidad", "Precio", "Valor", "Peso",
  "Costo", "Costo prom.", "PnL no realizado", "% no realizado", "PnL realizado", "PnL total",
  "1d", "7d", "30d", "Movimientos",
  "Capital inicial", "Agregado después", "Ganancia reinvertida", "Profit de grilla",
  "Retirado", "Funding", "Comisiones", "Precio de entrada", "Liquidación", "Rango", "Grillas", "Creado",
];

function filaToken(grupo, p, total) {
  const px = INVM.INV.prices[p.symbol] || {};
  return [
    grupo, "Token", p.symbol, p.name || null,
    qty(p.qty), num(p.price, "precio"), usd(p.value),
    pct(total > 0 && p.value != null ? (p.value / total) * 100 : null),
    usd(p.cost), num(p.avgCost, "precio"),
    usd(p.unrealized), pct(p.unrealizedPct), usd(p.realized),
    usd((p.realized || 0) + (p.unrealized || 0)),
    pct(px.change24h), pct(px.change7d), pct(px.change30d),
    num(p.nTx, "entero"),
  ];
}

function filaBot(grupo, b, total) {
  const dir = b.tipo === "futures"
    ? [TREND[b.trend] || b.trend, b.leverage ? b.leverage + "x" : ""].filter(Boolean).join(" ")
    : "";
  const rango = b.bottom != null && b.top != null ? `${b.bottom} – ${b.top}` : null;
  return [
    grupo, "Bot", `${b.base}/${b.quote}`, [TIPO_BOT[b.tipo], dir, b.nombre].filter(Boolean).join(" · "),
    qty(b.posicion), num(b.precio, "precio"), usd(b.valor),
    pct(total > 0 && b.valor != null ? (b.valor / total) * 100 : null),
    usd(b.inversion), null,
    usd(b.pnlActual), pct(b.pnlActualPct), usd(b.retirado), usd(b.pnlTotal),
    null, null, null, null,
    usd(b.capInicial), usd(b.capAgregado), usd(b.reinvertido), usd(b.profitGrilla),
    usd(b.retirado), usd(b.funding), usd(b.comisiones), num(b.precioEntrada, "precio"), num(b.liquidacion, "precio"),
    rango, num(b.grillas, "entero"), fecha(b.creado),
  ];
}

function hojaEstado() {
  const total = INVM.resumen().valor;
  const rows = [head(COLS_ESTADO)];

  for (const key of gruposCMC()) {
    const label = INVM.labelGrupo(key);
    for (const p of INVM.positions(key)) {
      if (!p.abierta || p.hidden) continue;       // ocultas: fuera, igual que en la app
      rows.push(filaToken(label, p, total));
    }
  }

  if (pionexActivo()) {
    const label = INVM.labelGrupo(INVM.PIONEX);
    const rp = INVM.resumen(INVM.PIONEX);
    for (const p of rp.pos) rows.push(filaToken(label, p, total));
    for (const b of rp.bots.activos) rows.push(filaBot(label, b, total));
  }

  const cols = [16, 8, 12, 26, 14, 13, 13, 9, 13, 13, 16, 14, 14, 13, 9, 9, 9, 12,
                14, 16, 18, 15, 13, 12, 13, 15, 13, 22, 9, 17];
  return { name: "Estado actual", cols, rows, header: true };
}

// ---------- Hoja: Cerrados ----------

function hojaCerrados() {
  const rows = [head(["Grupo", "Símbolo", "Nombre", "PnL realizado", "Comprado (USD)",
                      "Cantidad comprada", "Costo prom. de compra", "Movimientos",
                      "Primer movimiento", "Último movimiento"])];
  for (const key of gruposCMC()) {
    const label = INVM.labelGrupo(key);
    for (const p of INVM.positions(key)) {
      if (p.abierta || !p.nTx) continue;
      rows.push([label, p.symbol, p.name || null, usd(p.realized), usd(p.buyCost),
                 qty(p.buyQty), num(p.avgCMC, "precio"), num(p.nTx, "entero"),
                 fecha(p.first), fecha(p.last)]);
    }
  }
  return { name: "Cerrados", cols: [16, 12, 26, 15, 16, 18, 20, 13, 18, 18], rows, header: true };
}

// ---------- Hoja: Bots cerrados ----------

function hojaBotsCerrados() {
  const rows = [head(["Par", "Tipo", "Dirección", "Apalancamiento", "Creado", "Cerrado", "Días",
                      "Motivo de cierre", "Inversión", "Retirado", "Profit de grilla",
                      "PnL total", "PnL %", "Con bono", "Nombre", "ID"])];
  for (const b of PXM.botsCerrados()) {
    const d = b.creado ? Math.max(0, Math.floor(((b.cerradoEn || Date.now()) - b.creado) / 86400000)) : null;
    rows.push([
      `${b.base}/${b.quote}`, TIPO_BOT[b.tipo] || b.tipo,
      b.tipo === "futures" ? TREND[b.trend] || b.trend : null,
      b.leverage ? b.leverage + "x" : null,
      fecha(b.creado), fecha(b.cerradoEn), num(d, "entero"),
      MOTIVO[b.motivoCierre] || b.motivoCierre || null,
      usd(b.inversion), usd(b.retirado), usd(b.profitGrilla),
      usd(b.pnlTotal), pct(b.pnlTotalPct), b.bono ? "Sí" : "No",
      b.nombre || null, b.id ? String(b.id) : null,
    ]);
  }
  return { name: "Bots cerrados", cols: [14, 13, 11, 15, 17, 17, 7, 22, 13, 12, 15, 13, 10, 10, 22, 22],
           rows, header: true };
}

// ---------- Hoja: Movimientos ----------

// Las órdenes spot de Pionex se leen en vivo de su API (no están en inv_transactions),
// pero son movimientos igual: van a la misma hoja, marcadas con origen "Pionex".
function movimientosPionex() {
  const ordenes = PXM.PX.data?.ordenes || {};
  const out = [];
  for (const [symbol, lista] of Object.entries(ordenes)) {
    const coin = symbol.replace(/_USDT$/, "");
    for (const o of lista || []) {
      const size = Number(o.filledSize) || 0;
      if (size <= 0) continue;
      const monto = Number(o.filledAmount) || 0;
      out.push({
        ts: Number(o.createTime) || null,
        grupo: INVM.labelGrupo(INVM.PIONEX),
        tipo: o.side === "BUY" ? "Compra" : "Venta",
        symbol: coin, name: null, qty: size, price: size > 0 ? monto / size : null,
        total: monto, fee: Number(o.fee) || 0, feeCoin: o.feeCoin || null,
        origen: "Pionex", notas: o.status && o.status !== "CLOSED" ? `Estado: ${o.status}` : null,
      });
    }
  }
  return out;
}

function hojaMovimientos() {
  const movs = INVM.INV.transactions.map((t) => {
    const qty = Number(t.amount) || 0;
    let total = t.total_value == null ? null : Number(t.total_value);
    if (total == null && t.price != null) total = Number(t.price) * qty;
    return {
      ts: t.ts, grupo: INVM.labelGrupo(INVM.grupoDe(t)),
      tipo: TIPO_LABEL[t.type] || t.type, symbol: t.symbol, name: t.name || null,
      qty, price: t.price == null ? null : Number(t.price), total,
      fee: Number(t.fee) || 0, feeCoin: t.fee_currency || null,
      origen: t.source === "cmc" ? "CoinMarketCap" : "Manual", notas: t.notes || null,
    };
  });

  if (pionexActivo()) movs.push(...movimientosPionex());
  movs.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));

  const rows = [head(["Fecha", "Grupo", "Tipo", "Símbolo", "Nombre", "Cantidad", "Precio",
                      "Total (USD)", "Comisión", "Moneda comisión", "Origen", "Notas"])];
  for (const m of movs) {
    rows.push([fecha(m.ts), m.grupo, m.tipo, m.symbol, m.name,
               qty(m.qty), num(m.price, "precio"), usd(m.total),
               num(m.fee, "precio"), m.feeCoin, m.origen, m.notas]);
  }
  return { name: "Movimientos", cols: [17, 16, 10, 12, 22, 16, 13, 13, 12, 15, 15, 30], rows, header: true };
}

// ---------- Entrada ----------

export function exportarInversiones() {
  const hojas = [hojaResumen(), hojaEstado(), hojaCerrados()];
  if (pionexActivo() && PXM.botsCerrados().length) hojas.push(hojaBotsCerrados());
  hojas.push(hojaMovimientos());

  const hoy = new Date();
  const nombre = `Inversiones_${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}.xlsx`;
  const via = descargarXLSX(nombre, hojas);
  return { nombre, hojas: hojas.length, via };
}
