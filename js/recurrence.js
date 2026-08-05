// Cálculo de recurrencias. Fechas como strings 'YYYY-MM-DD' en hora local.

export function todayStr() {
  const d = new Date();
  return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// Suma meses conservando el día objetivo, con clamp a fin de mes (31 ene + 1 mes = 28/29 feb)
function addMonths(s, n, targetDay) {
  const d = parseDate(s);
  const day = targetDay || d.getDate();
  let y = d.getFullYear();
  let m = d.getMonth() + 1 + n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12) + 1;
  return fmt(y, m, Math.min(day, daysInMonth(y, m)));
}

// Avanza una ocurrencia según la regla
export function nextOccurrence(dateStr, rule) {
  switch (rule.tipo) {
    case "diaria": return addDays(dateStr, 1);
    case "semanal": return addDays(dateStr, 7);
    case "quincenal": return addDays(dateStr, 14);
    case "mensual": return addMonths(dateStr, 1, rule.dia_ancla);
    case "trimestral": return addMonths(dateStr, 3, rule.dia_ancla);
    case "anual": return addMonths(dateStr, 12, rule.dia_ancla);
    case "dia_del_mes": return addMonths(dateStr, 1, rule.dia);
    default: return addDays(dateStr, 1);
  }
}

// Tras completar: avanza desde la fecha debida hasta quedar estrictamente después de hoy.
// Mantiene el calendario anclado (mensual del 5 sigue siendo el 5) aunque se complete tarde.
export function advancePastToday(dateStr, rule, today) {
  let next = dateStr;
  let guard = 0;
  while (next <= today && guard < 5000) {
    next = nextOccurrence(next, rule);
    guard++;
  }
  return next;
}

// Primera ocurrencia para una tarea nueva de tipo dia_del_mes (hoy o el próximo día N)
export function firstDayOfMonthOccurrence(dia, today) {
  const d = parseDate(today);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const candidate = fmt(y, m, Math.min(dia, daysInMonth(y, m)));
  return candidate >= today ? candidate : addMonths(candidate, 1, dia);
}

export function describeRecurrence(rule) {
  if (!rule) return "";
  switch (rule.tipo) {
    case "diaria": return "cada día";
    case "semanal": return "cada semana";
    case "quincenal": return "cada 15 días";
    case "mensual": return "cada mes";
    case "trimestral": return "cada 3 meses";
    case "anual": return "cada año";
    case "dia_del_mes": return `los días ${rule.dia} de cada mes`;
    default: return "";
  }
}
