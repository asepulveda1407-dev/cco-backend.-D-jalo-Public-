'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const AUTH_SECRET = process.env.AUTH_SECRET || 'cco-dev-secret-change-me';
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(__dirname, 'data', 'cco-state.json'));
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: APP_ORIGIN ? [APP_ORIGIN] : true,
    credentials: false,
  },
});

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // CDN scripts are used by the pilot frontend. Tighten in corporate deployment.
  crossOriginEmbedderPolicy: false,
}));
app.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));
app.use(cors({ origin: APP_ORIGIN ? APP_ORIGIN : true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(PUBLIC_DIR, { maxAge: NODE_ENV === 'production' ? '1h' : 0 }));

const DEFAULT_STATE = {
  version: 1,
  datasets: {
    turnos: { datos: [], metadatos: null },
    citaciones: { datos: [], metadatos: null },
    logeo: { datos: [], metadatos: null },
  },
  plantas: {},
  bitacora: [],
  audit: [],
};

let state = loadState();

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      datasets: { ...structuredClone(DEFAULT_STATE.datasets), ...(parsed.datasets || {}) },
      plantas: parsed.plantas || {},
      bitacora: Array.isArray(parsed.bitacora) ? parsed.bitacora : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (err) {
    console.error('No se pudo leer persistencia; se inicia estado limpio:', err.message);
    return structuredClone(DEFAULT_STATE);
  }
}

let persistTimer = null;
function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.error('Error persistiendo estado:', err.message);
    }
  }, 100);
}

function nowIso() { return new Date().toISOString(); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round1(n) { return Number.isFinite(n) ? Math.round(n * 10) / 10 : null; }
function safeText(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  return value.replace(/[<>]/g, '').trim();
}
function normalizeKey(key) {
  return String(key ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function normalizeName(v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}
function normalizeId(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\.0$/, '');
}
function normalizeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) out[normalizeKey(k)] = typeof v === 'string' ? safeText(v) : v;
    return out;
  });
}
function pick(row, aliases) {
  for (const alias of aliases) {
    const k = normalizeKey(alias);
    const v = row?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return null;
}

const FIELDS = {
  id: ['id_operador','id operador','numero_funcionario','número funcionario','numero funcionario','id','rut','codigo_operador','cod_operador'],
  nombre: ['operador','nombre_operador','nom_operador','operario','nombre','employee_name','nombre_funcionario','nombre empleado','nombre_empleado'],
  firstName: ['primero_empleado','primero empleado','first_name','firstname','nombre_funcionario','nombre funcionario'],
  lastName: ['ultimo_empleado','último empleado','ultimo empleado','last_name','lastname','apellido_funcionario','apellido funcionario'],
  planta: ['planta','planta_origen','origen','plta','descripcion_planta','descripción planta','plant'],
  zona: ['zona','region','región'],
  turno: ['turno_inicio','hora_inicio','hora_ingreso','hora ingreso','horaingreso','turno','inicio_turno'],
  citacion: ['citacion','citación','cita','hora_citacion','hora citacion','citacion_sugerida','citación sugerida'],
  logeo: ['logeo','marcacion','marcación','hora_logeo','hora logeo','entrada','login','fecha_hora','fecha hora'],
  estado: ['descripcion_estado','descripción estado','estado','status','status_description','descripcion status','descripción status'],
  fecha: ['fecha','fecha_turno','fecha turno','dia_fecha','día_fecha','date','fecha_programada','fecha programada'],
  diaSemana: ['dia','día','dia_semana','día_semana','day','weekday'],
  timestamp: [
    'timestamp','fecha_hora','fecha hora','fecha','hora_evento','fecha_evento',
    'fecha estado','fecha_estado','hora estado','hora_estado','inicio estado','inicio_estado',
    'fecha inicio','fecha_inicio','hora inicio','hora_inicio','date time','datetime','event time'
  ],
};

// StatusBreakdown puede traer la fecha/hora con nombres distintos según la exportación.
// Esta función busca primero los alias conocidos y, si no existen, detecta de forma
// conservadora columnas cuyo encabezado parece corresponder a fecha/hora/evento.
function getEventTimeValue(row) {
  const direct = pick(row, FIELDS.timestamp) ?? pick(row, FIELDS.logeo);
  if (direct !== null && direct !== undefined && direct !== '') return direct;

  const preferred = [];
  const fallback = [];
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined || String(value).trim() === '') continue;
    const k = normalizeKey(key);
    const looksTemporal = /(fecha|hora|time|date|timestamp|inicio|evento|estado)/.test(k);
    if (!looksTemporal) continue;
    const valid = parseTimeMinutes(value) !== null || asDate(value) !== null;
    if (!valid) continue;
    if (/(fecha.*hora|hora.*fecha|timestamp|datetime|event.*time|fecha.*evento|hora.*evento|inicio.*estado|fecha.*estado|hora.*estado)/.test(k)) preferred.push(value);
    else fallback.push(value);
  }
  return preferred[0] ?? fallback[0] ?? null;
}

