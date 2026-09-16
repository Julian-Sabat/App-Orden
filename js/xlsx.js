// Escritor de archivos .xlsx, sin dependencias.
//
// Un .xlsx es un ZIP con XMLs adentro. Acá se arma a mano en vez de cargar una
// librería de un CDN: la app es una PWA que tiene que andar offline y el shell del
// service worker no puede cachear lo que no es del propio origen.
//
// El ZIP se escribe sin compresión (método "store"): evita implementar deflate y el
// archivo igual es chico (un portafolio son decenas de KB). Excel, Numbers, LibreOffice
// y Google Sheets lo abren igual — la compresión es opcional en el formato.
//
// Las celdas de texto van "inline" (t="inlineStr"), así no hace falta la tabla de
// sharedStrings ni llevar un índice de cadenas repetidas.

// ---------- ZIP ----------

const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = TABLA_CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fecha/hora en el formato MS-DOS que pide la cabecera del ZIP (segundos en pasos de 2).
function fechaDOS(d) {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const fecha = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { hora, fecha };
}

function zip(archivos) {
  const enc = new TextEncoder();
  const { hora, fecha } = fechaDOS(new Date());
  const items = archivos.map((a) => {
    const nombre = enc.encode(a.name);
    const datos = typeof a.data === "string" ? enc.encode(a.data) : a.data;
    return { nombre, datos, crc: crc32(datos) };
  });

  const tamLocal = items.reduce((s, i) => s + 30 + i.nombre.length + i.datos.length, 0);
  const tamCentral = items.reduce((s, i) => s + 46 + i.nombre.length, 0);
  const buf = new ArrayBuffer(tamLocal + tamCentral + 22);
  const dv = new DataView(buf);
  const out = new Uint8Array(buf);
  let off = 0;

  for (const it of items) {
    it.offset = off;
    dv.setUint32(off, 0x04034b50, true);       // firma local
    dv.setUint16(off + 4, 20, true);           // versión necesaria
    dv.setUint16(off + 6, 0x0800, true);       // flag: nombres en UTF-8
    dv.setUint16(off + 8, 0, true);            // método: store
    dv.setUint16(off + 10, hora, true);
    dv.setUint16(off + 12, fecha, true);
    dv.setUint32(off + 14, it.crc, true);
    dv.setUint32(off + 18, it.datos.length, true);
    dv.setUint32(off + 22, it.datos.length, true);
    dv.setUint16(off + 26, it.nombre.length, true);
    dv.setUint16(off + 28, 0, true);           // sin campo extra
    off += 30;
    out.set(it.nombre, off); off += it.nombre.length;
    out.set(it.datos, off); off += it.datos.length;
  }

  const inicioCentral = off;
  for (const it of items) {
    dv.setUint32(off, 0x02014b50, true);       // firma del directorio central
    dv.setUint16(off + 4, 20, true);
    dv.setUint16(off + 6, 20, true);
    dv.setUint16(off + 8, 0x0800, true);
    dv.setUint16(off + 10, 0, true);
    dv.setUint16(off + 12, hora, true);
    dv.setUint16(off + 14, fecha, true);
    dv.setUint32(off + 16, it.crc, true);
    dv.setUint32(off + 20, it.datos.length, true);
    dv.setUint32(off + 24, it.datos.length, true);
    dv.setUint16(off + 28, it.nombre.length, true);
    dv.setUint16(off + 30, 0, true);
    dv.setUint16(off + 32, 0, true);
    dv.setUint16(off + 34, 0, true);
    dv.setUint16(off + 36, 0, true);
    dv.setUint32(off + 38, 0, true);
    dv.setUint32(off + 42, it.offset, true);
    off += 46;
    out.set(it.nombre, off); off += it.nombre.length;
  }

  dv.setUint32(off, 0x06054b50, true);         // fin del directorio central
  dv.setUint16(off + 8, items.length, true);
  dv.setUint16(off + 10, items.length, true);
  dv.setUint32(off + 12, off - inicioCentral, true);
  dv.setUint32(off + 16, inicioCentral, true);
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ---------- XML ----------

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]))
    // Los caracteres de control rompen el XML y Excel se niega a abrir el archivo.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

