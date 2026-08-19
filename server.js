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
const PLANT_DICTIONARY_FILE = path.join(__dirname, 'config', 'plant-dictionary.json');
const HISTORICAL_FILE = path.resolve(process.env.HISTORICAL_FILE || path.join(__dirname, 'data', 'cco-historical.json'));

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
app.use((req,res,next)=>{ if(req.path==='/' || req.path.endsWith('.html')) res.setHeader('Cache-Control','no-store, no-cache, must-revalidate'); next(); });
app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: false }));

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
  historico: [],
  historicalSnapshots: [],
  fleet: { datos: [], metadatos: null, revision: 0 },
};

let state = loadState();

let historicalWarehouse = loadHistoricalWarehouse();

function emptyHistoricalWarehouse() {
  return { version: 1, revision: 0, loaded_at: null, sources: {}, records: [] };
}
function loadHistoricalWarehouse() {
  try {
    if (!fs.existsSync(HISTORICAL_FILE)) return emptyHistoricalWarehouse();
    const parsed = JSON.parse(fs.readFileSync(HISTORICAL_FILE, 'utf8'));
    return {
      ...emptyHistoricalWarehouse(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      sources: parsed?.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
      records: Array.isArray(parsed?.records) ? parsed.records : [],
    };
  } catch (err) {
    console.error('[CCO][historico] No se pudo leer base histórica:', err?.message || err);
    return emptyHistoricalWarehouse();
  }
}
let historicalPersistTimer = null;
function persistHistoricalWarehouse() {
  clearTimeout(historicalPersistTimer);
  historicalPersistTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(HISTORICAL_FILE), { recursive: true });
      const tmp = HISTORICAL_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(historicalWarehouse));
      fs.renameSync(tmp, HISTORICAL_FILE);
    } catch (err) {
      registrarErrorDetallado({modulo:'historico',funcion:'persistHistoricalWarehouse',error:err?.message||String(err),stack:err?.stack});
    }
  }, 250);
}


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
      historico: Array.isArray(parsed.historico) ? parsed.historico : [],
      historicalSnapshots: Array.isArray(parsed.historicalSnapshots) ? parsed.historicalSnapshots : (Array.isArray(parsed.historico) ? parsed.historico : []),
      fleet: parsed.fleet && typeof parsed.fleet === 'object' ? { datos:Array.isArray(parsed.fleet.datos)?parsed.fleet.datos:[], metadatos:parsed.fleet.metadatos||null, revision:Number(parsed.fleet.revision||0) } : { datos:[], metadatos:null, revision:0 },
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
  if (value === null || value === undefined) return '';
  return String(value).replace(/[<>]/g, '').trim();
}

function registrarErrorDetallado({ modulo='desconocido', funcion='desconocida', error='', stack='', contexto=null } = {}) {
  const entry = {
    id: crypto.randomUUID(), tipo:'error_controlado', modulo:safeText(modulo)||'desconocido', funcion:safeText(funcion)||'desconocida',
    error:safeText(error)||'Error sin detalle', stack:safeText(stack).slice(0,4000), contexto: contexto && typeof contexto === 'object' ? contexto : null,
    timestamp: nowIso()
  };
  try {
    if (!Array.isArray(state.audit)) state.audit = [];
    state.audit.unshift(entry); state.audit = state.audit.slice(0,2000); persistState();
  } catch (auditErr) { console.error('[CCO][AUDIT][ERROR]', auditErr?.message || auditErr); }
  console.error(`[CCO][${entry.modulo}][${entry.funcion}] ${entry.error}`, stack || '');
  return entry;
}

function respuestaSinDatos(res, mensaje='Sin información disponible para el período seleccionado', extra={}) {
  return res.json({ ok:true, empty:true, mensaje, ...extra });
}

function validarArray(value, nombre='dataset') {
  if (!Array.isArray(value)) throw new TypeError(`${nombre} debe ser un arreglo`);
  return value;
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
  let s = String(v).trim().replace(/\.0$/, '');
  if (!s) return '';
  if (/^[\d\s.,-]+$/.test(s)) {
    s = s.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
    return s;
  }
  return normalizeName(s).replace(/\s+/g, '');
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
function isAffirmative(value) {
  if (value === true || value === 1) return true;
  const s = normalizeName(value);
  return ['si','sí','s','yes','y','true','1','x','requiere adelantar citacion','adelantar citacion'].includes(s) || s.includes('requiere adelantar');
}

const FIELDS = {
  id: ['id_operador','id operador','numero_funcionario','número funcionario','numero funcionario','id','rut','codigo_operador','cod_operador'],
  nombre: ['operador','nombre_operador','nom_operador','operario','nombre','employee_name','nombre_funcionario','nombre empleado','nombre_empleado'],
  firstName: ['primero_empleado','primero empleado','first_name','firstname','nombre_funcionario','nombre funcionario'],
  lastName: ['ultimo_empleado','último empleado','ultimo empleado','last_name','lastname','apellido_funcionario','apellido funcionario'],
  planta: ['planta','planta_origen','origen','plta','descripcion_planta','descripción planta','plant','codigo_command','código command','cod_planta_command','cod planta command','local_cmd','local cmd','centro_sap','centro sap','puesto_carga','puesto carga','shortname','short_name','local_inventario','local inventario','puesto_expedicion','puesto expedición'],
  zona: ['zona','region','región'],
  turno: ['turno_inicio','hora_inicio','hora_ingreso','hora ingreso','horaingreso','turno','inicio_turno'],
  citacion: ['citacion','citación','cita','hora_citacion','hora citacion','citacion_sugerida','citación sugerida'],
  requiereAdelantarCitacion: ['requiere_adelantar_citacion','requiere adelantar citacion','requiere adelantar citación','adelantar_citacion','adelantar citacion','adelantar citación','requiere_citacion','requiere citacion','requiere citación'],
  logeo: ['logeo','marcacion','marcación','hora_logeo','hora logeo','entrada','login','fecha_hora','fecha hora'],
  estado: ['descripcion_estado','descripción estado','estado','status','status_description','descripcion status','descripción status'],
  fecha: ['fecha','fecha_turno','fecha turno','dia_fecha','día_fecha','date','fecha_programada','fecha programada'],
  diaSemana: ['dia','día','dia_semana','día_semana','day','weekday'],
  semana: ['semana','n_semana','n° semana','numero_semana','número_semana','week','week_number','semana_iso'],
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
function parseWeekNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
  if (!m) return null;
  const w = Number(m[1]);
  return Number.isInteger(w) && w >= 1 && w <= 53 ? w : null;
}
function sourceYear(row) {
  const source = safeText(row?.__source_file || row?._source_file || '');
  const m = source.match(/(?:^|\D)(20\d{2})(?:\D|$)/);
  return m ? Number(m[1]) : new Date().getFullYear();
}
function isoDateFromWeekday(year, week, weekdayRaw) {
  const wd = normalizeWeekday(weekdayRaw);
  const idx = {lunes:1,martes:2,miercoles:3,jueves:4,viernes:5,sabado:6,domingo:7}[wd];
  if (!idx || !week || !year) return null;
  const jan4 = new Date(Date.UTC(year,0,4));
  const jan4Iso = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Iso + 1 + (week-1)*7 + (idx-1));
  return monday.toISOString().slice(0,10);
}
function rowDateKey(row, type) {
  const direct = parseDateKey(pick(row, FIELDS.fecha));
  if (direct) return direct;
  if (type === 'logeo') {
    const eventDate = parseDateKey(getEventTimeValue(row));
    if (eventDate) return eventDate;
  }
  if (type === 'citaciones') {
    const eventDate = parseDateKey(pick(row, FIELDS.timestamp));
    if (eventDate) return eventDate;
  }
  const week = parseWeekNumber(pick(row, FIELDS.semana));
  const weekday = pick(row, FIELDS.diaSemana);
  if (week && weekday) return isoDateFromWeekday(sourceYear(row), week, weekday);
  return null;
}