function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value)) return value;
  if (typeof value === 'number') {
    // Excel serial date fallback.
    if (value > 20_000 && value < 80_000) return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    if (value >= 0 && value < 1) return new Date(Date.UTC(1970, 0, 1) + value * 86400000);
  }
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d)) return d;
  const hhmm = parseTimeMinutes(s);
  if (hhmm !== null) {
    const out = new Date();
    out.setHours(Math.floor(hhmm / 60), hhmm % 60, 0, 0);
    return out;
  }
  return null;
}

function parseTimeMinutes(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (value >= 0 && value < 1) return Math.round(value * 1440) % 1440;
    if (Number.isInteger(value) && value >= 0 && value <= 2359) {
      const h = Math.floor(value / 100), m = value % 100;
      if (h <= 23 && m <= 59) return h * 60 + m;
    }
  }
  if (value instanceof Date && !isNaN(value)) return value.getHours() * 60 + value.getMinutes();
  const s = String(value).trim();
  const match = s.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?(?:\s|$)/);
  if (match) {
    const h = Number(match[1]), m = Number(match[2]);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }
  const d = new Date(s);
  if (!isNaN(d)) return d.getHours() * 60 + d.getMinutes();
  return null;
}
function fmtMinutes(mins) {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return null;
  mins = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2,'0')}:${String(mins % 60).padStart(2,'0')}`;
}
function diffMinutes(actual, planned) {
  if (actual === null || planned === null) return null;
  let d = actual - planned;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

function parseDateKey(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value)) {
    return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)(?:[T\s]|$)/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  m = s.match(/^([0-3]?\d)[-\/]([01]?\d)[-\/](\d{4})(?:\s|$)/);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return null;
}
function weekdayEs(dateKey) {
  if (!dateKey) return null;
  const d = new Date(dateKey+'T12:00:00');
  if (isNaN(d)) return null;
  return ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][d.getDay()];
}
function normalizeWeekday(v) {
  const n = normalizeName(v);
  const map = { 'miercoles':'miercoles','miércoles':'miercoles','sabado':'sabado','sábado':'sabado' };
  return map[n] || n;
}
function rowDateKey(row, type) {
  const direct = parseDateKey(pick(row, FIELDS.fecha));
  if (direct) return direct;
  if (type === 'logeo') return parseDateKey(getEventTimeValue(row));
  if (type === 'citaciones') return parseDateKey(pick(row, FIELDS.timestamp));
  return null;
}
function filterRowsForDate(rows, fecha, type) {
  if (!fecha) return rows;
  const targetDay = weekdayEs(fecha);
  return rows.filter(row => {
    const dk = rowDateKey(row, type);
    if (dk) return dk === fecha;
    const wd = normalizeWeekday(pick(row, FIELDS.diaSemana));
    if (wd) return wd === targetDay;
    // Archivos ya recortados a un único día pueden no traer fecha: se conservan.
    return true;
  });
}
function countRowsWithDate(rows, type) {
  return rows.filter(r => rowDateKey(r, type) || pick(r, FIELDS.diaSemana)).length;
}

function datasetDateProfile(rows, type) {
  const counts = new Map();
  for (const row of rows || []) {
    const d = rowDateKey(row, type);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  const fechas = [...counts.entries()]
    .sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([fecha,cantidad])=>({fecha,cantidad}));
  return {
    fechas,
    fecha_unica: fechas.length === 1 ? fechas[0].fecha : null,
    filas_con_fecha: fechas.reduce((a,x)=>a+x.cantidad,0),
  };
}

function operatorKey(row) {
  const id = normalizeId(pick(row, FIELDS.id));
  if (id) return `id:${id}`;
  const name = normalizeName(pick(row, FIELDS.nombre));
  return name ? `name:${name}` : '';
}
function rowOperator(row) {
  const id = normalizeId(pick(row, FIELDS.id));
  let nombre = safeText(pick(row, FIELDS.nombre));
  if (!nombre) {
    const first = safeText(pick(row, FIELDS.firstName));
    const last = safeText(pick(row, FIELDS.lastName));
    nombre = [first, last].filter(Boolean).join(' ').trim();
  }
  nombre = nombre || (id ? `Operador ${id}` : 'Sin nombre');
  return { id: id || normalizeName(nombre), nombre };
}

// Genera todas las claves útiles para conciliar un operador entre fuentes.
// StatusBreakdown suele identificar por Numero Funcionario, mientras otros
// archivos pueden traer ID Operador y/o nombre. Indexamos por ambos cuando existen.
function operatorMatchKeys(row) {
  const keys = [];
  const id = normalizeId(pick(row, FIELDS.id));
  if (id) keys.push(`id:${id}`);
  const op = rowOperator(row);
  const nombre = normalizeName(op.nombre);
  if (nombre && !/^operador\s+\d+$/.test(nombre) && nombre !== 'sin nombre') keys.push(`name:${nombre}`);
  return [...new Set(keys)];
}

function addToMultiIndex(index, row) {
  for (const key of operatorMatchKeys(row)) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
}

function rowsFromMultiIndex(index, row) {
  const out = new Set();
  for (const key of operatorMatchKeys(row)) {
    for (const item of (index.get(key) || [])) out.add(item);
  }
  return [...out];
}

function classifyOperationalEvent(rawEstado) {
  const e = normalizeName(rawEstado);
  if (!e) return 'otro';
  if (/login|logeo|logeado|entrada/.test(e)) return 'login';
  if (/^asignado$|asignad|assigned|dispatch|despachad/.test(e)) return 'asignado';
  if (/cargando|^cargado$|loading/.test(e)) return 'primera_carga';
  if (/en planta/.test(e)) return 'en_planta';
  if (/en servicio/.test(e)) return 'en_servicio';
  return 'otro';
}

// ============================================================================
// DICCIONARIO MAESTRO DE ZONAS OPERACIONALES
// Solo existen 3 zonas: Norte, Centro y Sur.
// Centro agrupa RM + V + VI Región.
// ============================================================================
const MASTER_ZONE_REGIONS = {
  Norte: {
    Norte: ['Arica','Iquique','Antofagasta','Copiapó','Vallenar','Coquimbo','Diego de Almagro']
  },
  Centro: {
    'RM': ['Central Mix','Lo Espejo','Planta Oriente','Planta Poniente'],
    'V Región': ['Viña del Mar','Santo Domingo','Los Andes','Melipilla'],
    'VI Región': ['Rancagua']
  },
  Sur: {
    Sur: ['Curicó','Talca','Linares','Chillán','Los Ángeles','Concepción Hualpén','Coronel','Temuco','Villarrica','Puerto Montt','Castro']
  }
};

const MASTER_ZONE_PLANTS = Object.fromEntries(
  Object.entries(MASTER_ZONE_REGIONS).map(([zona, regiones]) => [zona, Object.values(regiones).flat()])
);

const PLANT_ALIASES = {
  'espejo': 'Lo Espejo',
  'lo espejo': 'Lo Espejo',
  'central mix': 'Central Mix',
  'oriente': 'Planta Oriente',
  'planta oriente': 'Planta Oriente',
  'poniente': 'Planta Poniente',
  'planta poniente': 'Planta Poniente',
  'vina': 'Viña del Mar',
  'vina del mar': 'Viña del Mar',
  'concepcion': 'Concepción Hualpén',
  'concepcion hualpen': 'Concepción Hualpén',
  'hualpen': 'Concepción Hualpén',
  'villarica': 'Villarrica'
};

function canonicalPlantName(rawName) {
  const raw = safeText(rawName);
  if (!raw) return 'Sin planta';
  const norm = normalizeName(raw);
  if (PLANT_ALIASES[norm]) return PLANT_ALIASES[norm];
  for (const nombres of Object.values(MASTER_ZONE_PLANTS)) {
    const found = nombres.find(n => normalizeName(n) === norm);
    if (found) return found;
  }
  return raw;
}

function canonicalZone(rawZone) {
  const z = normalizeName(rawZone);
  if (!z) return '';
  if (/^(norte|zona norte)$/.test(z)) return 'Norte';
  if (/^(sur|zona sur)$/.test(z)) return 'Sur';
  // RM, V y VI pertenecen a Centro por definición operacional.
  if (/^(centro|zona centro|rm|region metropolitana|metropolitana|v|5|quinta|quinta region|vi|6|sexta|sexta region)$/.test(z)) return 'Centro';
  return '';
}

function inferZona(planta, rawZone='') {
  const z = canonicalZone(rawZone);
  if (z) return z;
  const p = normalizeName(planta);

  if (/arica|iquique|antofagasta|copiapo|vallenar|coquimbo|diego de almagro/.test(p)) return 'Norte';
  if (/curico|talca|linares|chillan|los angeles|concepcion|hualpen|coronel|temuco|villarica|villarrica|puerto montt|castro/.test(p)) return 'Sur';
  if (/central mix|lo espejo|(^| )espejo($| )|planta oriente|planta poniente|vina del mar|santo domingo|los andes|melipilla|rancagua/.test(p)) return 'Centro';

  return 'Centro';
}

function inferRegion(planta, rawRegion='', rawZone='') {
  const r = normalizeName(rawRegion);
  const p = normalizeName(planta);
  const z = inferZona(planta, rawZone);
  if (z === 'Norte') return 'Norte';
  if (z === 'Sur') return 'Sur';
  if (/^(rm|region metropolitana|metropolitana)$/.test(r)) return 'RM';
  if (/^(v|5|quinta|quinta region|v region)$/.test(r)) return 'V Región';
  if (/^(vi|6|sexta|sexta region|vi region)$/.test(r)) return 'VI Región';
  if (/central mix|lo espejo|(^| )espejo($| )|planta oriente|planta poniente/.test(p)) return 'RM';
  if (/vina del mar|santo domingo|los andes|melipilla/.test(p)) return 'V Región';
  if (/rancagua/.test(p)) return 'VI Región';
  return 'Centro';
}

function ensurePlant(name, zone, region) {
  const clean = canonicalPlantName(name);
  const zonaCanonica = inferZona(clean, zone);
  const regionCanonica = inferRegion(clean, region, zone);
  if (!state.plantas[clean]) {
    state.plantas[clean] = {
      nombre: clean,
      zona: zonaCanonica,
      region: regionCanonica,
      tol_v: 5,
      tol_a: 30,
      tol_asig: 30,
      citacion: 'no',
      actualizado_por: 'Sistema',
      actualizado_en: nowIso(),
    };
  } else {
    state.plantas[clean].zona = zonaCanonica;
    state.plantas[clean].region = regionCanonica;
  }
  return state.plantas[clean];
}

function masterPlantCatalog() {
  const merged = new Map();
  for (const [zona, regiones] of Object.entries(MASTER_ZONE_REGIONS)) {
    for (const [region, nombres] of Object.entries(regiones)) {
      for (const nombre of nombres) merged.set(normalizeName(nombre), { nombre, zona, region });
    }
  }
  return [...merged.values()];
}

function validateDataset(type, rows) {
  const valid = [], rejected = [], errors = [];
  rows.forEach((row, index) => {
    const op = pick(row, FIELDS.id) || pick(row, FIELDS.nombre);
    if (!op) {
      rejected.push(row); errors.push(`Fila ${index + 1}: operador/ID no encontrado`); return;
    }
    if (type === 'turnos') {
      const plant = pick(row, FIELDS.planta);
      const shift = pick(row, FIELDS.turno);
      if (!plant) { rejected.push(row); errors.push(`Fila ${index + 1}: planta no encontrada`); return; }
      if (parseTimeMinutes(shift) === null) { rejected.push(row); errors.push(`Fila ${index + 1}: hora de turno inválida`); return; }
    }
    if (type === 'logeo') {
      const log = getEventTimeValue(row);
      if (parseTimeMinutes(log) === null && !asDate(log)) {
        const columnas = Object.keys(row || {}).slice(0, 12).join(', ');
        rejected.push(row);
        errors.push(`Fila ${index + 1}: no se detectó fecha/hora de evento. Columnas recibidas: ${columnas}`);
        return;
      }
    }
    valid.push(row);
  });
  return { valid, rejected, errors };
}

function authToken(user) {
  const payload = Buffer.from(JSON.stringify({ ...user, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function decodeToken(token) {
  try {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!user?.nombre || !user?.rol) return null;
    return user;
  } catch { return null; }
}
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const user = decodeToken(token);
  if (!user) return res.status(401).json({ error: 'Sesión inválida o expirada' });
  req.user = user; next();
}

function getTurnos() { return state.datasets.turnos.datos || []; }
function getCitaciones() { return state.datasets.citaciones.datos || []; }
function getLogeo() { return state.datasets.logeo.datos || []; }

function buildOperatorRecords(fecha = '') {
  const rawShifts = filterRowsForDate(getTurnos(), fecha, 'turnos');
  // Un operador se cuenta una sola vez por día operacional. Si el archivo trae
  // duplicados para el mismo operador, conservamos el turno más temprano.
  const shiftMap = new Map();
  rawShifts.forEach((row, idx) => {
    const key = operatorKey(row) || `row:${idx}`;
    const prev = shiftMap.get(key);
    if (!prev) { shiftMap.set(key, row); return; }
    const a = parseTimeMinutes(pick(row, FIELDS.turno));
    const b = parseTimeMinutes(pick(prev, FIELDS.turno));
    if (a !== null && (b === null || a < b)) shiftMap.set(key, row);
  });
  const shifts = [...shiftMap.values()];
  const citations = filterRowsForDate(getCitaciones(), fecha, 'citaciones');
  const logs = filterRowsForDate(getLogeo(), fecha, 'logeo');
  const cByKey = new Map();
  const logsByKey = new Map();

  for (const c of citations) addToMultiIndex(cByKey, c);
  for (const l of logs) addToMultiIndex(logsByKey, l);

  return shifts.map((t, idx) => {
    const key = operatorKey(t) || `row:${idx}`;
    const { id, nombre } = rowOperator(t);
    const plantaOriginal = safeText(pick(t, FIELDS.planta)) || 'Sin planta';
    const pCfg = ensurePlant(plantaOriginal, safeText(pick(t, FIELDS.zona)) || undefined);
    const planta = pCfg.nombre;
    const turnoMin = parseTimeMinutes(pick(t, FIELDS.turno));

    const cs = rowsFromMultiIndex(cByKey, t);
    let citacionMin = null;
    for (const c of cs) {
      const m = parseTimeMinutes(pick(c, FIELDS.citacion));
      if (m !== null && (citacionMin === null || Math.abs(diffMinutes(m, turnoMin)) < Math.abs(diffMinutes(citacionMin, turnoMin)))) citacionMin = m;
    }

    const ls = rowsFromMultiIndex(logsByKey, t);
    const events = ls.map(l => ({
      row: l,
      min: parseTimeMinutes(getEventTimeValue(l)),
      estadoRaw: safeText(pick(l, FIELDS.estado)) || '',
      estado: normalizeName(pick(l, FIELDS.estado)),
      tipo: classifyOperationalEvent(pick(l, FIELDS.estado)),
    })).filter(x => x.min !== null).sort((a,b)=>a.min-b.min);

    // LOGIN/PRE-VIAJE es el evento oficial de ingreso del StatusBreakdown.
    // No usamos cualquier evento como logeo, porque eso infla falsamente la cobertura.
    let loginEvent = events.find(e => e.tipo === 'login');
    // Respaldo solo para exportaciones sin columna Estado: si todos los estados vienen vacíos,
    // usamos el primer timestamp del operador como marcación observada.
    if (!loginEvent && events.length && events.every(e => !e.estado)) loginEvent = events[0];
    const logeoMin = loginEvent?.min ?? null;

    const assignmentCandidates = events.filter(e => e.tipo === 'asignado');
    let asignacionMin = null;
    if (assignmentCandidates.length) {
      const base = logeoMin ?? turnoMin;
      const after = assignmentCandidates.map(e => ({...e, d: base===null?0:diffMinutes(e.min, base)})).filter(e => base===null || e.d >= 0).sort((a,b)=>a.d-b.d);
      asignacionMin = after[0]?.min ?? assignmentCandidates[0]?.min ?? null;
    }

    // Primera carga: primer estado CARGANDO/CARGADO posterior al logeo o asignación.
    // EN PLANTA no se utiliza como primera carga porque puede corresponder al retorno de un ciclo previo.
    const loadCandidates = events.filter(e => e.tipo === 'primera_carga');
    let primeraCargaMin = null;
    if (loadCandidates.length) {
      const base = asignacionMin ?? logeoMin ?? turnoMin;
      const after = loadCandidates.map(e => ({...e, d: base===null?0:diffMinutes(e.min, base)})).filter(e => base===null || e.d >= 0).sort((a,b)=>a.d-b.d);
      primeraCargaMin = after[0]?.min ?? loadCandidates[0]?.min ?? null;
    }

    const atraso = logeoMin === null ? null : diffMinutes(logeoMin, turnoMin);
    let categoria = 'sin_logeo';
    if (atraso !== null) {
      if (atraso < -pCfg.tol_v) categoria = 'adelantado';
      else if (atraso <= pCfg.tol_v) categoria = 'a_tiempo';
      else if (atraso <= pCfg.tol_a) categoria = 'atraso_leve';
      else categoria = 'atraso_critico';
    }
    const tiempoMuertoMin = (logeoMin !== null && asignacionMin !== null) ? Math.max(0, diffMinutes(asignacionMin, logeoMin)) : null;
    const estado = {
      a_tiempo:'A tiempo', adelantado:'Adelantado', atraso_leve:'Atraso leve', atraso_critico:'Atraso crítico', sin_logeo:'Sin logeo'
    }[categoria];
    const estadoOperacional = primeraCargaMin !== null ? 'Primera carga'
      : asignacionMin !== null ? 'Asignado'
      : logeoMin !== null ? 'Con logeo'
      : 'Sin logeo';

    return {
      key, id, nombre, planta, zona: pCfg.zona, region: pCfg.region,
      turnoMin, citacionMin, logeoMin, asignacionMin, primeraCargaMin,
      horaTurno: fmtMinutes(turnoMin), horaCitacion: fmtMinutes(citacionMin), horaLogeo: fmtMinutes(logeoMin), horaAsignacion: fmtMinutes(asignacionMin), horaPrimeraCarga: fmtMinutes(primeraCargaMin),
      turno: fmtMinutes(turnoMin), citacionHora: fmtMinutes(citacionMin), logeo: fmtMinutes(logeoMin), asignacion: fmtMinutes(asignacionMin), primeraCarga: fmtMinutes(primeraCargaMin),
      conLogeo: logeoMin !== null, asignado: asignacionMin !== null, conPrimeraCarga: primeraCargaMin !== null,
      atrasoTurnoMin: atraso,
      adelantoMin: atraso !== null && atraso < 0 ? Math.abs(atraso) : 0,
      tiempoMuertoMin,
      esperaMin: tiempoMuertoMin,
      esperaAsignacionMin: tiempoMuertoMin,
      categoria, estado, estadoOperacional,
      etiqueta: estado,
      horaTurnoSospechosa: turnoMin !== null && (turnoMin < 5*60 || turnoMin > 23*60+59),
    };
  });
}

function filterScope(records, query) {
  const zona = safeText(query.zona || '');
  const region = safeText(query.region || '');
  const plantas = String(query.plantas || '').split(',').map(s=>s.trim()).filter(Boolean);
  return records.filter(r => (!zona || r.zona === zona) && (!region || r.region === region) && (!plantas.length || plantas.includes(r.planta)));
}

function datasetPlantCount(type, planta) {
  const rows = state.datasets[type].datos || [];
  return rows.filter(r => safeText(pick(r, FIELDS.planta)) === planta).length;
}

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'CCO Intelligence',
  version: '1.6.0',
  env: NODE_ENV,
  timestamp: nowIso(),
  uptime_s: Math.round(process.uptime()),
  persistence: DATA_FILE,
}));

app.post('/api/auth/login', (req, res) => {
  const nombre = safeText(req.body?.nombre);
  const rol = safeText(req.body?.rol || 'coordinador');
  const zona = safeText(req.body?.zona || '');
  const planta = safeText(req.body?.planta || '');
  const region = safeText(req.body?.region || '');
  const fecha = safeText(req.body?.fecha || '');
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const allowedRoles = new Set(['admin','gerencia','supervisor_nacional','supervisor_zona','supervisor_planta','coordinador','lectura']);
  if (!allowedRoles.has(rol)) return res.status(400).json({ error: 'Rol inválido' });
  const user = { nombre, rol, zona, region, planta, fecha };
  res.json({ token: authToken(user), user });
});

app.post('/api/ingesta', requireAuth, (req, res) => {
  try {
    const tipo = safeText(req.body?.tipo);
    const incoming = req.body?.datos ?? req.body?.registros;
    const archivo = safeText(req.body?.archivo || 'archivo');
    if (!['turnos','citaciones','logeo'].includes(tipo)) return res.status(400).json({ error: `Tipo desconocido: ${tipo}` });
    if (!Array.isArray(incoming) || incoming.length === 0) return res.status(400).json({ error: 'El archivo no contiene filas válidas para procesar' });
    const normalized = normalizeRows(incoming);
    const result = validateDataset(tipo, normalized);
    if (!result.valid.length) return res.status(400).json({ error: 'Ninguna fila superó la validación', errores: result.errors.slice(0,10) });
    const dateProfile = datasetDateProfile(result.valid, tipo);

    state.datasets[tipo] = {
      datos: result.valid,
      metadatos: {
        cantidad: result.valid.length,
        filas_totales: incoming.length,
        filas_validas: result.valid.length,
        filas_rechazadas: result.rejected.length,
        errores: result.errors.slice(0,20),
        archivo,
        subido_por: req.user.nombre,
        cargado_en: nowIso(),
        fechas_detectadas: dateProfile.fechas,
        fecha_unica: dateProfile.fecha_unica,
      },
    };
    if (tipo === 'turnos') {
      for (const row of result.valid) ensurePlant(pick(row, FIELDS.planta), pick(row, FIELDS.zona));
    }
    state.audit.unshift({ id: crypto.randomUUID(), action:'ingesta', tipo, archivo, usuario:req.user.nombre, fecha:nowIso() });
    state.audit = state.audit.slice(0, 2000);
    persistState();
    const info = {
      tipo,
      cantidad: result.valid.length,
      subido_por: req.user.nombre,
      filas_rechazadas: result.rejected.length,
      fechas_detectadas: dateProfile.fechas,
      fecha_unica: dateProfile.fecha_unica,
    };
    io.emit('ingesta:actualizada', info);
    res.json({ ok:true, ...info, errores: result.errors.slice(0,5) });
  } catch (err) {
    console.error('POST /api/ingesta', err);
    res.status(500).json({ error: 'Error interno procesando la ingesta' });
  }
});

app.get('/api/ingesta/estado', requireAuth, (req, res) => {
  res.json({
    turnos: state.datasets.turnos.metadatos || { cantidad:0, subido_por:'—' },
    citaciones: state.datasets.citaciones.metadatos || { cantidad:0, subido_por:'—' },
    logeo: state.datasets.logeo.metadatos || { cantidad:0, subido_por:'—' },
  });
});

app.get('/api/catalogo/plantas', (req, res) => {
  const zona = canonicalZone(safeText(req.query.zona || ''));
  const region = safeText(req.query.region || '');
  let list = masterPlantCatalog();
  if (zona) list = list.filter(p => p.zona === zona);
  if (region) list = list.filter(p => p.region === region);
  res.json(list.sort((a,b)=>a.zona.localeCompare(b.zona,'es') || String(a.region||'').localeCompare(String(b.region||''),'es') || a.nombre.localeCompare(b.nombre,'es')));
});

app.get('/api/plantas', requireAuth, (req, res) => {
  // Catálogo operacional oficial: solo expone las plantas definidas en el maestro.
  const catalog = [];
  for (const item of masterPlantCatalog().filter(p => MASTER_ZONE_PLANTS[p.zona]?.some(n=>normalizeName(n)===normalizeName(p.nombre)))) {
    const cfg = ensurePlant(item.nombre, item.zona, item.region);
    catalog.push({...cfg, zona:item.zona, region:item.region});
  }
  persistState();
  res.json(catalog.sort((a,b)=>a.zona.localeCompare(b.zona,'es') || String(a.region||'').localeCompare(String(b.region||''),'es') || a.nombre.localeCompare(b.nombre,'es')));
});

app.put('/api/plantas/:nombre/config', requireAuth, (req, res) => {
  const nombre = safeText(decodeURIComponent(req.params.nombre));
  const p = ensurePlant(nombre);
  const tol_v = Number(req.body?.tol_v), tol_a = Number(req.body?.tol_a), tol_asig = Number(req.body?.tol_asig);
  if (![tol_v,tol_a,tol_asig].every(Number.isFinite)) return res.status(400).json({ error:'Las tolerancias deben ser numéricas' });
  if (tol_v < 0 || tol_a < tol_v || tol_asig < 0) return res.status(400).json({ error:'Configuración de tolerancias inválida' });
  Object.assign(p, {
    tol_v: clamp(Math.round(tol_v),0,120),
    tol_a: clamp(Math.round(tol_a),0,240),
    tol_asig: clamp(Math.round(tol_asig),0,240),
    citacion: req.body?.citacion === 'si' ? 'si' : 'no',
    actualizado_por: req.user.nombre,
    actualizado_en: nowIso(),
  });
  persistState();
  io.emit('config:actualizada', p);
  res.json(p);
});

app.get('/api/operadores', requireAuth, (req, res) => {
  const planta = safeText(req.query.planta || '');
  const seen = new Map();
  const fecha = safeText(req.query.fecha || req.user.fecha || '');
  for (const row of filterRowsForDate(getTurnos(), fecha, 'turnos')) {
    if (planta && safeText(pick(row, FIELDS.planta)) !== planta) continue;
    const op = rowOperator(row);
    if (!seen.has(op.id)) seen.set(op.id, op);
  }
  res.json([...seen.values()].sort((a,b)=>a.nombre.localeCompare(b.nombre,'es')));
});

app.get('/api/bitacora', requireAuth, (req, res) => {
  let rows = state.bitacora;
  if (req.user.zona) rows = rows.filter(r => ensurePlant(r.planta).zona === req.user.zona);
  res.json(rows.slice(0,1000));
});

app.post('/api/bitacora', requireAuth, (req, res) => {
  const planta = safeText(req.body?.planta);
  const tipo = safeText(req.body?.tipo);
  const detalle = safeText(req.body?.detalle);
  if (!planta || !tipo || !detalle) return res.status(400).json({ error:'Planta, tipo y detalle son requeridos' });
  ensurePlant(planta);
  const entry = {
    id: crypto.randomUUID(),
    creado_en: nowIso(),
    usuario: req.user.nombre,
    rol: req.user.rol,
    planta,
    operador_id: safeText(req.body?.operador_id || null),
    operador_nombre: safeText(req.body?.operador_nombre || null),
    tipo,
    detalle: detalle.slice(0,2000),
  };
  state.bitacora.unshift(entry);
  state.bitacora = state.bitacora.slice(0,5000);
  persistState();
  io.emit('bitacora:nueva', entry);
  res.status(201).json(entry);
});

app.get('/api/tabla-operadores', requireAuth, (req, res) => {
  let records = buildOperatorRecords(safeText(req.query.fecha || req.user.fecha || ''));
  if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
  if (req.user.region) records = records.filter(r=>r.region===req.user.region);
  if (req.query.soloProblemas === '1') records = records.filter(r=>r.categoria !== 'a_tiempo');
  const orden = req.query.orden;
  if (orden === 'planta') records.sort((a,b)=>a.planta.localeCompare(b.planta,'es') || a.nombre.localeCompare(b.nombre,'es'));
  else if (orden === 'nombre') records.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
  else if (orden === 'tiempoMuerto') records.sort((a,b)=>(b.tiempoMuertoMin ?? -1)-(a.tiempoMuertoMin ?? -1));
  else records.sort((a,b)=>Math.abs(b.atrasoTurnoMin ?? -999)-Math.abs(a.atrasoTurnoMin ?? -999));
  res.json({ operadores: records });
});

app.get('/api/analisis-operadores', requireAuth, (req, res) => {
  const planta = safeText(req.query.planta || '');
  if (!planta) return res.status(400).json({ error:'Planta requerida' });
  const fecha = safeText(req.query.fecha || req.user.fecha || '');
  const records = buildOperatorRecords(fecha).filter(r=>r.planta===planta);
  if (!records.length) return res.json({
    diagnostico:'ATENCIÓN', diagnosticoLineas:['No hay turnos válidos para esta planta.'],
    resumen:{ totalOperadores:0, conLogeo:0, sinLogeo:0, adherenciaTurnoPct:null, atrasadosPct:null, atrasadosCriticos:0, adelantadosPct:null, logeadosSinAsignacion:0, esperaAsignacionPromedioMin:null },
    ranking:[], rankingTiempoMuerto:[], logeadosEsperandoAhora:0, operadores:[]
  });
  const conLogeo = records.filter(r=>r.logeoMin!==null);
  const sinLogeo = records.length-conLogeo.length;
  const atrasados = records.filter(r=>['atraso_leve','atraso_critico'].includes(r.categoria));
  const criticos = records.filter(r=>r.categoria==='atraso_critico');
  const adelantados = records.filter(r=>r.categoria==='adelantado');
  const tm = records.filter(r=>r.tiempoMuertoMin!==null);
  const esperando = records.filter(r=>r.logeoMin!==null && r.asignacionMin===null).length;
  const adherence = round1(conLogeo.length / records.length * 100);
  const cfg = ensurePlant(planta);
  let diagnostico = 'ESTABLE';
  if (adherence < 70 || criticos.length >= Math.max(2, Math.ceil(records.length*.2))) diagnostico='CRÍTICO';
  else if (adherence < 90 || esperando > 0 || tm.some(r=>r.tiempoMuertoMin>cfg.tol_asig)) diagnostico='ATENCIÓN';
  const lines=[];
  if(sinLogeo) lines.push(`${sinLogeo} operador(es) sin logeo registrado.`);
  if(criticos.length) lines.push(`${criticos.length} operador(es) con atraso crítico.`);
  if(esperando) lines.push(`${esperando} operador(es) logeados aún sin primera asignación.`);
  if(tm.length) lines.push(`Tiempo muerto promedio logeo → asignación: ${round1(tm.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tm.length)} min.`);

  res.json({
    diagnostico,
    diagnosticoLineas: lines,
    resumen:{
      totalOperadores:records.length,
      conLogeo:conLogeo.length,
      sinLogeo,
      adherenciaTurnoPct:adherence,
      atrasadosPct:round1(atrasados.length/records.length*100),
      atrasadosCriticos:criticos.length,
      adelantadosPct:round1(adelantados.length/records.length*100),
      logeadosSinAsignacion:esperando,
      esperaAsignacionPromedioMin:tm.length?round1(tm.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tm.length):null,
    },
    ranking:[...records].filter(r=>r.atrasoTurnoMin!==null).sort((a,b)=>Math.abs(b.atrasoTurnoMin)-Math.abs(a.atrasoTurnoMin)).slice(0,10),
    rankingTiempoMuerto:[...tm].sort((a,b)=>b.tiempoMuertoMin-a.tiempoMuertoMin).slice(0,10).map(r=>({...r, tiempoMuertoCategoria:r.tiempoMuertoMin<=30?'ok':r.tiempoMuertoMin<=60?'atencion':'critico'})),
    logeadosEsperandoAhora:esperando,
    operadores:records,
  });
});

app.get('/api/reporte', requireAuth, (req, res) => {
  const fecha = safeText(req.query.fecha || req.user.fecha || '');
  let records = filterScope(buildOperatorRecords(fecha), req.query);
  if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
  if (req.user.region) records = records.filter(r=>r.region===req.user.region);
  if (req.user.planta) records = records.filter(r=>r.planta===req.user.planta);
  const plantNames = [...new Set(records.map(r=>r.planta))];
  if (!plantNames.length) return res.status(400).json({ error:'No hay turnos cargados para el alcance seleccionado' });
  const byPlant = plantNames.map(planta=>{
    const rs=records.filter(r=>r.planta===planta);
    const logged=rs.filter(r=>r.logeoMin!==null);
    const tm=rs.filter(r=>r.tiempoMuertoMin!==null);
    return {
      planta,
      zona:ensurePlant(planta).zona,
      region:ensurePlant(planta).region,
      turnos:rs.length,
      citaciones:rs.filter(r=>r.citacionMin!==null).length,
      logeo:logged.length,
      asignados:rs.filter(r=>r.asignacionMin!==null).length,
      primeraCarga:rs.filter(r=>r.primeraCargaMin!==null).length,
      pendientesIngreso:rs.filter(r=>r.logeoMin===null).length,
      adherenciaLogeo:rs.length?round1(logged.length/rs.length*100):null,
      tiempoMuertoPromedioMin:tm.length?round1(tm.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tm.length):null,
    };
  });
  const tmAll=records.filter(r=>r.tiempoMuertoMin!==null);
  const adelantados=records.filter(r=>r.categoria==='adelantado');
  const citationRows = getCitaciones();
  const logRows = getLogeo();
  const unknown = [...citationRows,...logRows].filter(r=>{
    const p=safeText(pick(r,FIELDS.planta)); return p && !state.plantas[p];
  }).length;
  res.json({
    generado_por:req.user.nombre,
    fecha,
    diagnosticoFecha:{ turnosTotal:getTurnos().length, turnosConFecha:countRowsWithDate(getTurnos(),'turnos'), turnosDia:records.length },
    generado_en:nowIso(),
    zona:req.query.zona || req.user.zona || null,
    region:req.query.region || req.user.region || null,
    plantasFiltro:req.query.plantas?String(req.query.plantas).split(',').filter(Boolean):null,
    resumen:{
      totalTurnos:records.length,
      programadosExigibles:records.length,
      totalCitaciones:records.filter(r=>r.citacionMin!==null).length,
      totalLogeo:records.filter(r=>r.logeoMin!==null).length,
      logeadosAlCorte:records.filter(r=>r.logeoMin!==null).length,
      pendientesIngreso:records.filter(r=>r.logeoMin===null).length,
      asignados:records.filter(r=>r.asignacionMin!==null).length,
      primeraCarga:records.filter(r=>r.primeraCargaMin!==null).length,
      operadoresCriticos:records.filter(r=>r.categoria==='atraso_critico' || (r.logeoMin!==null && r.asignacionMin===null)).length,
      tiempoMuertoPromedioMin:tmAll.length?round1(tmAll.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tmAll.length):null,
      adelantadosPct:records.length?round1(adelantados.length/records.length*100):null,
      adelantadosCantidad:adelantados.length,
      filasSinReconocer:unknown,
      filasSinReconocerDetalle:{ plantaVacia:0, codigoDesconocido:unknown },
    },
    porPlanta:byPlant,
    rankingAdelantados:[...adelantados].sort((a,b)=>b.adelantoMin-a.adelantoMin).slice(0,10),
    rankingTiempoMuertoNacional:[...tmAll].sort((a,b)=>b.tiempoMuertoMin-a.tiempoMuertoMin).slice(0,10),
  });
});

app.get('/api/audit', requireAuth, (req,res)=>res.json(state.audit.slice(0,500)));

io.on('connection', (socket) => {
  socket.on('join', ({ planta } = {}) => { if (planta) socket.join(`planta:${planta}`); });
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

server.listen(PORT, () => {
  console.log(`CCO Intelligence v1.6.0 activo en puerto ${PORT}`);
  if (NODE_ENV === 'production' && AUTH_SECRET === 'cco-dev-secret-change-me') {
    console.warn('ADVERTENCIA: configure AUTH_SECRET en producción.');
  }
});