// 0 -> A, 25 -> Z, 26 -> AA
function letraCol(i) {
  let s = "";
  for (let n = i + 1; n > 0; ) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Fecha -> número de serie de Excel (días desde 1899-12-30, con la hora como fracción).
// Se usa la hora local: el archivo se mira en el mismo huso en que se generó.
function serie(d) {
  return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569;
}

// Índice de estilo por formato. El orden tiene que coincidir con cellXfs de ESTILOS.
const FORMATOS = { texto: 0, usd: 2, precio: 3, cantidad: 4, pct: 5, fecha: 6, fechahora: 7, entero: 8 };
const FORMATOS_BOLD = { texto: 9, usd: 10 };

const ESTILOS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="7">
<numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/>
<numFmt numFmtId="165" formatCode="#,##0.00######"/>
<numFmt numFmtId="166" formatCode="#,##0.########"/>
<numFmt numFmtId="167" formatCode="0.0%;[Red]-0.0%"/>
<numFmt numFmtId="168" formatCode="dd-mm-yyyy"/>
<numFmt numFmtId="169" formatCode="dd-mm-yyyy hh:mm"/>
<numFmt numFmtId="170" formatCode="#,##0"/>
</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="13"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8ECF1"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFB0B8C4"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="169" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="170" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Una celda puede venir como primitivo o como { v, f, b, head, titulo }.
function celdaXML(ref, celda) {
  if (celda == null || celda === "") return "";
  const o = typeof celda === "object" && !(celda instanceof Date) ? celda : { v: celda };
  const v = o.v;
  if (v == null || v === "") return "";

  let s = 0;
  if (o.head) s = 1;
  else if (o.titulo) s = 11;
  else if (o.b) s = FORMATOS_BOLD[o.f || "texto"] ?? FORMATOS[o.f || "texto"] ?? 9;
  else if (o.f) s = FORMATOS[o.f] ?? 0;

  const attr = ` r="${ref}"${s ? ` s="${s}"` : ""}`;
  if (v instanceof Date) return `<c${attr}><v>${serie(v)}</v></c>`;
  if (typeof v === "number") {
    if (!isFinite(v)) return "";
    return `<c${attr}><v>${v}</v></c>`;
  }
  return `<c${attr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
}

function hojaXML(hoja) {
  const filas = hoja.rows.map((fila, i) => {
    const celdas = fila.map((c, j) => celdaXML(letraCol(j) + (i + 1), c)).join("");
    return celdas ? `<row r="${i + 1}">${celdas}</row>` : `<row r="${i + 1}"/>`;
  }).join("");

  const anchos = (hoja.cols || []).length
    ? `<cols>${hoja.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";

  // Con encabezado: fila 1 congelada y filtros, para que la tabla se pueda ordenar.
  const nCols = hoja.rows.reduce((m, f) => Math.max(m, f.length), 1);
  const vista = hoja.header
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const filtro = hoja.header && hoja.rows.length > 1
    ? `<autoFilter ref="A1:${letraCol(nCols - 1)}${hoja.rows.length}"/>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${vista}<sheetFormatPr defaultRowHeight="15"/>${anchos}<sheetData>${filas}</sheetData>${filtro}</worksheet>`;
}

// Excel no acepta estos caracteres en el nombre de una hoja, ni más de 31 letras.
function nombreHoja(n, usados) {
  let base = String(n).replace(/[\\\/\?\*\[\]:]/g, "-").slice(0, 31) || "Hoja";
  let nombre = base, i = 2;
  while (usados.has(nombre)) {
    const corte = base.slice(0, 31 - String(i).length - 1);
    nombre = `${corte} ${i++}`;
  }
  usados.add(nombre);
  return nombre;
}

// hojas: [{ name, cols: [ancho…], rows: [[celda…]], header: bool }]
export function construirXLSX(hojas) {
  const usados = new Set();
  const hs = hojas.map((h) => ({ ...h, name: nombreHoja(h.name, usados) }));

  const archivos = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${hs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${hs.map((h, i) => `<sheet name="${xmlEsc(h.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${hs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${hs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "xl/styles.xml", data: ESTILOS },
    ...hs.map((h, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: hojaXML(h) })),
  ];

  return zip(archivos);
}

// En iOS —sobre todo con la PWA instalada— un <a download> de un blob no baja nada:
// el sistema espera la hoja de compartir. En el resto de las plataformas el enlace es
// mejor (baja directo, sin diálogo), así que el share se usa solo ahí.
function esIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPad se hace pasar por Mac
}

function porEnlace(blob, nombreArchivo) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombreArchivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Safari necesita que la URL siga viva un instante después del click.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Devuelve "compartido" | "descargado". No es async a propósito: en iOS, navigator.share
// tiene que llamarse dentro del mismo gesto del usuario, sin ningún await antes.
export function descargarXLSX(nombreArchivo, hojas) {
  const blob = construirXLSX(hojas);
  const tipo = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (esIOS() && navigator.canShare) {
    try {
      const file = new File([blob], nombreArchivo, { type: tipo });
      if (navigator.canShare({ files: [file] })) {
        // Si el usuario cancela la hoja de compartir, se baja por enlace igual.
        navigator.share({ files: [file] }).catch((e) => {
          if (e && e.name === "AbortError") return;
          porEnlace(blob, nombreArchivo);
        });
        return "compartido";
      }
    } catch (e) { /* sin soporte de archivos: sigue por enlace */ }
  }
  porEnlace(blob, nombreArchivo);
  return "descargado";
}
