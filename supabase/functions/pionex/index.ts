// Supabase Edge Function "pionex" — lectura de la cuenta de Pionex para App Orden.
//
// Por qué existe: la API privada de Pionex exige firmar cada request con HMAC-SHA256
// usando el API secret. Ese secret no puede vivir en el browser (quedaría expuesto en
// una app pública), así que la firma se hace acá y la app solo recibe el resultado.
//
// Solo lectura: la key debe crearse en Pionex con "Enable reading" + "Bot reading" y
// NADA más (sin trading, sin transfer). La función únicamente hace GET.
//
// Deploy (editor web de Supabase):
//   1. Dashboard → Edge Functions → Deploy a new function → Via Editor, nombre: pionex
//   2. Pegar este archivo completo y Deploy.
//   3. Edge Functions → Secrets: PIONEX_API_KEY y PIONEX_API_SECRET.
//
// Devuelve { at, balances, bots: { running, finished }, tickers: { spot, perp }, errores }.
// Los cálculos de PnL se hacen en la app (js/pionex.js), no acá.

const PIONEX = "https://api.pionex.com";
const MAX_PAGINAS = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Solo el usuario logueado de la app puede usar la función: se valida su token
// contra Supabase Auth. Sin esto, cualquiera con la URL leería la cuenta.
async function usuarioValido(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return false;
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return false;
  const r = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: auth, apikey: anon } });
  if (!r.ok) return false;
  const u = await r.json().catch(() => null);
  return !!u?.id;
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Firma según la doc oficial: METHOD + PATH + "?" + query ordenada por clave (ASCII),
// sin URL-encode, incluyendo timestamp en ms. Verificado contra el ejemplo de la doc.
async function getPrivado(path: string, params: Record<string, string>, key: string, secret: string) {
  const p: Record<string, string> = { ...params, timestamp: String(Date.now()) };
  const claves = Object.keys(p).sort();
  const firmado = claves.map((k) => `${k}=${p[k]}`).join("&");
  const enviado = claves.map((k) => `${k}=${encodeURIComponent(p[k])}`).join("&");
  const firma = await hmacHex(secret, `GET${path}?${firmado}`);
  const r = await fetch(`${PIONEX}${path}?${enviado}`, {
    headers: { "PIONEX-KEY": key, "PIONEX-SIGNATURE": firma },
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.result === false) {
    throw new Error(`${path}: ${j?.code ?? r.status} ${j?.message ?? ""}`.trim());
  }
  return j.data;
}

async function getPublico(path: string) {
  const r = await fetch(`${PIONEX}${path}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.result === false) throw new Error(`${path}: ${j?.code ?? r.status}`);
  return j.data;
}

async function bots(status: "running" | "finished", key: string, secret: string) {
  const out: unknown[] = [];
  let pageToken = "";
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const params: Record<string, string> = { status };
    if (pageToken) params.pageToken = pageToken;
    const data = await getPrivado("/api/v1/bot/orders", params, key, secret);
    for (const b of data?.results ?? []) {
      // Se descartan userId/keyId: la app no los necesita.
      out.push({
        buOrderType: b.buOrderType, buOrderId: b.buOrderId, base: b.base, quote: b.quote,
        status: b.status, createTime: b.createTime, closeTime: b.closeTime,
        customizeName: b.customizeName, botName: b.botName, buOrderData: b.buOrderData,
      });
    }
    pageToken = data?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

function mapaTickers(data: any): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of data?.tickers ?? []) {
    const v = Number(t.close);
    if (t.symbol && isFinite(v)) m[t.symbol] = v;
  }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!(await usuarioValido(req))) return json({ error: "No autorizado" }, 401);

  const key = Deno.env.get("PIONEX_API_KEY");
  const secret = Deno.env.get("PIONEX_API_SECRET");
  if (!key || !secret) {
    return json({ error: "Faltan los secrets PIONEX_API_KEY / PIONEX_API_SECRET en Supabase" }, 500);
  }

  // Cada bloque puede fallar por separado (p.ej. key sin "Bot reading"): lo que sí
  // se pudo leer se devuelve igual, con el motivo del resto en `errores`.
  const errores: string[] = [];
  const intento = <T>(p: Promise<T>, vacio: T) =>
    p.catch((e) => { errores.push(String(e?.message ?? e)); return vacio; });

  const [bal, running, spot, perp] = await Promise.all([
    intento(getPrivado("/api/v1/account/balances", {}, key, secret), null),
    intento(bots("running", key, secret), [] as unknown[]),
    intento(getPublico("/api/v1/market/tickers"), null),
    intento(getPublico("/api/v1/market/tickers?type=PERP"), null),
  ]);
  // Cerrados después, en serie: pueden ser varias páginas y el límite es 10 req/s.
  const finished = await intento(bots("finished", key, secret), [] as unknown[]);

  return json({
    at: Date.now(),
    balances: (bal?.balances ?? []).map((b: any) => ({ coin: b.coin, free: b.free, frozen: b.frozen })),
    bots: { running, finished },
    tickers: { spot: mapaTickers(spot), perp: mapaTickers(perp) },
    errores,
  });
});