const runtimeIndexCache = new Map();
function datasetRevision(type) {
  const meta = state?.datasets?.[type]?.metadatos || {};
  return `${meta.revision || 0}|${meta.cantidad || 0}|${meta.cargado_en || ''}`;
}
function invalidateDatasetCache(type) { runtimeIndexCache.delete(type); }
function datasetDateIndex(type) {
  const rev = datasetRevision(type);
  const cached = runtimeIndexCache.get(type);
  if (cached?.rev === rev) return cached;
  const rows = getDatasetRows(type);
  const byDate = new Map(), byWeekday = new Map(), timeless = [];
  let explicitCount = 0;
  for (const row of rows) {
    const dk = rowDateKey(row, type);
    if (dk) {
      explicitCount++;
      if (!byDate.has(dk)) byDate.set(dk, []);
      byDate.get(dk).push(row);
      continue;
    }
    const wd = normalizeWeekday(pick(row, FIELDS.diaSemana));
    if (wd) {
      if (!byWeekday.has(wd)) byWeekday.set(wd, []);
      byWeekday.get(wd).push(row);
    } else timeless.push(row);
  }
  const idx = { rev, byDate, byWeekday, timeless, explicitCount };
  runtimeIndexCache.set(type, idx);
  return idx;
}
function filterRowsForDate(rows, fecha, type) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!fecha) return safeRows;
  if (safeRows === getDatasetRows(type)) {
    const idx = datasetDateIndex(type);
    if (idx.explicitCount > 0) return idx.byDate.get(fecha) || [];
    const targetDay = weekdayEs(fecha);
    return [...(idx.byWeekday.get(targetDay) || []), ...idx.timeless];
  }
  const targetDay = weekdayEs(fecha);
  return safeRows.filter(row => {
    const dk = rowDateKey(row, type);
    if (dk) return dk === fecha;
    const rawFecha = pick(row, FIELDS.fecha);
    const rawEvento = type === 'logeo' ? getEventTimeValue(row) : (type === 'citaciones' ? pick(row, FIELDS.timestamp) : null);
    if ((rawFecha !== null && rawFecha !== undefined && String(rawFecha).trim() !== '') ||
        (rawEvento !== null && rawEvento !== undefined && String(rawEvento).trim() !== '')) return false;
    const wd = normalizeWeekday(pick(row, FIELDS.diaSemana));
    if (wd) return wd === targetDay;
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
// DICCIONARIO CORPORATIVO DE PLANTAS (v2.8)
// Fuente: config/plant-dictionary.json, derivado del Excel entregado por Operaciones.
// Resuelve nombres, Código Command, LOCAL CMD, CENTRO SAP, ShortName y Local Inventario.
// Los alias ambiguos (por ejemplo P13A compartido por Central/Oriente/Poniente) NO se
// resuelven automáticamente: se exige una clave más específica para evitar cruces falsos.
// ============================================================================
function loadPlantDictionary() {
  try {
    if (!fs.existsSync(PLANT_DICTIONARY_FILE)) {
      console.warn('[CCO][plant-dictionary] archivo no encontrado:', PLANT_DICTIONARY_FILE);
      return { version:null, source_file:null, plants:[], conflicts:{} };
    }
    const parsed = JSON.parse(fs.readFileSync(PLANT_DICTIONARY_FILE, 'utf8'));
    return {
      version: safeText(parsed?.version),
      source_file: safeText(parsed?.source_file),
      plants: Array.isArray(parsed?.plants) ? parsed.plants : [],
      conflicts: parsed?.conflicts && typeof parsed.conflicts === 'object' ? parsed.conflicts : {},
    };
  } catch (err) {
    console.error('[CCO][plant-dictionary] No se pudo cargar:', err?.message || err);
    return { version:null, source_file:null, plants:[], conflicts:{} };
  }
}
const PLANT_DICTIONARY = loadPlantDictionary();
const PLANT_DICTIONARY_LOOKUP = new Map();
const PLANT_DICTIONARY_CONFLICTS = new Set(Object.keys(PLANT_DICTIONARY.conflicts || {}));
for (const rec of PLANT_DICTIONARY.plants) {
  const keys = [rec?.canonical, ...(Array.isArray(rec?.aliases) ? rec.aliases : [])];
  for (const raw of keys) {
    const k = normalizeName(raw);
    if (!k || PLANT_DICTIONARY_CONFLICTS.has(k)) continue;
    if (!PLANT_DICTIONARY_LOOKUP.has(k)) PLANT_DICTIONARY_LOOKUP.set(k, rec);
  }
}
function dictionaryPlantRecord(rawValue) {
  const key = normalizeName(rawValue);
  if (!key || PLANT_DICTIONARY_CONFLICTS.has(key)) return null;
  return PLANT_DICTIONARY_LOOKUP.get(key) || null;
}
function dictionaryCanonicalPlant(rawValue) {
  const rec = dictionaryPlantRecord(rawValue);
  return safeText(rec?.canonical) || '';
}
function dictionaryOperationalZone(rawValue) {
  const z = safeText(dictionaryPlantRecord(rawValue)?.zona);
  return ['Norte','Centro','Sur'].includes(z) ? z : '';
}
function dictionaryRegion(rawValue) {
  return safeText(dictionaryPlantRecord(rawValue)?.region);
}
function plantIdentifierCandidates(row) {
  if (!row || typeof row !== 'object') return [];
  const out = [];
  for (const alias of FIELDS.planta) {
    const value = row?.[normalizeKey(alias)];
    if (value !== null && value !== undefined && String(value).trim() !== '') out.push(value);
  }
  return [...new Set(out.map(v=>String(v).trim()).filter(Boolean))];
}
function resolvePlantFromRow(row) {
  const candidates = plantIdentifierCandidates(row);
  // Prioridad 1: cualquier identificador inequívoco presente en el diccionario.
  for (const value of candidates) {
    const resolved = dictionaryCanonicalPlant(value);
    if (resolved) return resolved;
  }
  // Prioridad 2: nombre/alias conocido por las reglas heredadas de CCO.
  for (const value of candidates) {
    const resolved = canonicalPlantName(value);
    if (resolved && resolved !== 'Sin planta') return resolved;
  }
  return 'Sin planta';
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
  'lo espejo 1': 'Lo Espejo',
  'lo espejo 2': 'Lo Espejo',
  'central mix': 'Central Mix',
  'divisa central mix': 'Central Mix',
  'la divisa central mix': 'Central Mix',
  'oriente': 'Planta Oriente',
  'planta oriente': 'Planta Oriente',
  'divisa oriente': 'Planta Oriente',
  'la divisa oriente': 'Planta Oriente',
  'poniente': 'Planta Poniente',
  'planta poniente': 'Planta Poniente',
  'divisa poniente': 'Planta Poniente',
  'la divisa poniente': 'Planta Poniente',
  'vina': 'Viña del Mar',
  'vina del mar': 'Viña del Mar',
  'concepcion': 'Concepción Hualpén',
  'concepcion 1': 'Concepción Hualpén',
  'concepcion hualpen': 'Concepción Hualpén',
  'hualpen': 'Concepción Hualpén',
  'iquique ah': 'Iquique',
  'villarica': 'Villarrica'
};

function canonicalPlantName(rawName) {
  const raw = safeText(rawName);
  if (!raw) return 'Sin planta';
  const fromDictionary = dictionaryCanonicalPlant(raw);
  if (fromDictionary) return fromDictionary;
  const norm = normalizeName(raw);
  if (PLANT_ALIASES[norm]) return PLANT_ALIASES[norm];
  if (/central mix/.test(norm)) return 'Central Mix';
  if (/\b(divisa )?oriente\b/.test(norm)) return 'Planta Oriente';
  if (/\b(divisa )?poniente\b/.test(norm)) return 'Planta Poniente';
  if (/\blo espejo\b/.test(norm)) return 'Lo Espejo';
  if (/^concepcion(\s|$)/.test(norm) || /hualpen/.test(norm)) return 'Concepción Hualpén';
  if (/^iquique(\s|$)/.test(norm)) return 'Iquique';
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
  const dz = dictionaryOperationalZone(planta);
  if (dz) return dz;
  const z = canonicalZone(rawZone);
  if (z) return z;
  const p = normalizeName(planta);

  if (/arica|iquique|antofagasta|copiapo|vallenar|coquimbo|diego de almagro/.test(p)) return 'Norte';
  if (/curico|talca|linares|chillan|los angeles|concepcion|hualpen|coronel|temuco|villarica|villarrica|puerto montt|castro/.test(p)) return 'Sur';
  if (/central mix|lo espejo|(^| )espejo($| )|planta oriente|planta poniente|vina del mar|santo domingo|los andes|melipilla|rancagua/.test(p)) return 'Centro';

  return 'Centro';
}

function inferRegion(planta, rawRegion='', rawZone='') {
  const dictRegion = dictionaryRegion(planta);
  const r = normalizeName(rawRegion || dictRegion);
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
  // El diccionario amplía el catálogo y cruza códigos/nombres; no reemplaza las reglas
  // de negocio del CCO. Solo se incorporan plantas con zona operacional Norte/Centro/Sur.
  for (const rec of PLANT_DICTIONARY.plants) {
    const nombre = canonicalPlantName(rec?.canonical);
    const zona = inferZona(nombre, rec?.zona);
    const region = inferRegion(nombre, rec?.region, rec?.zona);
    if (!nombre || nombre === 'Sin planta' || !['Norte','Centro','Sur'].includes(zona)) continue;
    if (!merged.has(normalizeName(nombre))) merged.set(normalizeName(nombre), { nombre, zona, region });
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
      const plant = resolvePlantFromRow(row);
      const shift = pick(row, FIELDS.turno);
      if (!plant || plant === 'Sin planta') { rejected.push(row); errors.push(`Fila ${index + 1}: planta/código no encontrado en diccionario`); return; }
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

function getDatasetRows(tipo) {
  const rows = state?.datasets?.[tipo]?.datos;
  return Array.isArray(rows) ? rows : [];
}
function getTurnos() { return getDatasetRows('turnos'); }
function getCitaciones() { return getDatasetRows('citaciones'); }
function getLogeo() { return getDatasetRows('logeo'); }

function buildOperatorRecords(fecha = '') {
  try {
    validarArray(getTurnos(), 'turnos'); validarArray(getCitaciones(), 'citaciones'); validarArray(getLogeo(), 'logeo');
  } catch (error) {
    registrarErrorDetallado({ modulo:'operadores', funcion:'buildOperatorRecords', error:error.message, stack:error.stack });
    buildOperatorRecords.lastErrors = [{ global:true, error:error.message }]; return [];
  }
  const rawShifts = filterRowsForDate(getTurnos(), safeText(fecha), 'turnos');
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
  const logs = getLogeo(); // v1.7: se indexa todo el StatusBreakdown para soportar turnos nocturnos que cruzan medianoche
  const cByKey = new Map();
  for (const c of citations) addToMultiIndex(cByKey, c);

  const logIndexRev = datasetRevision('logeo');
  let logIndexCached = runtimeIndexCache.get('__log_operator_index');
  if (!logIndexCached || logIndexCached.rev !== logIndexRev) {
    const map = new Map();
    for (const l of logs) addToMultiIndex(map, l);
    logIndexCached = { rev: logIndexRev, map };
    runtimeIndexCache.set('__log_operator_index', logIndexCached);
  }
  const logsByKey = logIndexCached.map;

  const buildErrors = [];
  const built = shifts.map((t, idx) => {
    try {
    const key = operatorKey(t) || `row:${idx}`;
    const { id, nombre } = rowOperator(t);
    const plantaOriginal = resolvePlantFromRow(t);
    const pCfg = ensurePlant(plantaOriginal, safeText(pick(t, FIELDS.zona)) || undefined);
    const planta = pCfg.nombre;
    const turnoMin = parseTimeMinutes(pick(t, FIELDS.turno));
    if (!Number.isFinite(turnoMin)) throw new Error('Turno inválido o ausente');

    const cs = rowsFromMultiIndex(cByKey, t);
    // v1.8 — La citación solo se aplica cuando el archivo indica explícitamente
    // "Requiere adelantar citación". Si no, la referencia sigue siendo el turno.
    const csAplicables = cs.filter(c => isAffirmative(pick(c, FIELDS.requiereAdelantarCitacion)));
    let citacionMin = null;
    for (const c of csAplicables) {
      const m = parseTimeMinutes(pick(c, FIELDS.citacion));
      if (m !== null && (citacionMin === null || Math.abs(diffMinutes(m, turnoMin)) < Math.abs(diffMinutes(citacionMin, turnoMin)))) citacionMin = m;
    }
    const citacionAplicada = citacionMin !== null && csAplicables.length > 0;
    const referenciaMin = citacionAplicada ? citacionMin : turnoMin;
    const referenciaTipo = citacionAplicada ? 'Citación' : 'Turno';

    const ls = rowsFromMultiIndex(logsByKey, t);

    // v1.7 — Ventana operacional por turno.
    // Diurno: 05:00–17:59. Se ignoran eventos de madrugada del turno nocturno anterior.
    // Nocturno: 18:00–04:59 y se permite cruzar medianoche hacia el día siguiente.
    const isNightShift = turnoMin !== null && (turnoMin >= 18*60 || turnoMin < 5*60);
    const targetDate = fecha || rowDateKey(t, 'turnos');
    const dateDiffDays = (a,b) => {
      if(!a || !b) return 0;
      const da = new Date(a+'T12:00:00Z'), db = new Date(b+'T12:00:00Z');
      return Math.round((da-db)/86400000);
    };

    const events = ls.map(l => {
      const min = parseTimeMinutes(getEventTimeValue(l));
      const eventDate = rowDateKey(l, 'logeo');
      const dayOffset = targetDate && eventDate ? dateDiffDays(eventDate, targetDate) : 0;
      return {
        row:l, min, dayOffset, absMin: min===null ? null : min + dayOffset*1440,
        estadoRaw:safeText(pick(l, FIELDS.estado)) || '',
        estado:normalizeName(pick(l, FIELDS.estado)),
        tipo:classifyOperationalEvent(pick(l, FIELDS.estado)),
      };
    }).filter(x => x.min !== null);

    const shiftAbs = turnoMin;
    // La puntualidad y selección del LOGIN se miden contra la referencia operacional.
    // Para citaciones cercanas a medianoche, se ajusta al día relativo más coherente con el turno.
    let referenceAbs = referenciaMin;
    if (referenciaMin !== null && turnoMin !== null) {
      let d = referenciaMin - turnoMin;
      if (d > 720) d -= 1440;
      if (d < -720) d += 1440;
      referenceAbs = turnoMin + d;
    }
    const operationalEvents = events.filter(e => {
      if (turnoMin === null) return true;
      if (isNightShift) {
        // Permite desde 3 h antes del turno hasta 12 h después, incluyendo madrugada siguiente.
        return e.absMin >= shiftAbs - 180 && e.absMin <= shiftAbs + 720;
      }
      // Turno diurno: solo eventos del mismo día entre 05:00 y 17:59.
      if (e.dayOffset !== 0) return false;
      return e.min >= 5*60 && e.min < 18*60;
    }).sort((a,b)=>a.absMin-b.absMin);

    // Escoger LOGIN válido más cercano al turno dentro de una ventana razonable.
    // Se aceptan hasta 180 min de adelanto y 240 min de atraso para turno diurno;
    // el nocturno usa la ventana operacional completa para no romper el cruce de medianoche.
    let loginCandidates = operationalEvents.filter(e => e.tipo === 'login');
    if (!isNightShift && turnoMin !== null) {
      loginCandidates = loginCandidates.filter(e => {
        const d = e.absMin - referenceAbs;
        return d >= -180 && d <= 240;
      });
    }
    loginCandidates.sort((a,b)=>Math.abs(a.absMin-referenceAbs)-Math.abs(b.absMin-referenceAbs));
    let loginEvent = loginCandidates[0] || null;

    // Respaldo solo para archivos sin columna Estado.
    if (!loginEvent && operationalEvents.length && operationalEvents.every(e => !e.estado)) {
      loginEvent = [...operationalEvents].sort((a,b)=>Math.abs(a.absMin-referenceAbs)-Math.abs(b.absMin-referenceAbs))[0];
    }
    const logeoAbs = loginEvent?.absMin ?? null;
    const logeoMin = loginEvent?.min ?? null;

    // La asignación debe pertenecer a la misma secuencia operacional y ocurrir después del logeo.
    const assignmentCandidates = operationalEvents.filter(e => e.tipo === 'asignado');
    let assignmentEvent = null;
    if (assignmentCandidates.length) {
      const base = logeoAbs ?? referenceAbs;
      assignmentEvent = assignmentCandidates
        .filter(e => base===null || e.absMin >= base)
        .sort((a,b)=>(a.absMin-base)-(b.absMin-base))[0] || null;
    }
    const asignacionAbs = assignmentEvent?.absMin ?? null;
    const asignacionMin = assignmentEvent?.min ?? null;

    // Primera carga: primer CARGANDO/CARGADO de la misma secuencia, posterior a asignación/logeo.
    const loadCandidates = operationalEvents.filter(e => e.tipo === 'primera_carga');
    let loadEvent = null;
    if (loadCandidates.length) {
      const base = asignacionAbs ?? logeoAbs ?? referenceAbs;
      loadEvent = loadCandidates
        .filter(e => base===null || e.absMin >= base)
        .sort((a,b)=>(a.absMin-base)-(b.absMin-base))[0] || null;
    }
    const primeraCargaAbs = loadEvent?.absMin ?? null;
    const primeraCargaMin = loadEvent?.min ?? null;

    // Diferencia real respecto de la REFERENCIA OPERACIONAL:
    // Citación cuando "Requiere adelantar citación" = Sí; turno en los demás casos.
    const atraso = logeoAbs === null || referenceAbs === null ? null : (logeoAbs - referenceAbs);
    let categoria = 'sin_logeo';
    if (atraso !== null) {
      if (atraso < -pCfg.tol_v) categoria = 'adelantado';
      else if (atraso <= pCfg.tol_v) categoria = 'a_tiempo';
      else if (atraso <= pCfg.tol_a) categoria = 'atraso_leve';
      else categoria = 'atraso_critico';
    }
    const tiempoMuertoMin = (logeoAbs !== null && asignacionAbs !== null) ? Math.max(0, asignacionAbs - logeoAbs) : null;
    const estado = {
      a_tiempo:'A tiempo', adelantado:'Adelantado', atraso_leve:'Atraso leve', atraso_critico:'Atraso crítico', sin_logeo:'Sin logeo'
    }[categoria];
    const estadoOperacional = primeraCargaMin !== null ? 'Primera carga'
      : asignacionMin !== null ? 'Asignado'
      : logeoMin !== null ? 'Con logeo'
      : 'Sin logeo';

    return {
      key, id, nombre, planta, zona: pCfg.zona, region: pCfg.region,
      turnoMin, citacionMin, citacionAplicada, referenciaMin, referenciaTipo, referenciaAbs: referenceAbs, logeoMin, asignacionMin, primeraCargaMin,
      horaTurno: fmtMinutes(turnoMin), horaCitacion: fmtMinutes(citacionMin), horaReferencia: fmtMinutes(referenciaMin), horaLogeo: fmtMinutes(logeoMin), horaAsignacion: fmtMinutes(asignacionMin), horaPrimeraCarga: fmtMinutes(primeraCargaMin),
      turno: fmtMinutes(turnoMin), citacionHora: fmtMinutes(citacionMin), referenciaHora: fmtMinutes(referenciaMin), logeo: fmtMinutes(logeoMin), asignacion: fmtMinutes(asignacionMin), primeraCarga: fmtMinutes(primeraCargaMin),
      conLogeo: Number.isFinite(logeoMin), asignado: Number.isFinite(asignacionMin), conPrimeraCarga: Number.isFinite(primeraCargaMin),
      atrasoTurnoMin: atraso, // compatibilidad: ahora representa desviación vs referencia operacional
      desviacionReferenciaMin: atraso,
      adelantoMin: Number.isFinite(atraso) && atraso < 0 ? Math.abs(atraso) : 0,
      tiempoMuertoMin,
      esperaMin: tiempoMuertoMin,
      esperaAsignacionMin: tiempoMuertoMin,
      categoria, estado, estadoOperacional,
      etiqueta: estado,
      horaTurnoSospechosa: turnoMin !== null && (turnoMin < 5*60 || turnoMin > 23*60+59),
    };
    } catch (err) {
      const op = (()=>{ try { return rowOperator(t); } catch { return {id:`fila-${idx+1}`, nombre:'Operador no identificable'}; } })();
      buildErrors.push({ fila:idx+1, id:op.id, nombre:op.nombre, error:err?.message || String(err) });
      console.error(`WARN buildOperatorRecords fila ${idx+1}:`, err && err.stack ? err.stack : err);
      return null;
    }
  });
  buildOperatorRecords.lastErrors = buildErrors;
  return built.filter(Boolean);
}
buildOperatorRecords.lastErrors = [];

function hasMinute(v) { return Number.isFinite(v); }
function buildRecordsWithDiagnostics(fecha='') {
  try {
    const records = buildOperatorRecords(fecha);
    return { records, errors: Array.isArray(buildOperatorRecords.lastErrors) ? buildOperatorRecords.lastErrors : [] };
  } catch (err) {
    console.error('ERROR global buildOperatorRecords:', err && err.stack ? err.stack : err);
    return { records: [], errors:[{ fila:null, id:null, nombre:null, error:err?.message || String(err), global:true }] };
  }
}

function filterScope(records, query) {
  const zona = safeText(query.zona || '');
  const region = safeText(query.region || '');
  const plantas = String(query.plantas || '').split(',').map(s=>s.trim()).filter(Boolean);
  return records.filter(r => (!zona || r.zona === zona) && (!region || r.region === region) && (!plantas.length || plantas.includes(r.planta)));
}

function datasetPlantCount(type, planta) {
  const rows = state.datasets[type].datos || [];
  return rows.filter(r => resolvePlantFromRow(r) === canonicalPlantName(planta)).length;
}

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'CCO Intelligence',
  version: '3.0.0',
  plant_dictionary: { loaded: PLANT_DICTIONARY.plants.length, conflicts: Object.keys(PLANT_DICTIONARY.conflicts || {}).length, source: PLANT_DICTIONARY.source_file },
  env: NODE_ENV,
  timestamp: nowIso(),
  uptime_s: Math.round(process.uptime()),
  persistence: DATA_FILE,
  historical_persistence: HISTORICAL_FILE,
  historical_records: Array.isArray(historicalWarehouse?.records) ? historicalWarehouse.records.length : 0,
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
    const modoRaw = safeText(req.body?.modo || 'replace').toLowerCase();
    const modo = ['replace','append'].includes(modoRaw) ? modoRaw : 'replace';

    if (!['turnos','citaciones','logeo'].includes(tipo)) {
      return res.status(400).json({ error: `Tipo desconocido: ${tipo}` });
    }
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'El lote no contiene filas válidas para procesar' });
    }

    const normalized = normalizeRows(incoming);
    const result = validateDataset(tipo, normalized);
    if (!result.valid.length) {
      return res.status(400).json({
        error: 'Ninguna fila del lote superó la validación',
        errores: result.errors.slice(0,10),
      });
    }

    const lote = Number(req.body?.lote || 1);
    const totalLotes = Number(req.body?.total_lotes || 1);
    const esUltimoLote = !Number.isFinite(totalLotes) || totalLotes <= 1 || lote >= totalLotes;
    const validConFuente = result.valid.map(row => ({ ...row, __source_file: row?.__source_file || archivo }));
    const anteriores = modo === 'append' && Array.isArray(state.datasets?.[tipo]?.datos)
      ? state.datasets[tipo].datos
      : [];
    let combinados;
    if (modo === 'append') {
      anteriores.push(...validConFuente);
      combinados = anteriores;
    } else {
      combinados = validConFuente;
    }

    invalidateDatasetCache(tipo);
    runtimeIndexCache.delete('__log_operator_index');
    const dateProfile = esUltimoLote ? datasetDateProfile(combinados, tipo) : { fechas:[], fecha_unica:null };
    const metaAnterior = modo === 'append' ? (state.datasets?.[tipo]?.metadatos || {}) : {};
    const archivosPrevios = Array.isArray(metaAnterior.archivos) ? metaAnterior.archivos : [];
    const archivos = [...new Set([...archivosPrevios, archivo].filter(Boolean))];

    state.datasets[tipo] = {
      datos: combinados,
      metadatos: {
        cantidad: combinados.length,
        filas_totales: Number(metaAnterior.filas_totales || 0) + incoming.length,
        filas_validas: Number(metaAnterior.filas_validas || 0) + result.valid.length,
        filas_rechazadas: Number(metaAnterior.filas_rechazadas || 0) + result.rejected.length,
        errores: [...(Array.isArray(metaAnterior.errores) ? metaAnterior.errores : []), ...result.errors].slice(-50),
        archivo: archivos.length > 1 ? `${archivos.length} archivos` : (archivos[0] || archivo),
        archivos,
        subido_por: req.user?.nombre || 'Sistema',
        cargado_en: nowIso(),
        fechas_detectadas: dateProfile.fechas,
        fecha_unica: dateProfile.fecha_unica,
        modo_ultima_carga: modo,
        revision: Number(metaAnterior.revision || 0) + 1,
      },
    };

    if (tipo === 'turnos') {
      for (const row of result.valid) {
        ensurePlant(resolvePlantFromRow(row), pick(row, FIELDS.zona));
      }
    }

    state.audit.unshift({
      id: crypto.randomUUID(),
      action: 'ingesta_lote',
      tipo,
      modo,
      archivo,
      filas_lote: incoming.length,
      filas_validas_lote: result.valid.length,
      filas_rechazadas_lote: result.rejected.length,
      acumulado: combinados.length,
      usuario: req.user?.nombre || 'Sistema',
      fecha: nowIso(),
    });
    state.audit = state.audit.slice(0, 2000);
    if (esUltimoLote) persistState();

    const info = {
      tipo,
      modo,
      cantidad: combinados.length,
      cantidad_lote: result.valid.length,
      subido_por: req.user?.nombre || 'Sistema',
      filas_rechazadas: result.rejected.length,
      fechas_detectadas: dateProfile.fechas,
      fecha_unica: dateProfile.fecha_unica,
    };
    if (esUltimoLote) io.emit('ingesta:actualizada', info);
    return res.json({ ok:true, ...info, errores: result.errors.slice(0,5) });
  } catch (err) {
    registrarErrorDetallado({
      modulo:'ingesta',
      funcion:'POST /api/ingesta',
      error:err?.message || String(err),
      stack:err?.stack,
      contexto:{
        tipo:req.body?.tipo || '',
        archivo:req.body?.archivo || '',
        modo:req.body?.modo || '',
        filas:Array.isArray(req.body?.datos) ? req.body.datos.length : null,
      }
    });
    return res.status(422).json({
      error:'No fue posible procesar el lote',
      detalle:err?.message || String(err),
    });
  }
});

app.get('/api/ingesta/estado', requireAuth, (req, res) => {
  res.json({
    turnos: state.datasets.turnos.metadatos || { cantidad:0, subido_por:'—' },
    citaciones: state.datasets.citaciones.metadatos || { cantidad:0, subido_por:'—' },
    logeo: state.datasets.logeo.metadatos || { cantidad:0, subido_por:'—' },
  });
});

app.get('/api/catalogo/diccionario-plantas', requireAuth, (req, res) => {
  res.json({
    version: PLANT_DICTIONARY.version,
    source: PLANT_DICTIONARY.source_file,
    plantas: PLANT_DICTIONARY.plants.length,
    aliases_resolubles: PLANT_DICTIONARY_LOOKUP.size,
    conflictos: PLANT_DICTIONARY.conflicts || {},
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



// ===== v3.1 · TORRE DE CONTROL DE FLOTA / MANTENIMIENTO =====
const FLEET_STATUS = new Set(['available','preventive','internal','external','oos','parts','stale']);
function normHeaderText(v){return safeText(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
function fleetPick(row, aliases){
  if(!row || typeof row!=='object') return '';
  const entries=Object.entries(row);
  for(const alias of aliases){
    const a=normHeaderText(alias);
    const found=entries.find(([k,v])=>normHeaderText(k)===a && v!==null && v!==undefined && safeText(v)!=='');
    if(found) return safeText(found[1]);
  }
  for(const alias of aliases){
    const a=normHeaderText(alias);
    const found=entries.find(([k,v])=>normHeaderText(k).includes(a) && v!==null && v!==undefined && safeText(v)!=='');
    if(found) return safeText(found[1]);
  }
  return '';
}
function fleetStatusFromSource(sourceStatus, activeFlag){
  const s=normHeaderText(sourceStatus), a=normHeaderText(activeFlag);
  if(s.includes('no operativo') || s.includes('fuera de servicio') || s.includes('no se activara')) return 'oos';
  if(s.includes('mant') && s.includes('prevent')) return 'preventive';
  if(s.includes('taller interno')) return 'internal';
  if(s.includes('taller externo')) return 'external';
  if(s.includes('repuesto')) return 'parts';
  if(s.includes('operativo') || a==='activo') return 'available';
  return 'stale';
}
function normalizeFleetRow(row, index){
  const id=fleetPick(row,['Mixer','ID','ID Equipo','Equipo','Código Equipo','Codigo Equipo','Código','Codigo','Unit ID','Unidad']);
  const number=fleetPick(row,['Número','Numero','N°','Nro','Camión','Camion','Mixer','N° Camión','Numero Camion']);
  const plate=fleetPick(row,['Patente','Placa','PPU']);
  const brand=fleetPick(row,['Marca','Brand']);
  const model=fleetPick(row,['Modelo','Model']);
  const year=fleetPick(row,['Año','Ano','Year']);
  const sourceStatus=fleetPick(row,['Estado','Estado Flota','Estado Registro','Status']) || 'Sin estado';
  const activeFlag=fleetPick(row,['Activo / Inactivo','Activo/Inactivo','Activo','Condición','Condicion']) || 'Sin dato';
  const plantCode=fleetPick(row,['Código Planta','Codigo Planta','Cod Planta','Centro SAP','LOCAL CMD','Local CMD']);
  const rawPlant=fleetPick(row,['Planta','Nombre Planta','Base','Centro','Ubicación','Ubicacion']);
  let plant='';
  try{ plant=resolvePlantFromRow(row) || canonicalPlantName(rawPlant||plantCode||''); }catch{ plant=canonicalPlantName(rawPlant||''); }
  if(!plant) plant=rawPlant || 'Sin planta asignada';
  let zone=canonicalZone(fleetPick(row,['Zona','Zone'])) || fleetPick(row,['Zona','Zone']);
  try{ const dz=dictionaryOperationalZone(rawPlant)||dictionaryOperationalZone(plantCode); if(dz) zone=dz; }catch{}
  if(!zone && plant && plant!=='Sin planta asignada'){ try{zone=inferZona(plant,'');}catch{} }
  if(!zone) zone='Sin zona';
  const observation=fleetPick(row,['Observación','Observacion','Comentario','Comentarios']);
  const company=fleetPick(row,['Compañía','Compania','Empresa','Proveedor']);
  const plantType=fleetPick(row,['Tipo planta','Tipo Planta','Tipo']);
  const sourceSheet=fleetPick(row,['__source_sheet']) || '';
  const key=(id||number||plate||`ROW${index+1}`)+'-'+(plate||number||index+1);
  return {key,id:id||number||plate||`Equipo ${index+1}`,number,brand,model,plate,year,zone,plantCode,plantType,plant,company,sourceSheet,sourceStatus,activeFlag,observation,status:fleetStatusFromSource(sourceStatus,activeFlag),workshop:'',responsible:'',eta:'',progress:0,cause:'',history:[]};
}
function sanitizeFleetItem(item){
  const x={...item};
  x.status=FLEET_STATUS.has(x.status)?x.status:'stale';
  x.progress=clamp(Number(x.progress||0),0,100);
  x.history=Array.isArray(x.history)?x.history.slice(-100):[];
  return x;
}
app.get('/api/flota', requireAuth, (req,res)=>{
  const data=Array.isArray(state.fleet?.datos)?state.fleet.datos:[];
  res.json({revision:Number(state.fleet?.revision||0),metadatos:state.fleet?.metadatos||null,cantidad:data.length,datos:data.map(sanitizeFleetItem)});
});
app.post('/api/flota/ingesta', requireAuth, (req,res)=>{
  try{
    const rows=Array.isArray(req.body?.datos)?req.body.datos:null;
    if(!rows) return res.status(400).json({error:'datos debe ser un arreglo'});
    if(!rows.length) return res.status(422).json({error:'Archivo de flota sin registros'});
    const normalizedRaw=rows.map((r,i)=>normalizeFleetRow(r,i)).filter(x=>x.id||x.plate||x.number);
    const normalized=[...new Map(normalizedRaw.map(x=>[x.key,x])).values()];
    if(!normalized.length) return res.status(422).json({error:'No se detectaron equipos válidos en el archivo de flota'});
    const oldByKey=new Map((state.fleet?.datos||[]).map(x=>[x.key,x]));
    const merged=normalized.map(n=>{
      const old=oldByKey.get(n.key);
      return old?{...n,status:old.status||n.status,workshop:old.workshop||'',responsible:old.responsible||'',eta:old.eta||'',progress:Number(old.progress||0),cause:old.cause||'',observation:old.observation||n.observation||'',history:Array.isArray(old.history)?old.history:[]}:n;
    });
    state.fleet={datos:merged,revision:Number(state.fleet?.revision||0)+1,metadatos:{archivo:safeText(req.body?.archivo||'Flota'),hoja:safeText(req.body?.hoja||''),cargado_en:nowIso(),usuario:req.user.nombre,filas_recibidas:rows.length,equipos_validos:merged.length}};
    persistState();io.emit('flota:actualizada',{revision:state.fleet.revision,cantidad:merged.length,metadatos:state.fleet.metadatos});
    res.json({ok:true,revision:state.fleet.revision,cantidad:merged.length,metadatos:state.fleet.metadatos});
  }catch(err){registrarErrorDetallado({modulo:'flota',funcion:'POST /api/flota/ingesta',error:err?.message||String(err),stack:err?.stack});res.status(422).json({error:'No fue posible procesar el archivo de flota',detalle:err?.message||String(err)});}
});
app.patch('/api/flota/:key', requireAuth, (req,res)=>{
  try{
    const data=Array.isArray(state.fleet?.datos)?state.fleet.datos:[];
    const idx=data.findIndex(x=>x.key===req.params.key);
    if(idx<0) return res.status(404).json({error:'Equipo no encontrado'});
    const before={...data[idx]};
    const allowed=['status','plant','zone','workshop','responsible','eta','progress','cause','observation'];
    const next={...before};
    allowed.forEach(k=>{if(Object.prototype.hasOwnProperty.call(req.body||{},k))next[k]=req.body[k];});
    if(!FLEET_STATUS.has(next.status)) next.status='stale';
    next.progress=clamp(Number(next.progress||0),0,100);
    if(next.plant && next.plant!=='Sin planta asignada'){
      const canon=canonicalPlantName(next.plant)||next.plant; next.plant=canon;
      try{next.zone=ensurePlant(canon)?.zona||next.zone;}catch{}
    }
    const changes=allowed.filter(k=>String(before[k]??'')!==String(next[k]??''));
    if(changes.length){
      next.history=Array.isArray(before.history)?[...before.history]:[];
      next.history.push({timestamp:nowIso(),usuario:req.user.nombre,cambios:changes.reduce((o,k)=>(o[k]={antes:before[k]??'',despues:next[k]??''},o),{})});
      next.history=next.history.slice(-100);
    }
    data[idx]=next;state.fleet.datos=data;state.fleet.revision=Number(state.fleet?.revision||0)+1;persistState();
    io.emit('flota:equipo_actualizado',{equipo:sanitizeFleetItem(next),revision:state.fleet.revision});
    res.json({ok:true,equipo:sanitizeFleetItem(next),revision:state.fleet.revision});
  }catch(err){registrarErrorDetallado({modulo:'flota',funcion:'PATCH /api/flota/:key',error:err?.message||String(err),stack:err?.stack});res.status(422).json({error:'No fue posible actualizar el equipo',detalle:err?.message||String(err)});}
});

app.get('/api/operadores', requireAuth, (req, res) => {
  const planta = safeText(req.query.planta || '');
  const seen = new Map();
  const fecha = safeText(req.query.fecha || req.user.fecha || '');
  for (const row of filterRowsForDate(getTurnos(), fecha, 'turnos')) {
    if (planta && resolvePlantFromRow(row) !== canonicalPlantName(planta)) continue;
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
  try {
  let records = buildOperatorRecords(safeText(req.query.fecha || req.user.fecha || ''));
  if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
  if (req.user.region) records = records.filter(r=>r.region===req.user.region);
  if (req.query.soloProblemas === '1') records = records.filter(r=>r.categoria !== 'a_tiempo');
  const orden = req.query.orden;
  if (orden === 'planta') records.sort((a,b)=>a.planta.localeCompare(b.planta,'es') || a.nombre.localeCompare(b.nombre,'es'));
  else if (orden === 'nombre') records.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
  else if (orden === 'tiempoMuerto') records.sort((a,b)=>(b.tiempoMuertoMin ?? -1)-(a.tiempoMuertoMin ?? -1));
  else records.sort((a,b)=>Math.abs(b.atrasoTurnoMin ?? -999)-Math.abs(a.atrasoTurnoMin ?? -999));
  return res.json({ operadores:Array.isArray(records)?records:[], erroresConstruccion:Array.isArray(buildOperatorRecords.lastErrors)?buildOperatorRecords.lastErrors.slice(0,20):[] });
  } catch (err) {
    registrarErrorDetallado({ modulo:'operadores', funcion:'GET /api/tabla-operadores', error:err?.message || String(err), stack:err?.stack });
    return res.status(422).json({ error:'No fue posible construir la tabla de operadores', detalle:err?.message || String(err) });
  }
});

app.get('/api/analisis-operadores', requireAuth, (req, res) => {
  try {
    const planta = safeText(req.query.planta || '');
    if (!planta) return res.status(400).json({ error:'Planta requerida' });
    const fecha = safeText(req.query.fecha || req.user.fecha || '');
    const built = buildRecordsWithDiagnostics(fecha);
    const records = built.records.filter(r=>r.planta===planta);
    if (!records.length) return res.json({
      diagnostico:'ATENCIÓN', diagnosticoLineas:['No hay turnos válidos para esta planta.'],
      resumen:{ totalOperadores:0, conLogeo:0, sinLogeo:0, adherenciaTurnoPct:null, atrasadosPct:null, atrasadosCriticos:0, adelantadosPct:null, logeadosSinAsignacion:0, esperaAsignacionPromedioMin:null },
      ranking:[], rankingTiempoMuerto:[], logeadosEsperandoAhora:0, operadores:[]
    });
    const conLogeo = records.filter(r=>hasMinute(r.logeoMin));
    const sinLogeo = records.length-conLogeo.length;
    const atrasados = records.filter(r=>['atraso_leve','atraso_critico'].includes(r.categoria));
    const criticos = records.filter(r=>r.categoria==='atraso_critico');
    const adelantados = records.filter(r=>r.categoria==='adelantado');
    const tm = records.filter(r=>hasMinute(r.tiempoMuertoMin));
    const esperando = records.filter(r=>hasMinute(r.logeoMin) && !hasMinute(r.asignacionMin)).length;
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
      erroresConstruccion: built.errors.slice(0,20),
    });
  } catch (err) {
    registrarErrorDetallado({ modulo:'operadores', funcion:'GET /api/analisis-operadores', error:err?.message || String(err), stack:err?.stack, contexto:{ planta:req.query?.planta || '', fecha:req.query?.fecha || '' } });
    return res.status(422).json({ error:'No fue posible analizar los operadores con los datos disponibles', detalle:err?.message || String(err), mensaje_usuario:'Información incompleta o inválida para la planta seleccionada.' });
  }
});


// ============================================================================
// CCO INTELLIGENCE v3.0 — DATA WAREHOUSE HISTÓRICO INDEPENDIENTE
// Nunca consulta datasets activos de Operación Nacional.
// ============================================================================
const HISTORICAL_SOURCES = {
  turnos: { label:'Turnos' },
  citaciones: { label:'Citaciones' },
  status: { label:'Status Black / StatusBreakdown' },
};

const HIST_ALIASES = {
  fecha: ['fecha','date','fecha evento','fecha_evento','timestamp','hora inicio','hora_inicio','inicio','fecha hora','fecha_hora','created at','created_at'],
  planta: ['planta','nombre planta','nombre_planta','plant','site','local','centro','centro sap','centro_sap','local cmd','local_cmd','codigo command','codigo_command','shortname','local inventario','local_inventario'],
  zona: ['zona','zone','region operacional','region_operacional'],
  cliente: ['cliente','customer','nombre cliente','nombre_cliente'],
  patente: ['patente','placa','matricula','license plate','license_plate'],
  camion: ['camion','camión','equipo','equipment','numero equipo','número equipo','numero_equipo','id equipo','id_equipo','mixer','vehiculo','vehículo'],
  operador: ['operador','nombre operador','nombre_operador','id operador','id_operador','cod_conductor','codigo conductor','código conductor','numero funcionario','número funcionario','numero_funcionario','employee','conductor','chofer'],
  estado: ['estado','status','descripcion estado','descripción estado','descripcion_estado','meaning','estado equipo','estado_equipo'],
  evento: ['evento','event','tipo evento','tipo_evento','status change type','status_change_type'],
  tipoMantenimiento: ['tipo mantencion','tipo mantención','tipo mantenimiento','tipo_mantenimiento','maintenance type','maintenance_type'],
  puntualidad: ['puntualidad','adherencia','otif','on time','on_time','cumplimiento','cumplimiento %','cumplimiento_pct'],
  sobreestadia: ['sobreestadia','sobreestadía','sobre estadia','sobre estadía','overstay','demora obra','demora_obra','min sobreestadia','min_sobreestadia'],
  disponibilidad: ['disponibilidad','availability','availability %','availability_pct','disp %','disp_pct'],
  horasMantenimiento: ['horas mantencion','horas mantención','horas mantenimiento','horas_mantenimiento','maintenance hours','maintenance_hours','tiempo taller','tiempo_taller'],
  causa: ['causa','motivo','reason','causa detencion','causa_detencion','falla','failure'],
};

function historicalPick(row, aliases) {
  if (!row || typeof row !== 'object') return null;
  for (const alias of aliases || []) {
    const v=row?.[normalizeKey(alias)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}
function historicalNumber(v, percent=false) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (percent && v >= 0 && v <= 1) return round1(v*100);
    return round1(v);
  }
  const s=String(v).trim().replace(/\s/g,'').replace('%','').replace(/\.(?=\d{3}(?:\D|$))/g,'').replace(',','.');
  const n=Number(s);
  if (!Number.isFinite(n)) return null;
  if (percent && n >= 0 && n <= 1 && !String(v).includes('%')) return round1(n*100);
  return round1(n);
}
function historicalDate(row, source='') {
  // Primero reutiliza el motor operacional, que también entiende Semana + Día para Turnos.
  try {
    const mappedType = source==='status' ? 'logeo' : source;
    const inferred = rowDateKey(row, mappedType);
    if (inferred) return inferred;
  } catch {}
  const direct=parseDateKey(historicalPick(row,HIST_ALIASES.fecha));
  if (direct) return direct;
  for (const v of Object.values(row||{})) {
    if (v instanceof Date) { const d=parseDateKey(v); if(d) return d; }
  }
  return null;
}
function historicalNormalizeRecord(source,row,archivo='') {
  if (!HISTORICAL_SOURCES[source]) throw new Error(`Fuente histórica desconocida: ${source}`);
  const fecha=historicalDate(row,source);
  const plantaRaw=historicalPick(row,HIST_ALIASES.planta);
  let planta='Sin planta';
  if (plantaRaw !== null) {
    const synthetic={}; synthetic[normalizeKey('planta')]=plantaRaw;
    planta=resolvePlantFromRow(synthetic);
    if (!planta || planta==='Sin planta') planta=canonicalPlantName(plantaRaw);
  }
  const zonaRaw=historicalPick(row,HIST_ALIASES.zona);
  const zona=planta && planta!=='Sin planta' ? inferZona(planta,zonaRaw) : (canonicalZone(zonaRaw)||'Sin zona');
  return {
    id: crypto.randomUUID(),
    fecha,
    planta: safeText(planta||'Sin planta'),
    zona: safeText(zona||'Sin zona'),
    cliente: safeText(historicalPick(row,HIST_ALIASES.cliente)),
    patente: safeText(historicalPick(row,HIST_ALIASES.patente)),
    camion: safeText(historicalPick(row,HIST_ALIASES.camion)),
    operador: safeText(historicalPick(row,HIST_ALIASES.operador)),
    estado: safeText(historicalPick(row,HIST_ALIASES.estado)),
    evento: safeText(historicalPick(row,HIST_ALIASES.evento)),
    tipoMantenimiento: safeText(historicalPick(row,HIST_ALIASES.tipoMantenimiento)),
    puntualidad: historicalNumber(historicalPick(row,HIST_ALIASES.puntualidad),true),
    sobreestadia: historicalNumber(historicalPick(row,HIST_ALIASES.sobreestadia),false),
    disponibilidad: historicalNumber(historicalPick(row,HIST_ALIASES.disponibilidad),true),
    horasMantenimiento: historicalNumber(historicalPick(row,HIST_ALIASES.horasMantenimiento),false),
    causa: safeText(historicalPick(row,HIST_ALIASES.causa)),
    fuente: source,
    archivo: safeText(row?.__source_file || archivo),
  };
}
function validateHistoricalRecord(source,rec) {
  const errors=[];
  if (!rec?.fecha) errors.push('Falta fecha válida');
  if (rec?.planta==='Sin planta' && !rec?.camion && !rec?.patente && !rec?.operador) errors.push('Falta identificador operacional (planta/camión/patente/operador)');
  if (source==='status' && !rec?.estado && !rec?.evento) errors.push('Falta estado/evento');
  if (source==='turnos' && !rec?.operador && rec?.planta==='Sin planta') errors.push('Turno sin operador ni planta identificable');
  if (source==='citaciones' && !rec?.operador && rec?.planta==='Sin planta') errors.push('Citación sin operador ni planta identificable');
  return errors;
}
function historicalSourceMeta(source) {
  const s=historicalWarehouse?.sources?.[source];
  return s && typeof s==='object' ? s : {source,label:HISTORICAL_SOURCES[source]?.label||source,status:'sin_datos',records:0,files:[],errors:[]};
}
function historicalPeriodKey(dateStr, granularity='week') {
  if (granularity==='day') return dateStr;
  if (granularity==='month') return String(dateStr).slice(0,7);
  if (granularity==='quarter') {
    const [y,m]=String(dateStr).split('-').map(Number); return `${y}-T${Math.floor((m-1)/3)+1}`;
  }
  if (granularity==='year') return String(dateStr).slice(0,4);
  return isoWeekKey(dateStr);
}
let historicalRuntimeIndex={revision:-1,byDate:new Map(),dates:[],plantCatalog:[]};
function getHistoricalRuntimeIndex() {
  const revision=Number(historicalWarehouse?.revision||0);
  if(historicalRuntimeIndex.revision===revision) return historicalRuntimeIndex;
  const byDate=new Map(), plantMap=new Map();
  for(const r of (Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[]).filter(r=>HISTORICAL_SOURCES[r?.fuente])){
    if(r?.fecha){if(!byDate.has(r.fecha))byDate.set(r.fecha,[]);byDate.get(r.fecha).push(r);}
    const p=safeText(r?.planta),z=safeText(r?.zona);
    if(p&&p!=='Sin planta'&&!plantMap.has(p))plantMap.set(p,{planta:p,zona:z||'Sin zona'});
  }
  historicalRuntimeIndex={revision,byDate,dates:[...byDate.keys()].sort(),plantCatalog:[...plantMap.values()].sort((a,b)=>a.planta.localeCompare(b.planta,'es'))};
  return historicalRuntimeIndex;
}
function historicalFilterRecords(query={}) {
  const idx=getHistoricalRuntimeIndex();
  const from=safeText(query.from||''), to=safeText(query.to||''), zona=safeText(query.zona||'');
  const plantas=String(query.plantas||'').split(',').map(safeText).filter(Boolean);
  const sources=String(query.sources||'').split(',').map(safeText).filter(Boolean);
  const selectedDates=idx.dates.filter(d=>(!from||d>=from)&&(!to||d<=to));
  const candidate=selectedDates.flatMap(d=>idx.byDate.get(d)||[]);
  return candidate.filter(r=>
    (!zona||r.zona===zona)&&
    (!plantas.length||plantas.includes(r.planta))&&
    (!sources.length||sources.includes(r.fuente))
  );
}
function historicalAvg(rows,key) {
  const vals=rows.map(r=>Number(r?.[key])).filter(Number.isFinite);
  return vals.length?round1(vals.reduce((a,b)=>a+b,0)/vals.length):null;
}
function historicalDistinct(rows, keys) {
  const s=new Set();
  for (const r of rows) {
    for (const k of keys) { const v=safeText(r?.[k]); if(v){s.add(v);break;} }
  }
  return s.size;
}
function historicalStatusKind(r) {
  const s=normalizeName(`${r?.estado||''} ${r?.evento||''}`);
  if (/login|pre viaje/.test(s)) return 'login';
  if (/asignado/.test(s)) return 'asignado';
  if (/cargando|cargado/.test(s)) return 'primeraCarga';
  return 'otro';
}
function historicalUniqueOperatorDay(rows, source='') {
  const set=new Set();
  for(const r of rows){
    if(source && r?.fuente!==source) continue;
    const op=safeText(r?.operador), d=safeText(r?.fecha);
    if(op&&d)set.add(`${d}|${normalizeId(op)}`);
  }
  return set.size;
}
function aggregateHistoricalEnterprise(rows, granularity='week') {
  const groups=new Map();
  for (const r of rows) {
    const key=historicalPeriodKey(r.fecha,granularity);
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(r);
  }
  return [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([periodo,items])=>{
    const status=items.filter(r=>r.fuente==='status');
    return {
      periodo,
      registros:items.length,
      turnos:items.filter(r=>r.fuente==='turnos').length,
      citaciones:items.filter(r=>r.fuente==='citaciones').length,
      statusEventos:status.length,
      logins:status.filter(r=>historicalStatusKind(r)==='login').length,
      asignados:status.filter(r=>historicalStatusKind(r)==='asignado').length,
      primeraCarga:status.filter(r=>historicalStatusKind(r)==='primeraCarga').length,
    };
  });
}
function rankHistorical(rows,key='planta') {
  const map=new Map();
  for(const r of rows){const k=safeText(r?.[key])||`Sin ${key}`;if(!map.has(k))map.set(k,[]);map.get(k).push(r);}
  return [...map.entries()].map(([nombre,items])=>({
    nombre,
    registros:items.length,
    turnos:items.filter(r=>r.fuente==='turnos').length,
    citaciones:items.filter(r=>r.fuente==='citaciones').length,
    status:items.filter(r=>r.fuente==='status').length,
  })).sort((a,b)=>b.registros-a.registros||a.nombre.localeCompare(b.nombre,'es'));
}
function paretoHistorical(rows) {
  const m=new Map();
  for(const r of rows.filter(x=>x.fuente==='status')){const cause=safeText(r.estado||r.evento);if(cause)m.set(cause,(m.get(cause)||0)+1);}
  return [...m.entries()].map(([causa,cantidad])=>({causa,cantidad})).sort((a,b)=>b.cantidad-a.cantidad).slice(0,20);
}
function heatmapHistorical(rows) {
  const m=new Map();
  for(const r of rows){if(!r.fecha)continue;const key=`${r.planta||'Sin planta'}|${r.fecha}`;m.set(key,(m.get(key)||0)+1);}
  return [...m.entries()].map(([key,valor])=>{const [planta,fecha]=key.split('|');return {planta,fecha,valor};}).slice(0,5000);
}

app.post('/api/historico/ingesta', requireAuth, (req,res)=>{
  try{
    const source=safeText(req.body?.source||''), incoming=req.body?.datos, archivo=safeText(req.body?.archivo||'archivo'), modo=safeText(req.body?.modo||'append').toLowerCase();
    if(!HISTORICAL_SOURCES[source]) return res.status(400).json({error:`Fuente histórica inválida: ${source}`});
    if(!Array.isArray(incoming)||!incoming.length) return res.status(400).json({error:'La carpeta/archivo no contiene filas para procesar'});
    const normalized=normalizeRows(incoming), valid=[], rejected=[], errors=[];
    normalized.forEach((row,i)=>{const rec=historicalNormalizeRecord(source,row,archivo), er=validateHistoricalRecord(source,rec);if(er.length){rejected.push(rec);errors.push({fila:i+1,archivo,errores:er});}else valid.push(rec);});
    if(!valid.length) return res.status(422).json({error:`${HISTORICAL_SOURCES[source].label}: ninguna fila superó la validación`,errores:errors.slice(0,20)});
    if(!Array.isArray(historicalWarehouse.records)) historicalWarehouse.records=[];
    if(modo==='replace'){historicalWarehouse.records=historicalWarehouse.records.filter(r=>r.fuente!==source);historicalWarehouse.sources[source]={};}
    historicalWarehouse.records.push(...valid);
    const prev=historicalSourceMeta(source), files=[...new Set([...(Array.isArray(prev.files)?prev.files:[]),archivo].filter(Boolean))], sourceRows=historicalWarehouse.records.filter(r=>r.fuente===source), dates=sourceRows.map(r=>r.fecha).filter(Boolean).sort();
    historicalWarehouse.sources[source]={source,label:HISTORICAL_SOURCES[source].label,status:'cargado',records:sourceRows.length,files,minDate:dates[0]||null,maxDate:dates.at(-1)||null,lastLoadedAt:nowIso(),loadedBy:req.user?.nombre||'Sistema',rejected:Number(prev.rejected||0)+rejected.length,errors:[...(Array.isArray(prev.errors)?prev.errors:[]),...errors].slice(-100)};
    historicalWarehouse.revision=Number(historicalWarehouse.revision||0)+1;historicalWarehouse.loaded_at=nowIso();historicalRuntimeIndex.revision=-1;persistHistoricalWarehouse();
    return res.json({ok:true,source,cantidad:sourceRows.length,cantidad_lote:valid.length,rechazadas:rejected.length,meta:historicalWarehouse.sources[source]});
  }catch(err){
    registrarErrorDetallado({modulo:'historico',funcion:'POST /api/historico/ingesta',error:err?.message||String(err),stack:err?.stack});
    return res.status(422).json({error:'No fue posible consolidar la carpeta histórica',detalle:err?.message||String(err)});
  }
});

app.get('/api/historico/fuentes', requireAuth, (req,res)=>{
  const records=(Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[]).filter(r=>HISTORICAL_SOURCES[r?.fuente]);
  const idx=getHistoricalRuntimeIndex();
  const plants=idx.plantCatalog.map(x=>x.planta);
  const zones=[...new Set(idx.plantCatalog.map(x=>x.zona).filter(z=>z&&z!=='Sin zona'))].sort((a,b)=>a.localeCompare(b,'es'));
  return res.json({ok:true,revision:Number(historicalWarehouse?.revision||0),totalRecords:records.length,loadedAt:historicalWarehouse?.loaded_at||null,sources:Object.keys(HISTORICAL_SOURCES).map(k=>({source:k,label:HISTORICAL_SOURCES[k].label,...historicalSourceMeta(k)})),plants,zones,plantCatalog:idx.plantCatalog});
});

app.get('/api/historico/dashboard-enterprise', requireAuth, (req,res)=>{
  try{
    const granularity=['day','week','month','quarter','year'].includes(String(req.query.granularity))?String(req.query.granularity):'week';
    const rows=historicalFilterRecords(req.query).filter(r=>HISTORICAL_SOURCES[r?.fuente]);
    const all=(Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[]).filter(r=>HISTORICAL_SOURCES[r?.fuente]);
    const dates=rows.map(r=>r.fecha).filter(Boolean).sort();
    const statusRows=rows.filter(r=>r.fuente==='status');
    const kpis={
      totalRegistros:rows.length,
      turnosHistoricos:rows.filter(r=>r.fuente==='turnos').length,
      citacionesHistoricas:rows.filter(r=>r.fuente==='citaciones').length,
      eventosStatus:statusRows.length,
      totalOperadores:historicalDistinct(rows,['operador']),
      totalPlantas:new Set(rows.map(r=>r.planta).filter(p=>p&&p!=='Sin planta')).size,
      diasDisponibles:new Set(rows.map(r=>r.fecha).filter(Boolean)).size,
      loginsDetectados:statusRows.filter(r=>historicalStatusKind(r)==='login').length,
      asignadosDetectados:statusRows.filter(r=>historicalStatusKind(r)==='asignado').length,
      primeraCargaDetectada:statusRows.filter(r=>historicalStatusKind(r)==='primeraCarga').length,
      operadoresTurnoDia:historicalUniqueOperatorDay(rows,'turnos'),
      operadoresStatusDia:historicalUniqueOperatorDay(rows,'status'),
    };
    const series=aggregateHistoricalEnterprise(rows,granularity), plantRank=rankHistorical(rows,'planta'), zoneRank=rankHistorical(rows,'zona');
    const equipMap=new Map(), opMap=new Map();
    for(const r of statusRows){const eq=safeText(r.camion||r.patente);if(eq)equipMap.set(eq,(equipMap.get(eq)||0)+1);const op=safeText(r.operador);if(op)opMap.set(op,(opMap.get(op)||0)+1);}
    return res.json({
      ok:true,source:'historicalWarehouse:turnos+citaciones+status',granularity,from:req.query.from||null,to:req.query.to||null,totalBase:all.length,minDate:dates[0]||null,maxDate:dates.at(-1)||null,kpis,series,
      rankings:{plantas:plantRank,zonas:zoneRank,equipos:[...equipMap.entries()].map(([equipo,eventos])=>({equipo,eventos})).sort((a,b)=>b.eventos-a.eventos).slice(0,20),operadores:[...opMap.entries()].map(([operador,eventos])=>({operador,asignaciones:eventos})).sort((a,b)=>b.asignaciones-a.asignaciones).slice(0,20)},
      pareto:paretoHistorical(rows),heatmap:heatmapHistorical(rows),
      plants:[...new Set(rows.map(r=>r.planta).filter(p=>p&&p!=='Sin planta'))].sort((a,b)=>a.localeCompare(b,'es')),
      zones:[...new Set(rows.map(r=>r.zona).filter(z=>z&&z!=='Sin zona'))].sort((a,b)=>a.localeCompare(b,'es')),
      sources:Object.keys(HISTORICAL_SOURCES).map(k=>({source:k,label:HISTORICAL_SOURCES[k].label,...historicalSourceMeta(k)})),
      empty:rows.length===0,mensaje:rows.length?'':'NO SE ENCONTRARON DATOS PARA EL PERÍODO SELECCIONADO',
    });
  }catch(err){
    registrarErrorDetallado({modulo:'historico',funcion:'GET /api/historico/dashboard-enterprise',error:err?.message||String(err),stack:err?.stack});
    return res.status(422).json({error:'No fue posible construir el tablero histórico',detalle:err?.message||String(err)});
  }
});

function historyScopeKey({ zona=null, region=null, planta=null, plantasFiltro=null } = {}) {
  if (planta) return `PLANTA:${planta}`;
  if (Array.isArray(plantasFiltro) && plantasFiltro.length) return `PLANTAS:${[...plantasFiltro].sort().join('|')}`;
  if (region) return `REGION:${region}`;
  if (zona) return `ZONA:${zona}`;
  return 'NACIONAL';
}


function getHistoricalSnapshots() {
  if (!Array.isArray(state.historicalSnapshots)) {
    state.historicalSnapshots = Array.isArray(state.historico) ? [...state.historico] : [];
  }
  return state.historicalSnapshots;
}

function snapshotSourceAudit(fecha) {
  const tipos=['turnos','citaciones','logeo'];
  const fuentes={};
  for (const tipo of tipos) {
    const meta = state?.datasets?.[tipo]?.metadatos || {};
    fuentes[tipo] = {
      archivos: Array.isArray(meta.archivos) ? [...meta.archivos] : (meta.archivo ? [meta.archivo] : []),
      revision: Number(meta.revision || 0),
      cantidad: Number(meta.cantidad || 0),
      cargado_en: meta.cargado_en || null,
      subido_por: meta.subido_por || null,
      filas_fecha: filterRowsForDate(getDatasetRows(tipo), fecha, tipo).length,
    };
  }
  return fuentes;
}

function validarOperacionDiaria(payload, fecha) {
  if (!payload || typeof payload !== 'object') throw new Error('Payload diario inválido');
  if (!fecha || payload.fecha !== fecha) throw new Error('La fecha del reporte no coincide con la fecha operacional activa');
  const r = payload.resumen || {};
  const nums=['programadosExigibles','logeadosAlCorte','pendientesIngreso','asignados','primeraCarga'];
  for (const k of nums) if (!Number.isFinite(Number(r[k]))) throw new Error(`KPI diario inválido: ${k}`);
  const p=Number(r.programadosExigibles), l=Number(r.logeadosAlCorte), pend=Number(r.pendientesIngreso), a=Number(r.asignados), c=Number(r.primeraCarga);
  if (p < 0 || l < 0 || pend < 0 || a < 0 || c < 0) throw new Error('Los KPIs diarios no pueden ser negativos');
  if (l > p) throw new Error('Con logeo no puede superar Programados');
  if (pend !== Math.max(0,p-l)) throw new Error('Pendientes no coincide con Programados - Con logeo');
  if (a > l) throw new Error('Asignados no puede superar Con logeo');
  if (c > a) throw new Error('Primera carga no puede superar Asignados');
  const fuentes = r.fuentes || sourceCoverageForDate(fecha);
  if (!fuentes || Number(fuentes.turnosFilas||0) <= 0) throw new Error('No existen Turnos para la fecha operacional');
  if (Number(fuentes.logeoFilas||0) <= 0) throw new Error('No existe StatusBreakdown para la fecha operacional');
  return { ok:true, fuentes };
}

function validarTrazabilidadHistorica(rows) {
  if (!Array.isArray(rows)) throw new TypeError('historicalSnapshots debe ser un arreglo');
  const errores=[];
  for (const [i,snap] of rows.entries()) {
    if (!snap || typeof snap !== 'object') { errores.push(`Snapshot ${i+1} inválido`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snap.fecha||''))) errores.push(`Snapshot ${i+1} sin fecha válida`);
    if (!snap.resumen || typeof snap.resumen !== 'object') errores.push(`Snapshot ${i+1} sin resumen`);
    if (!Array.isArray(snap.porPlanta)) errores.push(`Snapshot ${i+1} sin apertura por planta`);
  }
  return { ok:errores.length===0, errores };
}

function validarConsistenciaHistorica(rows) {
  const errores=[];
  for (const snap of rows) {
    const r=snap?.resumen || {};
    const p=Number(r.programadosExigibles ?? r.totalTurnos ?? 0);
    const l=Number(r.logeadosAlCorte ?? r.totalLogeo ?? 0);
    const pend=Number(r.pendientesIngreso ?? Math.max(0,p-l));
    const a=Number(r.asignados ?? 0);
    const c=Number(r.primeraCarga ?? 0);
    if ([p,l,pend,a,c].some(x=>!Number.isFinite(x) || x<0)) errores.push(`${snap?.fecha||'sin fecha'}: KPI histórico inválido`);
    if (l>p) errores.push(`${snap?.fecha||'sin fecha'}: Logeados > Programados`);
    if (pend!==Math.max(0,p-l)) errores.push(`${snap?.fecha||'sin fecha'}: Pendientes inconsistente`);
    if (a>l) errores.push(`${snap?.fecha||'sin fecha'}: Asignados > Logeados`);
    if (c>a) errores.push(`${snap?.fecha||'sin fecha'}: Primera carga > Asignados`);
  }
  return { ok:errores.length===0, errores };
}

function saveHistorySnapshot(payload, req) {
  if (!payload || !payload.fecha || !payload.resumen) throw new Error('No se puede crear snapshot: reporte diario incompleto');
  validarOperacionDiaria(payload, payload.fecha);
  const snapshots = getHistoricalSnapshots();
  const scope = { zona:null, region:null, planta:null, plantasFiltro:null };
  const scopeKey = 'NACIONAL';
  const snapshot = {
    id: crypto.randomUUID(),
    tipo: 'historicalSnapshot',
    fecha: payload.fecha,
    scopeKey,
    scope,
    generado_en: nowIso(),
    generado_por: req.user?.nombre || 'Sistema',
    resumen: structuredClone(payload.resumen),
    porPlanta: Array.isArray(payload.porPlanta) ? structuredClone(payload.porPlanta) : [],
    origen: snapshotSourceAudit(payload.fecha),
    origen_version: '3.0',
  };
  const idx = snapshots.findIndex(h => h.fecha === snapshot.fecha && h.scopeKey === scopeKey);
  if (idx >= 0) { snapshot.id = snapshots[idx].id; snapshots[idx] = snapshot; }
  else snapshots.unshift(snapshot);
  state.historicalSnapshots = snapshots.slice(0,5000);
  state.historico = state.historicalSnapshots; // compatibilidad de lectura con versiones anteriores
  persistState();
  return { ok:true, snapshotId:snapshot.id, fecha:snapshot.fecha, scopeKey };
}

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-S${String(week).padStart(2,'0')}`;
}

function historyPeriodKey(dateStr, granularity) {
  if (granularity === 'month') return String(dateStr).slice(0,7);
  if (granularity === 'week') return isoWeekKey(dateStr);
  return dateStr;
}

function aggregateHistory(rows, granularity) {
  const groups = new Map();
  for (const row of rows) {
    const key = historyPeriodKey(row.fecha, granularity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([periodo, items]) => {
    const sum = (fn) => items.reduce((acc,x)=>acc+(Number(fn(x))||0),0);
    const avg = (fn) => items.length ? round1(sum(fn)/items.length) : 0;
    const totalProg = sum(x=>x.resumen?.programadosExigibles ?? x.resumen?.totalTurnos ?? 0);
    const weighted = (field) => totalProg ? round1(items.reduce((acc,x)=>{
      const n=Number(x.resumen?.[field]);
      const w=Number(x.resumen?.programadosExigibles ?? x.resumen?.totalTurnos ?? 0);
      return acc + (Number.isFinite(n) ? n*w : 0);
    },0)/totalProg) : null;
    const tmVals = items.map(x=>Number(x.resumen?.tiempoMuertoPromedioMin)).filter(Number.isFinite);
    return {
      periodo,
      dias: items.length,
      desde: items.map(x=>x.fecha).sort()[0],
      hasta: items.map(x=>x.fecha).sort().slice(-1)[0],
      programadosPromedio: avg(x=>x.resumen?.programadosExigibles ?? x.resumen?.totalTurnos ?? 0),
      logeadosPromedio: avg(x=>x.resumen?.logeadosAlCorte ?? x.resumen?.totalLogeo ?? 0),
      asignadosPromedio: avg(x=>x.resumen?.asignados ?? 0),
      primeraCargaPromedio: avg(x=>x.resumen?.primeraCarga ?? 0),
      pendientesPromedio: avg(x=>x.resumen?.pendientesIngreso ?? 0),
      criticosPromedio: avg(x=>x.resumen?.operadoresCriticos ?? 0),
      cumplimientoReferenciaPct: weighted('cumplimientoReferenciaPct'),
      cumplimientoCitacionPct: weighted('cumplimientoCitacionPct'),
      cumplimientoTurnoPct: weighted('cumplimientoTurnoPct'),
      tiempoMuertoPromedioMin: tmVals.length ? round1(tmVals.reduce((a,b)=>a+b,0)/tmVals.length) : null,
    };
  });
}

app.get('/api/reporte', requireAuth, (req, res) => {
  try {
      const fecha = safeText(req.query.fecha || req.user.fecha || '');
      const built = buildRecordsWithDiagnostics(fecha);
      let records = filterScope(built.records, req.query);
      if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
      if (req.user.region) records = records.filter(r=>r.region===req.user.region);
      if (req.user.planta) records = records.filter(r=>r.planta===req.user.planta);
      const plantNames = [...new Set(records.map(r=>r.planta))];
      if (!plantNames.length) return respuestaSinDatos(res, 'Sin información disponible para el período seleccionado', {
        fecha, generado_por:req.user?.nombre || 'Sistema', generado_en:nowIso(),
        resumen:{ totalTurnos:0, programadosExigibles:0, totalCitaciones:0, operadoresConCitacion:0, operadoresPorTurno:0, cumplimientoReferenciaPct:null, cumplimientoCitacionPct:null, cumplimientoTurnoPct:null, totalLogeo:0, logeadosAlCorte:0, pendientesIngreso:0, asignados:0, primeraCarga:0, operadoresCriticos:0, tiempoMuertoPromedioMin:null, adelantadosPct:null, adelantadosCantidad:0, filasSinReconocer:0 },
        porPlanta:[], rankingAdelantados:[], rankingTiempoMuertoNacional:[], erroresConstruccion:Array.isArray(built.errors)?built.errors:[]
      });
      const byPlant = plantNames.map(planta=>{
        const rs=records.filter(r=>r.planta===planta);
        const logged=rs.filter(r=>hasMinute(r.logeoMin));
        const tm=rs.filter(r=>hasMinute(r.tiempoMuertoMin));
        return {
          planta,
          zona:ensurePlant(planta).zona,
          region:ensurePlant(planta).region,
          turnos:rs.length,
          citaciones:rs.filter(r=>r.citacionAplicada).length,
          logeo:logged.length,
          asignados:rs.filter(r=>hasMinute(r.asignacionMin)).length,
          primeraCarga:rs.filter(r=>hasMinute(r.primeraCargaMin)).length,
          pendientesIngreso:rs.filter(r=>!hasMinute(r.logeoMin)).length,
          adherenciaLogeo:rs.length?round1(logged.length/rs.length*100):null,
          cumplimientoReferencia:rs.length?round1(rs.filter(r=>r.categoria==='a_tiempo').length/rs.length*100):null,
          tiempoMuertoPromedioMin:tm.length?round1(tm.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tm.length):null,
        };
      });
      const tmAll=records.filter(r=>hasMinute(r.tiempoMuertoMin));
      const adelantados=records.filter(r=>r.categoria==='adelantado');
      let unknown = 0;
      try {
        const citationRows = Array.isArray(getCitaciones()) ? getCitaciones() : [];
        const logRows = Array.isArray(getLogeo()) ? getLogeo() : [];
        unknown = [...citationRows,...logRows].filter(r=>{
          const p=safeText(pick(r,FIELDS.planta));
          if(!p) return false;
          const canon=canonicalPlantName(p);
          return !state.plantas?.[canon];
        }).length;
      } catch (qualityErr) {
        console.error('WARN calidad de datos en reporte:', qualityErr?.message || qualityErr);
        unknown = 0;
      }
      const payload = {
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
          totalCitaciones:records.filter(r=>r.citacionAplicada).length,
          operadoresConCitacion:records.filter(r=>r.citacionAplicada).length,
          operadoresPorTurno:records.filter(r=>!r.citacionAplicada).length,
          cumplimientoReferenciaPct:records.length?round1(records.filter(r=>r.categoria==='a_tiempo').length/records.length*100):null,
          cumplimientoCitacionPct:records.filter(r=>r.citacionAplicada).length?round1(records.filter(r=>r.citacionAplicada && r.categoria==='a_tiempo').length/records.filter(r=>r.citacionAplicada).length*100):null,
          cumplimientoTurnoPct:records.filter(r=>!r.citacionAplicada).length?round1(records.filter(r=>!r.citacionAplicada && r.categoria==='a_tiempo').length/records.filter(r=>!r.citacionAplicada).length*100):null,
          totalLogeo:records.filter(r=>hasMinute(r.logeoMin)).length,
          logeadosAlCorte:records.filter(r=>hasMinute(r.logeoMin)).length,
          pendientesIngreso:records.filter(r=>!hasMinute(r.logeoMin)).length,
          asignados:records.filter(r=>hasMinute(r.asignacionMin)).length,
          primeraCarga:records.filter(r=>hasMinute(r.primeraCargaMin)).length,
          operadoresCriticos:records.filter(r=>r.categoria==='atraso_critico' || (hasMinute(r.logeoMin) && !hasMinute(r.asignacionMin))).length,
          tiempoMuertoPromedioMin:tmAll.length?round1(tmAll.reduce((s,r)=>s+r.tiempoMuertoMin,0)/tmAll.length):null,
          adelantadosPct:records.length?round1(adelantados.length/records.length*100):null,
          adelantadosCantidad:adelantados.length,
          filasSinReconocer:unknown,
          filasSinReconocerDetalle:{ plantaVacia:0, codigoDesconocido:unknown },
          fuentes: sourceCoverageForDate(fecha),
        },
        porPlanta:byPlant,
        rankingAdelantados:[...adelantados].sort((a,b)=>(Number(b.adelantoMin)||0)-(Number(a.adelantoMin)||0)).slice(0,10),
        rankingTiempoMuertoNacional:[...tmAll].sort((a,b)=>(Number(b.tiempoMuertoMin)||0)-(Number(a.tiempoMuertoMin)||0)).slice(0,10),
        erroresConstruccion: built.errors.slice(0,50),
      };
      if (built.errors.length) {
        payload.advertencias = [...(payload.advertencias || []), {codigo:'FILAS_OMITIDAS', mensaje:`${built.errors.length} operador(es) no pudieron procesarse y fueron aislados sin bloquear el reporte.`}];
      }
      try {
        payload.validacionOperacion = validarOperacionDiaria(payload, fecha);
      } catch (validationErr) {
        registrarErrorDetallado({ modulo:'operacion', funcion:'validarOperacionDiaria', error:validationErr?.message||String(validationErr), stack:validationErr?.stack, contexto:{fecha} });
        return res.status(422).json({ error:'No fue posible validar la operación diaria', detalle:validationErr?.message||String(validationErr), fecha });
      }
      return res.json(payload);
  } catch (err) {
    registrarErrorDetallado({ modulo:'reporte', funcion:'GET /api/reporte', error:err?.message || String(err), stack:err?.stack, contexto:{ query:req.query, usuario:req.user?.nombre || '' } });
    return res.status(422).json({ error:'No fue posible procesar el reporte con los datos disponibles', detalle:err?.message || String(err), mensaje_usuario:'Información incompleta o inválida. Revise los archivos cargados.', version:'3.0.0' });
  }
});


app.post('/api/historico/snapshot', requireAuth, (req,res) => {
  try {
    const fecha=safeText(req.body?.fecha || req.query?.fecha || req.user?.fecha || '');
    if (!fecha) return res.status(400).json({error:'Fecha requerida para crear snapshot'});
    const built=buildRecordsWithDiagnostics(fecha);
    let records=Array.isArray(built?.records)?built.records:[];
    if (req.user?.zona) records=records.filter(r=>r?.zona===req.user.zona);
    if (req.user?.region) records=records.filter(r=>r?.region===req.user.region);
    if (req.user?.planta) records=records.filter(r=>r?.planta===req.user.planta);
    if (!records.length) return res.status(422).json({error:'No existen datos diarios válidos para crear snapshot',fecha});
    const porPlanta=recordsToPlantRows(records);
    const tmAll=records.filter(r=>hasMinute(r?.tiempoMuertoMin));
    const cit=records.filter(r=>r?.citacionAplicada);
    const noCit=records.filter(r=>!r?.citacionAplicada);
    const payload={
      fecha, generado_por:req.user?.nombre||'Sistema', generado_en:nowIso(),
      resumen:{
        totalTurnos:records.length, programadosExigibles:records.length,
        totalCitaciones:cit.length, operadoresConCitacion:cit.length, operadoresPorTurno:noCit.length,
        cumplimientoReferenciaPct:records.length?round1(records.filter(r=>r?.categoria==='a_tiempo').length/records.length*100):null,
        cumplimientoCitacionPct:cit.length?round1(cit.filter(r=>r?.categoria==='a_tiempo').length/cit.length*100):null,
        cumplimientoTurnoPct:noCit.length?round1(noCit.filter(r=>r?.categoria==='a_tiempo').length/noCit.length*100):null,
        totalLogeo:records.filter(r=>hasMinute(r?.logeoMin)).length,
        logeadosAlCorte:records.filter(r=>hasMinute(r?.logeoMin)).length,
        pendientesIngreso:records.filter(r=>!hasMinute(r?.logeoMin)).length,
        asignados:records.filter(r=>hasMinute(r?.asignacionMin)).length,
        primeraCarga:records.filter(r=>hasMinute(r?.primeraCargaMin)).length,
        operadoresCriticos:records.filter(r=>r?.categoria==='atraso_critico' || (hasMinute(r?.logeoMin)&&!hasMinute(r?.asignacionMin))).length,
        tiempoMuertoPromedioMin:tmAll.length?round1(tmAll.reduce((s,r)=>s+(Number(r?.tiempoMuertoMin)||0),0)/tmAll.length):null,
        fuentes:sourceCoverageForDate(fecha),
      },
      porPlanta,
    };
    validarOperacionDiaria(payload,fecha);
    const result=saveHistorySnapshot(payload,req);
    state.audit.unshift({id:crypto.randomUUID(),action:'snapshot_historico_creado',fecha,snapshot_id:result.snapshotId,user:req.user?.nombre||'Sistema',timestamp:nowIso()});
    persistState();
    io.emit('historico:snapshot_creado',{fecha,snapshotId:result.snapshotId});
    return res.json({ok:true,...result,mensaje:`Snapshot histórico ${fecha} guardado correctamente`});
  } catch(err) {
    registrarErrorDetallado({modulo:'historico',funcion:'POST /api/historico/snapshot',error:err?.message||String(err),stack:err?.stack,contexto:{fecha:req.body?.fecha||req.query?.fecha||''}});
    return res.status(422).json({error:'No fue posible crear el snapshot histórico',detalle:err?.message||String(err)});
  }
});


app.get('/api/historico', requireAuth, (req,res) => {
  const granularity = ['day','week','month'].includes(String(req.query.granularity)) ? String(req.query.granularity) : 'day';
  const from = safeText(req.query.from || '');
  const to = safeText(req.query.to || '');
  const zona = safeText(req.query.zona || req.user.zona || '');
  const region = safeText(req.query.region || req.user.region || '');
  const planta = safeText(req.query.planta || req.user.planta || '');
  const plantasFiltro = req.query.plantas ? String(req.query.plantas).split(',').map(safeText).filter(Boolean) : null;
  const scopeKey = historyScopeKey({ zona: zona||null, region: region||null, planta: planta||null, plantasFiltro });
  let rows = getHistoricalSnapshots().filter(h => h.scopeKey === scopeKey);
  if (from) rows = rows.filter(h => h.fecha >= from);
  if (to) rows = rows.filter(h => h.fecha <= to);
  rows.sort((a,b)=>a.fecha.localeCompare(b.fecha));
  const series = aggregateHistory(rows, granularity);
  res.json({
    scopeKey,
    scope:{ zona:zona||null, region:region||null, planta:planta||null, plantasFiltro },
    granularity,
    snapshots:rows.length,
    desde: rows[0]?.fecha || null,
    hasta: rows.at(-1)?.fecha || null,
    series,
  });
});


function recordsToPlantRows(records) {
  const safe = Array.isArray(records) ? records : [];
  const plantNames = [...new Set(safe.map(r=>safeText(r?.planta)).filter(Boolean))];
  return plantNames.map(planta=>{
    const rs=safe.filter(r=>r?.planta===planta);
    const logged=rs.filter(r=>hasMinute(r?.logeoMin));
    const tm=rs.filter(r=>hasMinute(r?.tiempoMuertoMin));
    return {
      planta,
      zona:ensurePlant(planta).zona,
      region:ensurePlant(planta).region,
      turnos:rs.length,
      citaciones:rs.filter(r=>r?.citacionAplicada===true).length,
      logeo:logged.length,
      asignados:rs.filter(r=>hasMinute(r?.asignacionMin)).length,
      primeraCarga:rs.filter(r=>hasMinute(r?.primeraCargaMin)).length,
      pendientesIngreso:rs.filter(r=>!hasMinute(r?.logeoMin)).length,
      adherenciaLogeo:rs.length?round1(logged.length/rs.length*100):null,
      cumplimientoReferencia:rs.length?round1(rs.filter(r=>r?.categoria==='a_tiempo').length/rs.length*100):null,
      tiempoMuertoPromedioMin:tm.length?round1(tm.reduce((sum,r)=>sum+(Number(r?.tiempoMuertoMin)||0),0)/tm.length):null,
    };
  });
}

function sourceCoverageForDate(fecha) {
  const turnos=filterRowsForDate(getTurnos(),fecha,'turnos');
  const citaciones=filterRowsForDate(getCitaciones(),fecha,'citaciones');
  const logeo=filterRowsForDate(getLogeo(),fecha,'logeo');
  const uniqueLogOps=new Set(logeo.flatMap(r=>operatorMatchKeys(r)).filter(k=>k.startsWith('id:'))).size;
  return {
    fecha,
    turnosFilas:turnos.length,
    citacionesFilas:citaciones.length,
    logeoFilas:logeo.length,
    operadoresLogeoUnicos:uniqueLogOps,
  };
}

function aggregatePlantHistoricalRows(items) {
  const total = (key) => items.reduce((s,x)=>s+(Number(x[key])||0),0);
  const programados = total('turnos');
  const weightedPct = (key) => {
    if (!programados) return null;
    const acc = items.reduce((s,x)=>{
      const pct = Number(x[key]);
      const w = Number(x.turnos)||0;
      return s + (Number.isFinite(pct) ? pct*w : 0);
    },0);
    return round1(acc/programados);
  };
  return {
    programados,
    logeados: total('logeo'),
    asignados: total('asignados'),
    primeraCarga: total('primeraCarga'),
    pendientes: total('pendientesIngreso'),
    citaciones: total('citaciones'),
    adherenciaPct: weightedPct('cumplimientoReferencia'),
  };
}

app.get('/api/historico/dashboard', requireAuth, (req,res) => {
  return res.status(410).json({error:'Endpoint histórico anterior descontinuado en v3.0',detalle:'Use /api/historico/dashboard-enterprise'});
});

app.get('/api/audit', requireAuth, (req,res)=>res.json(state.audit.slice(0,500)));

// Cualquier ruta /api inexistente SIEMPRE responde JSON. Esto evita que el
// frontend intente interpretar index.html (<!DOCTYPE ...>) como JSON.
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Endpoint API no encontrado',
    metodo: req.method,
    ruta: req.originalUrl,
  });
});

io.on('connection', (socket) => {
  socket.on('join', ({ planta } = {}) => { if (planta) socket.join(`planta:${planta}`); });
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

if (require.main === module && process.env.CCO_TEST_MODE !== '1') {
  server.listen(PORT, () => {
    console.log(`[CCO][startup] CCO Intelligence v3.3.0 activo en puerto ${PORT}`);
    console.log(`[CCO][startup] Diccionario plantas: ${PLANT_DICTIONARY.plants.length} plantas, ${PLANT_DICTIONARY_LOOKUP.size} alias resolubles, ${Object.keys(PLANT_DICTIONARY.conflicts||{}).length} alias ambiguos`);
    if (NODE_ENV === 'production' && AUTH_SECRET === 'cco-dev-secret-change-me') console.warn('[CCO][security] Configure AUTH_SECRET en producción.');
  });
}

module.exports = { app, server, state, _test:{ buildOperatorRecords, buildRecordsWithDiagnostics, validateDataset, normalizeRows, parseTimeMinutes, parseDateKey, filterRowsForDate, ensurePlant, canonicalPlantName, normalizeId, sourceCoverageForDate, recordsToPlantRows, registrarErrorDetallado, FIELDS, historicalNormalizeRecord, validateHistoricalRecord, historicalPeriodKey, aggregateHistoricalEnterprise, historicalAvg, historicalMtbfHours, getHistoricalRuntimeIndex } };
