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
const os = require('os');
const multer = require('multer');
const ExcelJS = require('exceljs');
const XLSXNode = require('xlsx');

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
  return { version: 3, revision: 0, loaded_at: null, sources: {}, records: [], partialRecords: [], diagnostics: [], fileCache: {} };
}
function loadHistoricalWarehouse() {
  try {
    if (!fs.existsSync(HISTORICAL_FILE)) return emptyHistoricalWarehouse();
    const parsed = JSON.parse(fs.readFileSync(HISTORICAL_FILE, 'utf8'));
    // v3.4+ usa un modelo histórico distinto (operador/día + archivos adjuntos).
    // No se mezclan registros heredados de la implementación por carpetas.
    if (Number(parsed?.version || 0) !== 3) {
      console.warn('[CCO][historico] Base histórica anterior detectada; se inicia modelo v2 independiente.');
      return emptyHistoricalWarehouse();
    }
    return {
      ...emptyHistoricalWarehouse(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      sources: parsed?.sources && typeof parsed.sources === 'object' ? parsed.sources : {},
      records: Array.isArray(parsed?.records) ? parsed.records : [],
      partialRecords: Array.isArray(parsed?.partialRecords) ? parsed.partialRecords : [],
      diagnostics: Array.isArray(parsed?.diagnostics) ? parsed.diagnostics : [],
      fileCache: parsed?.fileCache && typeof parsed.fileCache === 'object' ? parsed.fileCache : {},
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
  if (value instanceof Date && !isNaN(value)) return value.getHours() * 60 + value.getMinutes();
  if (typeof value === 'number') {
    if (value > 20_000 && value < 80_000) {
      const fraction = value - Math.floor(value);
      return Math.round(fraction * 1440) % 1440;
    }
    if (value >= 0 && value < 1) return Math.round(value * 1440) % 1440;
    if (Number.isInteger(value) && value >= 0 && value <= 2359) {
      const h = Math.floor(value / 100), m = value % 100;
      if (h <= 23 && m <= 59) return h * 60 + m;
    }
  }
  const s = String(value).trim();
  if(!s) return null;

  // 08:00 / 8:00 / 08:00:00 / 8:00 PM
  let m=s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if(m){
    let h=Number(m[1]),min=Number(m[2]);const ap=(m[3]||'').toUpperCase();
    if(ap){if(h===12)h=0;if(ap==='PM')h+=12;}
    if(h<=23&&min<=59)return h*60+min;
  }
  // 8 AM / 08 PM
  m=s.match(/^(\d{1,2})\s*(AM|PM)$/i);
  if(m){let h=Number(m[1]);const ap=m[2].toUpperCase();if(h===12)h=0;if(ap==='PM')h+=12;if(h<=23)return h*60;}
  // 0800
  m=s.match(/^(\d{1,2})(\d{2})$/);
  if(m){const h=Number(m[1]),min=Number(m[2]);if(h<=23&&min<=59)return h*60+min;}

  const d = new Date(s);
  if (!isNaN(d)) return d.getHours() * 60 + d.getMinutes();
  return null;
}
function normalizePlate(v){
  return String(v??'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9]/g,'').trim();
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
  if (typeof value === 'number') {
    // Excel serial.
    if (value > 20_000 && value < 80_000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
      return d.toISOString().slice(0,10);
    }
    // Unix seconds / milliseconds.
    if (value >= 1_000_000_000 && value < 10_000_000_000) {
      const d=new Date(value*1000); if(!isNaN(d)) return d.toISOString().slice(0,10);
    }
    if (value >= 1_000_000_000_000 && value < 10_000_000_000_000) {
      const d=new Date(value); if(!isNaN(d)) return d.toISOString().slice(0,10);
    }
  }
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-\/]([01]?\d)[-\/]([0-3]?\d)(?:[T\s]|$)/);
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;

  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[T\s]|$)/);
  if (m) {
    let a=Number(m[1]),b=Number(m[2]),y=Number(m[3]),day,month;
    // Chile: ambiguos se interpretan DD/MM. Si el segundo valor >12, es MM/DD.
    if (a > 12) { day=a; month=b; }
    else if (b > 12) { month=a; day=b; }
    else { day=a; month=b; }
    if(month>=1&&month<=12&&day>=1&&day<=31)
      return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

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
  // v3.3.2: la columna I del archivo Flota/Terceros es la fuente autoritativa
  // para la planta asignada del camión. El frontend la envía como campo técnico.
  const assignedPlantColI=fleetPick(row,['__assigned_plant_col_i']);
  const rawPlant=assignedPlantColI || fleetPick(row,['Planta','Nombre Planta','Base','Centro','Ubicación','Ubicacion']);
  let plant='';
  try{
    // Primero homologamos exactamente la planta de columna I con el diccionario.
    plant=dictionaryCanonicalPlant(rawPlant) || canonicalPlantName(rawPlant||'');
    // Solo si columna I viene vacía, permitimos resolver por otros identificadores/códigos.
    if(!plant && !assignedPlantColI) plant=resolvePlantFromRow(row) || canonicalPlantName(plantCode||'');
  }catch{ plant=canonicalPlantName(rawPlant||''); }
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
// CCO INTELLIGENCE v3.6 — ETL HISTÓRICO SERVER-SIDE / STREAMING
// El archivo se sube como binario. XLSX grande se procesa con ExcelJS streaming,
// evitando convertir 482.000+ filas a JSON en el navegador.
// ============================================================================
const HIST_UPLOAD_DIR = path.join(os.tmpdir(),'cco-historical-upload');
try{fs.mkdirSync(HIST_UPLOAD_DIR,{recursive:true});}catch{}
const historicalUpload = multer({
  dest:HIST_UPLOAD_DIR,
  limits:{fileSize:160*1024*1024,files:1}
});
const HIST_JOBS = new Map();
const HIST_ERROR_REPORTS = new Map();
const HIST_VALIDATION_TIMEOUT_MS = 10_000; // 10 s sin progreso, no 10 s totales
const HIST_VALIDATION_STARTUP_TIMEOUT_MS = 60_000; // margen para abrir XLSX grandes
// Lote lógico de procesamiento. 1.000 reduce ~90% de los cambios de contexto
// frente a la versión anterior (100) sin bloquear el event loop.
const HIST_BATCH_SIZE = 1000;
const HIST_QUEUES = {
  turnos:{busy:false,items:[]},
  citaciones:{busy:false,items:[]},
  status:{busy:false,items:[]},
  tam:{busy:false,items:[]},
};

const HIST_ETL_HEADER_ALIASES = {
  operador:['operador','nombre operador','nombre_operador','conductor','chofer','nombre de operador','nombre_de_operador','primero empleado','primero_empleado'],
  operadorId:['id operador','id_operador','id','numero funcionario','número funcionario','numero_funcionario','rut','codigo operador'],
  planta:['planta','planta original','planta_original','descripcion planta','descripción planta','descripcion_planta','centro','sucursal','base'],
  camion:['camion','camión','equipo','mixer','patente','numero equipo','número equipo','numero_equipo','n° camion','n_camion'],
  turno:['hora ingreso','hora_ingreso','turno','inicio turno','inicio_turno','hora turno'],
  citacion:['hora citacion','hora citación','hora_citacion','citacion','citación','citacion sugerida'],
  fecha:['fecha','date','fecha turno','fecha_turno','fecha programada','fecha_programada','fecha inicio semana','fecha_inicio_semana','hora inicio','hora_inicio'],
  semana:['anosemana','ano_semana','semana','semana iso','semana_iso'],
  estado:['descripcion estado','descripción estado','descripcion_estado','estado','status'],
  tamIngreso:['a.hora inicio','a hora inicio','a_hora_inicio','hora inicio tam','ingreso tam'],
  tamSalida:['a. hora fin','a hora fin','a_hora_fin','hora fin tam','salida tam'],
};
const HIST_ETL_REQUIRED = {
  turnos:[['operadorId','operador'],['fecha','semana']],
  citaciones:[['operadorId','operador'],['fecha']],
  status:[['operadorId','operador'],['fecha'],['estado']],
  tam:[['operadorId'],['fecha']],
};
function etlCanonicalHeader(v){
  const k=normalizeKey(v);
  for(const [canonical,aliases] of Object.entries(HIST_ETL_HEADER_ALIASES)){
    if(aliases.some(a=>normalizeKey(a)===k))return canonical;
  }
  return null;
}
function etlCell(v){
  if(v===null||v===undefined)return null;
  if(v instanceof Date)return v;
  if(typeof v==='object'){
    if(v.result!==undefined)return etlCell(v.result);
    if(v.text!==undefined)return v.text;
    if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');
    if(v.hyperlink&&v.text)return v.text;
  }
  return v;
}
function etlRowValues(row){
  const vals=Array.isArray(row?.values)?row.values.slice(1):[];
  return vals.map(etlCell);
}
function etlRowEmpty(vals){return !vals.some(v=>v!==null&&v!==undefined&&String(v).trim()!=='');}
function etlHeaderScore(vals,source){
  const recognized=new Map();
  (vals||[]).forEach((v,i)=>{const c=etlCanonicalHeader(v);if(c&&!recognized.has(c))recognized.set(c,i);});
  const required=HIST_ETL_REQUIRED[source]||[];
  const requiredHits=required.reduce((n,g)=>n+(g.some(x=>recognized.has(x))?1:0),0);
  const textish=(vals||[]).filter(v=>typeof v==='string'&&/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(v)).length;
  return {recognized,requiredHits,requiredTotal:required.length,score:requiredHits*120+recognized.size*25+Math.min(textish,20)};
}
function etlHeaders(vals){
  const seen=new Map();
  return (vals||[]).map((v,i)=>{
    let h=safeText(v)||`col_${i+1}`;const k=normalizeKey(h),n=(seen.get(k)||0)+1;seen.set(k,n);
    return n>1?`${h}_${n}`:h;
  });
}
function etlObject(headers,vals){
  const o={};for(let i=0;i<headers.length;i++)o[headers[i]]=vals[i]??null;return o;
}
function etlLooksMeta(vals,headers){
  if(etlRowEmpty(vals))return {skip:true,code:'FILA_VACIA',field:'fila',reason:'Fila completamente vacía'};
  const txt=vals.filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='').map(v=>normalizeName(v));
  const joined=txt.join(' ');
  if(txt.length<=3&&(joined.startsWith('total')||joined.includes('subtotal')||joined.startsWith('comentario')||joined.startsWith('observacion')))
    return {skip:true,code:'FILA_TOTAL_COMENTARIO',field:'fila',reason:'Fila de total/comentario, no es un registro operacional'};
  const headerKeys=new Set(headers.map(normalizeKey));
  const headerMatches=vals.filter(v=>headerKeys.has(normalizeKey(v))).length;
  if(headerMatches>=Math.max(2,Math.floor(headers.length*.35)))
    return {skip:true,code:'ENCABEZADO_REPETIDO',field:'fila',reason:'Encabezado repetido dentro de los datos'};
  return {skip:false};
}
function etlDiagBase(source,file){
  return {
    id:crypto.randomUUID(),source,file,status:'procesando',startedAt:nowIso(),finishedAt:null,
    sheet:null,headerRow:null,sheetsDetected:[],columns:[],columnCount:0,
    rowsFound:0,rowsStored:0,rowsPartial:0,rowsRejected:0,rowsFiltered:0,duplicates:0,
    missing:[],reason:'Procesando archivo...',ruleCounts:{},samples:[],log:[],
    durationMs:0,memoryMb:0,md5:null,fromCache:false,blocksProcessed:0,currentStage:'Archivo seleccionado',progress:0,_errorRows:[]
  };
}
function etlReason(diag,row,code,field,reason,kind='rejected'){
  diag.ruleCounts[code]=(diag.ruleCounts[code]||0)+1;
  const item={row,code,field,reason,kind};
  if(diag.samples.length<80)diag.samples.push(item);
  if(kind==='rejected'){
    diag.rowsRejected++;
    if(diag._errorRows.length<50_000)diag._errorRows.push(item);
  }else if(kind==='partial'){
    diag.rowsPartial++;
    if(diag._errorRows.length<50_000)diag._errorRows.push(item);
  }else diag.rowsFiltered++;
}
function etlLog(diag,msg){diag.log.push({at:nowIso(),msg});if(diag.log.length>50)diag.log.shift();}
function etlUpdateJob(job,progress,stage,diag=null){
  if(job?.cancelled && Number(progress)<100){
    const e=new Error('Proceso cancelado por exceder el tiempo permitido.');
    e.code='JOB_CANCELLED';throw e;
  }
  job.progress=progress;job.stage=stage;if(diag)job.diagnostic=diag;job.updatedAt=nowIso();
  if(diag){diag.currentStage=stage;diag.progress=progress;}
}
function etlStoreDiagnostic(diag){
  if(!Array.isArray(historicalWarehouse.diagnostics))historicalWarehouse.diagnostics=[];
  historicalWarehouse.diagnostics.unshift({...diag});
  historicalWarehouse.diagnostics=historicalWarehouse.diagnostics.slice(0,200);
}
function etlMissingHeaderGroups(best,source){
  const rec=best?.recognized||new Map();const missing=[];
  for(const group of HIST_ETL_REQUIRED[source]||[])if(!group.some(x=>rec.has(x)))missing.push(group.join(' / '));
  return missing;
}
function etlRecordQuality(rec){
  const missing=[];
  if(!rec.operadorKey)missing.push('OPERADOR');
  if(!rec.fecha)missing.push('FECHA');
  return {partial:missing.length>0,missing};
}
function etlNormalizeRow(source,row,archivo,rowNumber,diag,statusAccumulator=null){
  const r=normalizeRows([row])[0]||{};
  const base={source,archivo,rowIndex:rowNumber,fecha:null,planta:'',zona:'',operadorId:'',operadorNombre:'',operadorKey:'',camion:'',turnoMin:null,citacionMin:null,loginMin:null,asignacionMin:null,primeraCargaMin:null,tamIngresoMin:null,tamSalidaMin:null,tamSindicato:'',tamSubdivision:'',tamJefatura:'',quality:'completo',qualityIssues:[]};

  if(source==='turnos'){
    const id=histPick(r,HIST_FIELD.turnos.operatorId),name=safeText(histPick(r,HIST_FIELD.turnos.operatorName)),key=histOperatorKey(id,name);
    let start=parseDateKey(histPick(r,HIST_FIELD.turnos.start))||parseDateKey(histPick(r,HIST_FIELD.turnos.date));
    if(!start)start=histIsoWeekStart(histPick(r,HIST_FIELD.turnos.week));
    const end=parseDateKey(histPick(r,HIST_FIELD.turnos.end));
    const shift=histTime(histPick(r,HIST_FIELD.turnos.shift));
    const plant=histResolvePlant(histPick(r,HIST_FIELD.turnos.plant));
    if(!key){etlReason(diag,rowNumber,'OPERADOR_NO_IDENTIFICABLE','OPERADOR','No se encontró ID ni nombre de operador','rejected');return [];}
    if(!start){etlReason(diag,rowNumber,'FECHA_NO_RECONOCIBLE','FECHA','No se pudo interpretar fecha de inicio ni semana','rejected');return [];}
    const out=[];
    for(let i=0;i<7;i++){
      const fecha=histDateAdd(start,i);if(!fecha||(end&&fecha>end))break;
      const dow=new Date(`${fecha}T12:00:00`).getDay();if(dow===0||dow===6)continue;
      const rec={...base,fecha,planta:plant,zona:plant?inferZona(plant):'',operadorId:normalizeId(id),operadorNombre:name,operadorKey:key,turnoMin:shift};
      if(shift===null){
        rec.quality='parcial';rec.qualityIssues.push('HORA_TURNO_NO_RECONOCIBLE');
        etlReason(diag,rowNumber,'HORA_TURNO_NO_RECONOCIBLE','HORA_TURNO','La hora de turno no pudo normalizarse; se conserva el registro parcial.','partial');
      }
      if(!plant){
        rec.quality='parcial';rec.qualityIssues.push('PLANTA_NO_HOMOLOGADA');
        etlReason(diag,rowNumber,'PLANTA_NO_HOMOLOGADA','PLANTA','La planta no pudo homologarse con el diccionario; se conserva para KPI nacional/operador.','partial');
      }
      out.push(rec);
    }
    return out;
  }


  if(source==='tam'){
    // Archivo real probado: título fila 1, encabezado fila 2.
    // CRUCE EXCLUSIVO: ID de columna A + Fecha.
    const id=histPick(r,HIST_FIELD.tam.operatorId);
    const name=safeText(histPick(r,HIST_FIELD.tam.operatorName));
    const operadorId=normalizeId(id);
    const key=histOperatorKey(id,name);
    const fecha=parseDateKey(histPick(r,HIST_FIELD.tam.date));
    const rawIngreso=histPick(r,HIST_FIELD.tam.in);
    const rawSalida=histPick(r,HIST_FIELD.tam.out);
    const ingreso=histTime(rawIngreso);
    const salida=histTime(rawSalida);

    if(!key){
      etlReason(diag,rowNumber,'TAM_ID_COLUMNA_A_VACIO','ID','La columna A (ID) está vacía o no es normalizable.','rejected');
      return [];
    }
    if(!fecha){
      etlReason(diag,rowNumber,'TAM_FECHA_NO_RECONOCIBLE','FECHA','No se pudo interpretar la fecha TAM.','rejected');
      return [];
    }

    const rec={
      ...base,fecha,operadorId,operadorNombre:name,operadorKey:key,
      tamIngresoMin:ingreso,tamSalidaMin:salida,
      tamSindicato:safeText(histPick(r,HIST_FIELD.tam.sindicato)),
      tamSubdivision:safeText(histPick(r,HIST_FIELD.tam.subdivision)),
      tamJefatura:safeText(histPick(r,HIST_FIELD.tam.jefe))
    };

    // Celda vacía NO es error de parser. Se consolida por ID + Fecha.
    if(ingreso===null && rawIngreso!==null && rawIngreso!==undefined && String(rawIngreso).trim()!==''){
      rec.quality='parcial';
      rec.qualityIssues.push('TAM_INGRESO_NO_RECONOCIBLE');
      etlReason(
        diag,rowNumber,'TAM_INGRESO_NO_RECONOCIBLE','A.Hora Inicio',
        `Valor presente pero no interpretable (${typeof rawIngreso}): ${String(rawIngreso).slice(0,40)}`,
        'partial'
      );
    }else if(ingreso===null){
      rec.qualityIssues.push('TAM_INGRESO_AUSENTE_EN_FILA');
    }

    if(salida===null && rawSalida!==null && rawSalida!==undefined && String(rawSalida).trim()!==''){
      rec.quality='parcial';
      rec.qualityIssues.push('TAM_SALIDA_NO_RECONOCIBLE');
      etlReason(
        diag,rowNumber,'TAM_SALIDA_NO_RECONOCIBLE','A. Hora Fin',
        `Valor presente pero no interpretable (${typeof rawSalida}): ${String(rawSalida).slice(0,40)}`,
        'partial'
      );
    }else if(salida===null){
      rec.qualityIssues.push('TAM_SALIDA_AUSENTE_EN_FILA');
    }

    return [rec];
  }

  if(source==='citaciones'){
    const id=histPick(r,HIST_FIELD.citaciones.operatorId),name=safeText(histPick(r,HIST_FIELD.citaciones.operatorName)),key=histOperatorKey(id,name);
    const fecha=parseDateKey(histPick(r,HIST_FIELD.citaciones.date)),citation=histTime(histPick(r,HIST_FIELD.citaciones.citation));
    const plant=histResolvePlant(histPick(r,HIST_FIELD.citaciones.plant));
    if(!key){etlReason(diag,rowNumber,'OPERADOR_NO_IDENTIFICABLE','OPERADOR','No se encontró ID ni nombre de operador','rejected');return [];}
    if(!fecha){etlReason(diag,rowNumber,'FECHA_NO_RECONOCIBLE','FECHA','Formato de fecha no reconocible','rejected');return [];}
    const rec={...base,fecha,planta:plant,zona:plant?inferZona(plant):'',operadorId:normalizeId(id),operadorNombre:name,operadorKey:key,citacionMin:citation,camion:normalizePlate(histPick(r,HIST_FIELD.citaciones.truck))||safeText(histPick(r,HIST_FIELD.citaciones.truck))};
    if(citation===null){rec.quality='parcial';rec.qualityIssues.push('HORA_CITACION_NO_RECONOCIBLE');}
    if(!plant){
      rec.quality='parcial';
      rec.qualityIssues.push('PLANTA_NO_INFORMADA');
      etlReason(diag,rowNumber,'PLANTA_NO_INFORMADA','PLANTA','El archivo no contiene planta para esta fila; se conserva para KPI nacional/operador.','partial');
    }
    return [rec];
  }

  // Status: se consolida directamente a operador/día. Eventos no KPI no son
  // "filas descartadas": se registran como filtrados por una regla explícita.
  const dt=histPick(r,HIST_FIELD.status.datetime),fecha=parseDateKey(dt)||parseDateKey(histPick(r,HIST_FIELD.status.date)),eventMin=histTime(dt);
  const state=safeText(histPick(r,HIST_FIELD.status.state)),kind=histStatusKind(state);
  if(kind==='otro'){etlReason(diag,rowNumber,'EVENTO_STATUS_NO_KPI','ESTADO',`Estado "${state||'vacío'}" no participa en LOGIN/ASIGNADO/1ª CARGA`,'filtered');return [];}
  const id=histPick(r,HIST_FIELD.status.operatorId),first=safeText(histPick(r,HIST_FIELD.status.firstName)),last=safeText(histPick(r,HIST_FIELD.status.lastName)),name=[first,last].filter(Boolean).join(' ').trim(),key=histOperatorKey(id,name);
  if(!key){etlReason(diag,rowNumber,'OPERADOR_NO_IDENTIFICABLE','OPERADOR','Evento KPI sin operador identificable','rejected');return [];}
  if(!fecha){etlReason(diag,rowNumber,'FECHA_NO_RECONOCIBLE','HORA_INICIO','No se pudo extraer la fecha del evento','rejected');return [];}
  if(eventMin===null){etlReason(diag,rowNumber,'HORA_EVENTO_NO_RECONOCIBLE','HORA_INICIO','No se pudo interpretar la hora del evento','rejected');return [];}
  const plant=histResolvePlant(histPick(r,HIST_FIELD.status.plant),histPick(r,HIST_FIELD.status.plantCode));
  const accKey=`${fecha}|${key}`;
  if(!statusAccumulator.has(accKey))statusAccumulator.set(accKey,{...base,fecha,planta:plant,zona:plant?inferZona(plant):'',operadorId:normalizeId(id),operadorNombre:name,operadorKey:key,camion:normalizePlate(histPick(r,HIST_FIELD.status.truck))||safeText(histPick(r,HIST_FIELD.status.truck))});
  const rec=statusAccumulator.get(accKey);
  if(!rec.planta&&plant){rec.planta=plant;rec.zona=inferZona(plant);}
  if(kind==='login'&&(rec.loginMin===null||eventMin<rec.loginMin))rec.loginMin=eventMin;
  if(kind==='asignado'&&(rec.asignacionMin===null||eventMin<rec.asignacionMin))rec.asignacionMin=eventMin;
  if(kind==='primera_carga'&&(rec.primeraCargaMin===null||eventMin<rec.primeraCargaMin))rec.primeraCargaMin=eventMin;
  return [];
}

function summarizeTamConsolidation(records,diag){
  if(!Array.isArray(records)||!records.length)return;
  const groups=new Map();
  for(const r of records){
    if(r.source!=='tam'||!r.operadorKey||!r.fecha)continue;
    const key=`${r.operadorKey}|${r.fecha}`;
    if(!groups.has(key))groups.set(key,{rows:[],ingresos:[],salidas:[]});
    const g=groups.get(key);g.rows.push(r);
    if(r.tamIngresoMin!==null&&r.tamIngresoMin!==undefined)g.ingresos.push(r.tamIngresoMin);
    if(r.tamSalidaMin!==null&&r.tamSalidaMin!==undefined)g.salidas.push(r.tamSalidaMin);
  }
  let recovered=0,missingIngreso=0,missingSalida=0;
  for(const [key,g] of groups){
    const blankIngresoRows=g.rows.filter(r=>(r.qualityIssues||[]).includes('TAM_INGRESO_AUSENTE_EN_FILA')).length;
    const blankSalidaRows=g.rows.filter(r=>(r.qualityIssues||[]).includes('TAM_SALIDA_AUSENTE_EN_FILA')).length;
    if(blankIngresoRows&&g.ingresos.length)recovered+=blankIngresoRows;
    if(!g.ingresos.length){
      missingIngreso++;
      if(diag.samples.length<80){
        const first=g.rows[0];
        diag.samples.push({
          row:first.rowIndex,code:'TAM_INGRESO_AUSENTE_DIA',field:'A.Hora Inicio',
          reason:`Sin ingreso TAM recuperable para ID ${first.operadorId||first.operadorKey} en ${first.fecha}.`,
          kind:'partial'
        });
      }
    }
    if(!g.salidas.length)missingSalida++;
  }
  diag.tamConsolidation={
    operatorDays:groups.size,
    blankIngresoRowsRecovered:recovered,
    operatorDaysWithoutIngreso:missingIngreso,
    operatorDaysWithoutSalida:missingSalida
  };
  etlLog(diag,`TAM consolidado por ID columna A + Fecha · ${groups.size.toLocaleString('es-CL')} operador/día · ${recovered.toLocaleString('es-CL')} filas con ingreso vacío recuperadas · ${missingIngreso.toLocaleString('es-CL')} operador/día realmente sin ingreso TAM · ${missingSalida.toLocaleString('es-CL')} sin salida TAM.`);
}

function etlDedupeKey(r){
  if(r.source==='turnos')return `T|${r.fecha}|${r.operadorKey}|${r.turnoMin??''}`;
  if(r.source==='citaciones')return `C|${r.fecha}|${r.operadorKey}|${r.citacionMin??''}`;
  if(r.source==='tam')return `M|${r.fecha}|${r.operadorKey}|${r.tamIngresoMin??''}|${r.tamSalidaMin??''}`;
  return `S|${r.fecha}|${r.operadorKey}`;
}
function etlChooseBest(candidates,source){
  const usable=candidates.filter(c=>c.rows>0&&c.bestHeader);
  if(!usable.length)return null;
  usable.sort((a,b)=>{
    const av=a.bestHeader.requiredHits===a.bestHeader.requiredTotal?1:0,bv=b.bestHeader.requiredHits===b.bestHeader.requiredTotal?1:0;
    if(av!==bv)return bv-av;
    if(a.bestHeader.requiredHits!==b.bestHeader.requiredHits)return b.bestHeader.requiredHits-a.bestHeader.requiredHits;
    if(a.bestHeader.score!==b.bestHeader.score)return b.bestHeader.score-a.bestHeader.score;
    return b.rows-a.rows;
  });
  return usable[0];
}

async function etlProcessXlsx(filePath,source,archivo,job,diag){
  const validationWatchdog=createValidationWatchdog();
  etlUpdateJob(job,25,'Detectando hoja y encabezado',diag);
  const existing=new Set(
    (historicalWarehouse.records||[])
      .filter(r=>r.source===source && safeText(r.archivo)!==safeText(archivo))
      .map(etlDedupeKey)
  );
  const staged=[],partial=[],statusAcc=new Map();
  let selected=false;
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(filePath,{entries:'emit',sharedStrings:'cache',styles:'ignore',hyperlinks:'ignore',worksheets:'emit'});
  for await(const ws of reader){
    checkValidationWatchdog(validationWatchdog);
    const buffered=[];let bestHeader=null,rowNumber=0,headers=null;
    diag.sheetsDetected.push({name:ws.name,rows:0});
    for await(const row of ws){
      rowNumber++;
      markValidationProgress(validationWatchdog,1);
      if(!selected && rowNumber<=100){
        checkValidationWatchdog(validationWatchdog);
        const vals=etlRowValues(row);buffered.push({rowNumber,vals});
        if(!etlRowEmpty(vals)){
          const h=etlHeaderScore(vals,source),score=h.score-rowNumber*.2;
          if(!bestHeader||score>bestHeader.score)bestHeader={...h,score,rowNumber,values:vals};
        }
        if(bestHeader && bestHeader.requiredHits===bestHeader.requiredTotal && bestHeader.score>=250){
          selected=true;diag.sheet=ws.name;diag.headerRow=bestHeader.rowNumber;
          diag.columns=bestHeader.values.map(v=>safeText(v)).filter(Boolean);diag.columnCount=diag.columns.length;
          if(source==='tam' && normalizeKey(bestHeader.values?.[0])!=='id'){
            throw new Error(`Marcaje TAM inválido: el encabezado detectado en fila ${bestHeader.rowNumber} no tiene ID en la columna A.`);
          }
          diag.missing=etlMissingHeaderGroups(bestHeader,source);headers=etlHeaders(bestHeader.values);
          etlLog(diag,`Hoja principal detectada: ${ws.name} · encabezado fila ${diag.headerRow}.`);
          etlUpdateJob(job,35,'Estructura validada · procesando registros',diag);
          for(const b of buffered){
            if(b.rowNumber<=diag.headerRow)continue;
            diag.rowsFound++;
            const meta=etlLooksMeta(b.vals,headers);
            if(meta.skip){etlReason(diag,b.rowNumber,meta.code,meta.field,meta.reason,'filtered');continue;}
            const recs=etlNormalizeRow(source,etlObject(headers,b.vals),archivo,b.rowNumber,diag,statusAcc);
            for(const rec of recs){
              const dk=etlDedupeKey(rec);if(existing.has(dk)){diag.duplicates++;continue;}existing.add(dk);
              if(rec.quality==='parcial')partial.push(rec);staged.push(rec);
            }
          }
          continue;
        }
        continue;
      }
      if(!selected)continue;
      if(ws.name!==diag.sheet)break;
      const vals=etlRowValues(row);diag.rowsFound++;
      const meta=etlLooksMeta(vals,headers);
      if(meta.skip){etlReason(diag,rowNumber,meta.code,meta.field,meta.reason,'filtered');continue;}
      const recs=etlNormalizeRow(source,etlObject(headers,vals),archivo,rowNumber,diag,statusAcc);
      for(const rec of recs){
        const dk=etlDedupeKey(rec);if(existing.has(dk)){diag.duplicates++;continue;}existing.add(dk);
        if(rec.quality==='parcial')partial.push(rec);staged.push(rec);
      }
      if(diag.rowsFound%HIST_BATCH_SIZE===0){
        diag.blocksProcessed++;
        diag.rowsStored=source==='status'?statusAcc.size:staged.length;
        const p=Math.min(94,35+Math.floor(Math.log10(Math.max(diag.rowsFound,10))*12));
        etlUpdateJob(job,p,`Procesando bloque ${diag.blocksProcessed.toLocaleString('es-CL')} · ${diag.rowsFound.toLocaleString('es-CL')} filas · ${diag.rowsStored.toLocaleString('es-CL')} válidos`,diag);
        await yieldEventLoop();
      }
    }
    const entry=diag.sheetsDetected.find(x=>x.name===ws.name);if(entry)entry.rows=rowNumber;
    if(selected)break;
  }
  if(!selected)throw new Error('No se encontró una tabla con las columnas mínimas durante los primeros 10 segundos de validación.');
  if(source==='status'){
    for(const rec of statusAcc.values()){
      const dk=etlDedupeKey(rec);if(existing.has(dk)){diag.duplicates++;continue;}existing.add(dk);
      if(!rec.planta){rec.quality='parcial';rec.qualityIssues.push('PLANTA_NO_INFORMADA');diag.rowsPartial++;}
      staged.push(rec);
    }
  }
  if(source==='tam')summarizeTamConsolidation(staged,diag);
  diag.rowsStored=staged.length;
  replaceHistoricalFileRecords(source,archivo,staged,diag);
  if(partial.length){
    if(!Array.isArray(historicalWarehouse.partialRecords))historicalWarehouse.partialRecords=[];
    historicalWarehouse.partialRecords.push(...partial.slice(0,5000));
    historicalWarehouse.partialRecords=historicalWarehouse.partialRecords.slice(-10000);
  }
  return staged;
}

function etlSheetJsRows(filePath,source,diag){
  const wb=XLSXNode.readFile(filePath,{cellDates:true,cellNF:false,cellStyles:false});
  const candidates=[];
  for(const name of wb.SheetNames){
    const ws=wb.Sheets[name],matrix=XLSXNode.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
    let bestHeader=null;for(let i=0;i<Math.min(matrix.length,100);i++){if(etlRowEmpty(matrix[i]||[]))continue;const h=etlHeaderScore(matrix[i],source),score=h.score-i*.2;if(!bestHeader||score>bestHeader.score)bestHeader={...h,score,rowNumber:i+1,values:matrix[i]};}
    candidates.push({sheetName:name,rows:matrix.length,bestHeader,matrix});
    diag.sheetsDetected.push({name,rows:matrix.length});
  }
  return {wb,best:etlChooseBest(candidates,source)};
}
async function etlProcessNonXlsx(filePath,ext,source,archivo,job,diag){
  const validationWatchdog=createValidationWatchdog();
  etlUpdateJob(job,25,'Detectando estructura',diag);
  let wb;
  if(ext==='csv'||ext==='txt'){
    const text=fs.readFileSync(filePath,'utf8');if(!text.trim())throw new Error('El archivo está vacío.');
    wb=XLSXNode.read(text,{type:'string',raw:true});
  }else wb=XLSXNode.readFile(filePath,{cellDates:true,raw:true});
  const candidates=[];
  for(const name of wb.SheetNames){
    const ws=wb.Sheets[name],matrix=XLSXNode.utils.sheet_to_json(ws,{header:1,defval:null,raw:true});
    let bestHeader=null;for(let i=0;i<Math.min(matrix.length,100);i++){if(etlRowEmpty(matrix[i]||[]))continue;const h=etlHeaderScore(matrix[i],source),score=h.score-i*.2;if(!bestHeader||score>bestHeader.score)bestHeader={...h,score,rowNumber:i+1,values:matrix[i]};}
    candidates.push({sheetName:name,rows:matrix.length,bestHeader,matrix});diag.sheetsDetected.push({name,rows:matrix.length});
  }
  markValidationProgress(validationWatchdog,1);
  checkValidationWatchdog(validationWatchdog);
  const best=etlChooseBest(candidates,source);if(!best)throw new Error('No se encontró ninguna hoja/tabla con datos.');
  diag.sheet=best.sheetName;diag.headerRow=best.bestHeader.rowNumber;diag.columns=best.bestHeader.values.map(v=>safeText(v)).filter(Boolean);diag.columnCount=diag.columns.length;diag.missing=etlMissingHeaderGroups(best.bestHeader,source);
  if(source==='tam' && normalizeKey(best.bestHeader.values?.[0])!=='id')throw new Error('Marcaje TAM inválido: la columna A debe corresponder a ID.');
  etlUpdateJob(job,55,'Procesando registros',diag);
  const headers=etlHeaders(best.bestHeader.values),existing=new Set(
    (historicalWarehouse.records||[])
      .filter(r=>r.source===source && safeText(r.archivo)!==safeText(archivo))
      .map(etlDedupeKey)
  ),staged=[],statusAcc=new Map();
  const matrix=best.matrix;
  for(let i=diag.headerRow;i<matrix.length;i++){
    const vals=matrix[i]||[];diag.rowsFound++;
    const meta=etlLooksMeta(vals,headers);if(meta.skip){etlReason(diag,i+1,meta.code,meta.field,meta.reason,'filtered');continue;}
    const recs=etlNormalizeRow(source,etlObject(headers,vals),archivo,i+1,diag,statusAcc);
    for(const rec of recs){const dk=etlDedupeKey(rec);if(existing.has(dk)){diag.duplicates++;continue;}existing.add(dk);if(rec.quality==='parcial')diag.rowsPartial++;staged.push(rec);}
    if(diag.rowsFound%HIST_BATCH_SIZE===0){
      diag.blocksProcessed++;
      diag.rowsStored=source==='status'?statusAcc.size:staged.length;
      const p=Math.min(94,55+Math.floor(Math.log10(Math.max(diag.rowsFound,10))*10));
      etlUpdateJob(job,p,`Procesando bloque ${diag.blocksProcessed.toLocaleString('es-CL')} · ${diag.rowsFound.toLocaleString('es-CL')} filas · ${diag.rowsStored.toLocaleString('es-CL')} válidos`,diag);
      await yieldEventLoop();
    }
  }
  if(source==='status')for(const rec of statusAcc.values()){const dk=etlDedupeKey(rec);if(existing.has(dk)){diag.duplicates++;continue;}existing.add(dk);staged.push(rec);}
  if(source==='tam')summarizeTamConsolidation(staged,diag);
  diag.rowsStored=staged.length;replaceHistoricalFileRecords(source,archivo,staged,diag);return staged;
}

function replaceHistoricalFileRecords(source,archivo,newRecords,diag){
  const before=historicalWarehouse.records||[];
  const old=before.filter(r=>r.source===source && safeText(r.archivo)===safeText(archivo));
  const keep=before.filter(r=>!(r.source===source && safeText(r.archivo)===safeText(archivo)));
  historicalWarehouse.records=[...keep,...newRecords];
  diag.replacedPreviousRecords=old.length;
  etlLog(diag,`Reproceso controlado: ${old.length.toLocaleString('es-CL')} registros anteriores del mismo archivo fueron reemplazados por ${newRecords.length.toLocaleString('es-CL')} registros nuevos.`);
}

function etlRefreshSourceMeta(source,archivo,diag,user){
  const rows=(historicalWarehouse.records||[]).filter(r=>r.source===source),dates=rows.map(r=>r.fecha).filter(Boolean).sort(),prev=historicalWarehouse.sources?.[source]||{};
  historicalWarehouse.sources[source]={...prev,source,label:HISTORICAL_SOURCES[source].label,status:rows.length?'cargado':'sin_datos',records:rows.length,files:[...new Set([...(prev.files||[]),archivo])],minDate:dates[0]||null,maxDate:dates.at(-1)||null,lastLoadedAt:nowIso(),loadedBy:user||'Sistema',lastDiagnostic:diag};
}

function hashFileMd5(filePath){
  return new Promise((resolve,reject)=>{
    const h=crypto.createHash('md5'),s=fs.createReadStream(filePath);
    s.on('data',d=>h.update(d));s.on('error',reject);s.on('end',()=>resolve(h.digest('hex')));
  });
}
const HIST_ETL_CACHE_VERSION='4.1.3';
function histCacheKey(source,md5){return `${HIST_ETL_CACHE_VERSION}:${source}:${md5}`;}
function publicDiagnostic(diag){if(!diag)return null;const {_errorRows,...safe}=diag;return safe;}
function finalizeDiagRuntime(diag){
  const start=Date.parse(diag.startedAt||'')||Date.now();
  diag.durationMs=Math.max(0,Date.now()-start);
  diag.memoryMb=Math.round(process.memoryUsage().rss/1024/1024*10)/10;
  if(diag._errorRows?.length){
    HIST_ERROR_REPORTS.set(diag.id,{createdAt:Date.now(),file:diag.file,source:diag.source,rows:[...diag._errorRows]});
    setTimeout(()=>HIST_ERROR_REPORTS.delete(diag.id),60*60*1000).unref?.();
  }
}
function enqueueHistoricalJob(job){
  const q=HIST_QUEUES[job.source];
  q.items.push(job);job.queuePosition=q.items.length;job.stage=`En cola · posición ${job.queuePosition}`;
  runHistoricalQueue(job.source);
}
async function runHistoricalQueue(source){
  const q=HIST_QUEUES[source];if(!q||q.busy)return;
  q.busy=true;
  try{while(q.items.length){const job=q.items.shift();job.queuePosition=0;await processHistoricalUploadJob(job);}}
  finally{q.busy=false;}
}
function createValidationWatchdog(){
  return {startedAt:Date.now(),lastProgressAt:Date.now(),rowsSeen:0};
}
function markValidationProgress(watchdog,rows=1){
  watchdog.lastProgressAt=Date.now();
  watchdog.rowsSeen+=rows;
}
function checkValidationWatchdog(watchdog){
  const now=Date.now();
  const startupExceeded=watchdog.rowsSeen===0 && (now-watchdog.startedAt)>HIST_VALIDATION_STARTUP_TIMEOUT_MS;
  const inactiveExceeded=watchdog.rowsSeen>0 && (now-watchdog.lastProgressAt)>HIST_VALIDATION_TIMEOUT_MS;
  if(startupExceeded||inactiveExceeded){
    const e=new Error(startupExceeded
      ? 'El archivo demoró demasiado en abrirse. Se superó el límite de 60 segundos sin recibir filas.'
      : 'La validación se detuvo por más de 10 segundos sin progreso.');
    e.code='VALIDATION_TIMEOUT';throw e;
  }
}
async function yieldEventLoop(){await new Promise(r=>setImmediate(r));}

async function processHistoricalUploadJob(job){
  const {source,file}=job;const diag=etlDiagBase(source,file.originalname);job.diagnostic=diag;
  try{
    etlUpdateJob(job,8,'Etapa 1/4 · archivo recibido',diag);etlLog(diag,`Archivo recibido: ${(file.size/1024/1024).toFixed(2)} MB.`);
    if(!file?.path||!fs.existsSync(file.path))throw new Error('El archivo no existe en el servidor de procesamiento.');
    const ext=path.extname(file.originalname||'').toLowerCase().replace('.','');
    etlUpdateJob(job,12,'Etapa 2/4 · validando extensión',diag);
    if(!['xlsx','xls','csv','txt','pdf'].includes(ext))throw new Error(`Extensión .${ext||'?'} no permitida.`);
    etlUpdateJob(job,16,'Calculando hash MD5 y revisando caché',diag);
    diag.md5=await hashFileMd5(file.path);
    const cacheKey=histCacheKey(source,diag.md5),cached=historicalWarehouse.fileCache?.[cacheKey];
    if(cached){
      diag.status='correcto';diag.fromCache=true;diag.rowsFound=Number(cached.rowsFound||0);diag.rowsStored=Number(cached.rowsStored||0);
      diag.columnCount=Number(cached.columnCount||0);diag.columns=cached.columns||[];diag.sheet=cached.sheet||null;
      diag.reason=`Archivo ya procesado. Resultado recuperado desde caché MD5 (${diag.md5}).`;
      diag.finishedAt=nowIso();finalizeDiagRuntime(diag);etlLog(diag,'No se reprocesó el archivo.');
      etlStoreDiagnostic(publicDiagnostic(diag));etlUpdateJob(job,100,'Finalizado desde caché',diag);persistHistoricalWarehouse();return;
    }
    if(ext==='pdf'){
      diag.status='parcial';diag.reason='PDF registrado como lectura informativa. No se usa para KPI estructurados.';diag.finishedAt=nowIso();
      finalizeDiagRuntime(diag);etlStoreDiagnostic(publicDiagnostic(diag));etlUpdateJob(job,100,'PDF registrado',diag);persistHistoricalWarehouse();return;
    }
    etlUpdateJob(job,20,'Etapa 3/4 · validando columnas',diag);
    const useFastTamXlsx=ext==='xlsx'&&source==='tam'&&Number(file.size||0)<=5*1024*1024;
    if(useFastTamXlsx){
      etlLog(diag,'Fast-path TAM activado: XLSX pequeño procesado en memoria para evitar latencia del streaming.');
      await etlProcessNonXlsx(file.path,ext,source,file.originalname,job,diag);
    }else if(ext==='xlsx')await etlProcessXlsx(file.path,source,file.originalname,job,diag);
    else await etlProcessNonXlsx(file.path,ext,source,file.originalname,job,diag);
    etlUpdateJob(job,96,'Etapa 4/4 · consolidando resultados',diag);
    diag.status=diag.rowsStored>0?(diag.rowsPartial||diag.rowsRejected?'parcial':'correcto'):'parcial';
    if(diag.rowsStored>0)diag.reason=`${diag.rowsStored.toLocaleString('es-CL')} registros recuperados. ${diag.rowsPartial?diag.rowsPartial.toLocaleString('es-CL')+' con cruce parcial. ':''}${diag.rowsRejected?diag.rowsRejected.toLocaleString('es-CL')+' rechazados con causa explícita.':''}`;
    else diag.reason=`Archivo leído sin registros KPI completos. Rechazados: ${diag.rowsRejected}; filtrados por regla: ${diag.rowsFiltered}.`;
    diag.finishedAt=nowIso();finalizeDiagRuntime(diag);
    etlRefreshSourceMeta(source,file.originalname,diag,job.user);
    historicalWarehouse.revision=Number(historicalWarehouse.revision||0)+1;historicalWarehouse.loaded_at=nowIso();historicalDailyCache.revision=-1;
    if(!historicalWarehouse.fileCache||typeof historicalWarehouse.fileCache!=='object')historicalWarehouse.fileCache={};
    historicalWarehouse.fileCache[cacheKey]={source,md5:diag.md5,file:file.originalname,rowsFound:diag.rowsFound,rowsStored:diag.rowsStored,columnCount:diag.columnCount,columns:diag.columns,sheet:diag.sheet,createdAt:nowIso()};
    etlStoreDiagnostic(publicDiagnostic(diag));persistHistoricalWarehouse();
    etlUpdateJob(job,100,'Finalizado',diag);
  }catch(err){
    diag.status='error';
    diag.failedStage=diag.currentStage||job.stage||'Procesamiento';
    diag.reason=err?.code==='JOB_CANCELLED'
      ? 'La carga excedió el tiempo permitido. Verifique el archivo y vuelva a intentar.'
      : err?.code==='VALIDATION_TIMEOUT'
        ? `Timeout de lectura en ${diag.failedStage}: ${err?.message||'el parser no reportó progreso'}.`
        : (err?.message||'El archivo no pudo ser procesado.');
    diag.finishedAt=nowIso();etlLog(diag,`Error: ${err?.message||String(err)}`);finalizeDiagRuntime(diag);
    etlStoreDiagnostic(publicDiagnostic(diag));try{persistHistoricalWarehouse();}catch{}
    etlUpdateJob(job,100,'Error diagnosticado',diag);job.error=err?.message||String(err);
  }finally{
    try{fs.unlinkSync(file.path);}catch{}
    setTimeout(()=>HIST_JOBS.delete(job.id),30*60*1000).unref?.();
  }
}

// ============================================================================
// CCO INTELLIGENCE v3.4 — TRAZABILIDAD INTELLIGENCE
// Base histórica independiente, construida EXCLUSIVAMENTE desde archivos
// adjuntos en la pestaña Trazabilidad. No consulta Operación Nacional.
// ============================================================================
const HISTORICAL_SOURCES = {
  turnos: { label:'Turnos' },
  citaciones: { label:'Citaciones' },
  status: { label:'Status Black / StatusBreakdown' },
  tam: { label:'Marcaje TAM' },
};

const HIST_FIELD = {
  turnos: {
    week:['anosemana','ano_semana','semana','semana_iso'],
    start:['fecha_inicio_semana','fecha inicio semana','inicio_semana'],
    end:['fecha_fin_semana','fecha fin semana','fin_semana'],
    date:['fecha','date'],
    plant:['planta','planta_original','nombre_planta','descripcion_planta'],
    operatorId:['id_operador','id operador','numero_funcionario','número funcionario','id'],
    operatorName:['conductor','operador','nombre_operador','nombre operador'],
    shift:['hora_ingreso','hora ingreso','inicio_turno','turno','hora_turno'],
  },
  citaciones: {
    date:['fecha','date','fecha_citacion','fecha citacion'],
    plant:['planta','nombre_planta','descripcion_planta'],
    operatorId:['id','id_operador','numero_funcionario','número funcionario'],
    operatorName:['nombre_de_operador','nombre de operador','operador','conductor'],
    citation:['hora_citacion','hora citacion','citación','citacion'],
    truck:['n_camion','n° camion','número camion','numero camion','camion','mixer'],
  },
  status: {
    datetime:['hora_inicio','hora inicio','timestamp','fecha_hora','fecha hora'],
    date:['fecha','date'],
    plant:['descripcion_planta','descripción planta','planta','nombre_planta'],
    plantCode:['numero_planta','número planta','codigo_planta','código planta'],
    operatorId:['numero_funcionario','número funcionario','id_operador','id operador'],
    firstName:['primero_empleado','primero empleado','nombre'],
    lastName:['ultimo_empleado','último empleado','apellido'],
    state:['descripcion_estado','descripción estado','estado','status'],
    truck:['numero_equipo','número equipo','equipo','camion','mixer'],
    ticket:['n_de_tiquete','n° de tiquete','numero_tiquete','número de tiquete'],
  },
  tam: {
    // Esquema real Marcaje TAM. La clave de cruce sigue siendo ID columna A + Fecha.
    operatorId:['id'],
    operatorName:['nombre'],
    sindicato:['sindicato'],
    subdivision:['subdivision','subdivisión'],
    jefe:['nombre jefe','jefatura','nombre jefatura'],
    date:['fecha'],
    endDate:['fecha fin'],
    in:['a.hora inicio','a hora inicio','a_hora_inicio','inicio'],
    out:['a. hora fin','a hora fin','a_hora_fin','fin'],
  }
};

function histPick(row, aliases){
  if(!row || typeof row!=='object') return null;
  for(const alias of aliases||[]){
    const k=normalizeKey(alias);
    const v=row[k];
    if(v!==undefined && v!==null && String(v).trim()!=='') return v;
  }
  return null;
}
function histOperatorKey(id,name){
  const nid=normalizeId(id);
  if(nid) return `id:${nid}`;
  const nn=normalizeName(name);
  return nn ? `name:${nn}` : '';
}
function histDateAdd(dateKey,days){
  const d=new Date(`${dateKey}T12:00:00`);
  if(isNaN(d)) return null;
  d.setDate(d.getDate()+days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function histIsoWeekStart(weekText){
  const m=String(weekText||'').match(/(\d{4}).*?S?(\d{1,2})$/i);
  if(!m) return null;
  const year=Number(m[1]),week=Number(m[2]);
  if(week<1||week>53) return null;
  const jan4=new Date(Date.UTC(year,0,4));
  const dow=jan4.getUTCDay()||7;
  const d=new Date(jan4);
  d.setUTCDate(jan4.getUTCDate()-dow+1+(week-1)*7);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function histResolvePlant(rawPlant, rawCode=''){
  for(const raw of [rawPlant,rawCode]){
    if(raw===null||raw===undefined||String(raw).trim()==='') continue;
    const d=dictionaryCanonicalPlant(raw);
    if(d) return d;
    const c=canonicalPlantName(raw);
    if(c) return c;
  }
  return '';
}
function histStatusKind(v){
  const s=normalizeName(v);
  if(!s) return 'otro';
  if(s.includes('login')||s.includes('pre viaje')) return 'login';
  if(s==='asignado'||s.includes('asignado')) return 'asignado';
  if(s==='cargando'||s==='cargado'||s.includes('cargando')||s.includes('cargado')) return 'primera_carga';
  return 'otro';
}
function histTime(v){ return parseTimeMinutes(v); }
function histBaseRecord(source,archivo,rowIndex){
  return {
    source, archivo:safeText(archivo), rowIndex:Number(rowIndex||0),
    fecha:null, planta:'', zona:'', operadorId:'', operadorNombre:'',
    operadorKey:'', camion:'', turnoMin:null, citacionMin:null,
    eventoMin:null, estado:'', eventoKind:'', ticket:''
  };
}
function historicalNormalizeMany(source,row,archivo='',rowIndex=0){
  if(!HISTORICAL_SOURCES[source]) throw new Error(`Fuente histórica desconocida: ${source}`);
  const r=normalizeRows([row||{}])[0]||{};
  if(source==='turnos'){
    const id=histPick(r,HIST_FIELD.turnos.operatorId);
    const name=safeText(histPick(r,HIST_FIELD.turnos.operatorName));
    const key=histOperatorKey(id,name);
    const plant=histResolvePlant(histPick(r,HIST_FIELD.turnos.plant));
    const shift=histTime(histPick(r,HIST_FIELD.turnos.shift));
    let start=parseDateKey(histPick(r,HIST_FIELD.turnos.start)) || parseDateKey(histPick(r,HIST_FIELD.turnos.date));
    if(!start) start=histIsoWeekStart(histPick(r,HIST_FIELD.turnos.week));
    if(!key || !start || shift===null) return [];
    const end=parseDateKey(histPick(r,HIST_FIELD.turnos.end));
    const days=[];
    for(let i=0;i<7;i++){
      const fecha=histDateAdd(start,i);
      if(!fecha || (end&&fecha>end)) break;
      const dow=new Date(`${fecha}T12:00:00`).getDay();
      if(dow===0||dow===6) continue;
      const rec=histBaseRecord(source,archivo,rowIndex);
      Object.assign(rec,{
        fecha, planta:plant, zona:plant?inferZona(plant):'', operadorId:normalizeId(id),
        operadorNombre:name, operadorKey:key, turnoMin:shift
      });
      days.push(rec);
    }
    return days;
  }
  if(source==='citaciones'){
    const id=histPick(r,HIST_FIELD.citaciones.operatorId);
    const name=safeText(histPick(r,HIST_FIELD.citaciones.operatorName));
    const key=histOperatorKey(id,name);
    const fecha=parseDateKey(histPick(r,HIST_FIELD.citaciones.date));
    const citation=histTime(histPick(r,HIST_FIELD.citaciones.citation));
    if(!key || !fecha || citation===null) return [];
    const plant=histResolvePlant(histPick(r,HIST_FIELD.citaciones.plant));
    const rec=histBaseRecord(source,archivo,rowIndex);
    Object.assign(rec,{
      fecha, planta:plant, zona:plant?inferZona(plant):'', operadorId:normalizeId(id),
      operadorNombre:name, operadorKey:key, citacionMin:citation,
      camion:safeText(histPick(r,HIST_FIELD.citaciones.truck))
    });
    return [rec];
  }
  const dt=histPick(r,HIST_FIELD.status.datetime);
  const fecha=parseDateKey(dt)||parseDateKey(histPick(r,HIST_FIELD.status.date));
  const eventMin=histTime(dt);
  const state=safeText(histPick(r,HIST_FIELD.status.state));
  const kind=histStatusKind(state);
  // Para este modelo histórico se conserva únicamente lo necesario para
  // LOGIN, ASIGNADO y primera carga. Reduce drásticamente el volumen Status.
  if(kind==='otro') return [];
  const id=histPick(r,HIST_FIELD.status.operatorId);
  const first=safeText(histPick(r,HIST_FIELD.status.firstName));
  const last=safeText(histPick(r,HIST_FIELD.status.lastName));
  const name=[first,last].filter(Boolean).join(' ').trim();
  const key=histOperatorKey(id,name);
  if(!key || !fecha || eventMin===null) return [];
  const plant=histResolvePlant(histPick(r,HIST_FIELD.status.plant),histPick(r,HIST_FIELD.status.plantCode));
  const rec=histBaseRecord(source,archivo,rowIndex);
  Object.assign(rec,{
    fecha, planta:plant, zona:plant?inferZona(plant):'', operadorId:normalizeId(id),
    operadorNombre:name, operadorKey:key, camion:safeText(histPick(r,HIST_FIELD.status.truck)),
    eventoMin:eventMin, estado:state, eventoKind:kind, ticket:safeText(histPick(r,HIST_FIELD.status.ticket))
  });
  return [rec];
}
function historicalNormalizeRecord(source,row,archivo=''){
  return historicalNormalizeMany(source,row,archivo,0)[0] || null;
}
function validateHistoricalRecord(source,rec){
  const errors=[];
  if(!rec) errors.push('Registro no utilizable para este modelo');
  else{
    if(!rec.fecha) errors.push('Falta fecha válida');
    if(!rec.operadorKey) errors.push('Falta operador identificable');
    if(source==='turnos' && rec.turnoMin===null) errors.push('Falta hora de turno');
    if(source==='citaciones' && rec.citacionMin===null) errors.push('Falta hora de citación');
    if(source==='status' && (!rec.eventoKind||rec.eventoMin===null)) errors.push('Falta evento histórico utilizable');
  }
  return errors;
}
function histDedupeKey(r){
  if(r.source==='turnos') return `T|${r.fecha}|${r.operadorKey}|${r.turnoMin}`;
  if(r.source==='citaciones') return `C|${r.fecha}|${r.operadorKey}|${r.citacionMin}`;
  return `S|${r.fecha}|${r.operadorKey}|${r.eventoKind}|${r.eventoMin}|${r.camion||''}`;
}
function historicalSourceMeta(source){
  const s=historicalWarehouse?.sources?.[source];
  return s&&typeof s==='object' ? s : {source,label:HISTORICAL_SOURCES[source]?.label||source,status:'sin_datos',records:0,files:[],errors:[]};
}
function histMinutesDiff(actual,planned){
  if(actual===null||planned===null||actual===undefined||planned===undefined) return null;
  let d=Number(actual)-Number(planned);
  if(d>720)d-=1440;
  if(d<-720)d+=1440;
  return Number.isFinite(d)?d:null;
}
function historicalPeriodKey(dateStr,granularity='week'){
  if(granularity==='day') return dateStr;
  if(granularity==='month') return String(dateStr).slice(0,7);
  if(granularity==='quarter'){const [y,m]=String(dateStr).split('-').map(Number);return `${y}-T${Math.floor((m-1)/3)+1}`;}
  if(granularity==='year') return String(dateStr).slice(0,4);
  return isoWeekKey(dateStr);
}

let historicalDailyCache={revision:-1,rows:[],byDate:new Map(),plants:[],zones:[],operators:[]};
function getHistoricalDailyIndex(){
  const revision=Number(historicalWarehouse?.revision||0);
  if(historicalDailyCache.revision===revision) return historicalDailyCache;
  const records=Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[];
  const map=new Map();
  for(const r of records){
    if(!HISTORICAL_SOURCES[r?.source] && !HISTORICAL_SOURCES[r?.fuente]) continue;
    const source=r.source||r.fuente;
    const key=`${r.fecha}|${r.operadorKey||histOperatorKey(r.operadorId,r.operadorNombre||r.operador)}`;
    if(!r.fecha||key.endsWith('|')) continue;
    if(!map.has(key)){
      map.set(key,{
        fecha:r.fecha,operadorKey:r.operadorKey||histOperatorKey(r.operadorId,r.operadorNombre||r.operador),
        operadorId:r.operadorId||'',operadorNombre:r.operadorNombre||r.operador||'',
        planta:'',zona:'',camion:'',turnoMin:null,citacionMin:null,loginMin:null,
        asignacionMin:null,primeraCargaMin:null,tamIngresoMin:null,tamSalidaMin:null,fuentes:new Set()
      });
    }
    const d=map.get(key);d.fuentes.add(source);
    if(r.operadorId&&!d.operadorId)d.operadorId=r.operadorId;
    if(r.operadorNombre&&!d.operadorNombre)d.operadorNombre=r.operadorNombre;
    if(r.camion&&!d.camion)d.camion=r.camion;
    if(r.planta){
      // Status tiene prioridad para ubicación real del día; después Turnos.
      if(source==='status'||!d.planta){d.planta=r.planta;d.zona=r.zona||inferZona(r.planta);}
    }
    if(source==='turnos'&&r.turnoMin!==null){
      if(d.turnoMin===null)d.turnoMin=r.turnoMin;
      if(!d.planta&&r.planta){d.planta=r.planta;d.zona=r.zona||inferZona(r.planta);}
    }
    if(source==='citaciones'&&r.citacionMin!==null){
      if(d.citacionMin===null||r.citacionMin<d.citacionMin)d.citacionMin=r.citacionMin;
      if(!d.planta&&r.planta){d.planta=r.planta;d.zona=r.zona||inferZona(r.planta);}
    }

    if(source==='tam'){
      if(r.tamIngresoMin!==null&&r.tamIngresoMin!==undefined&&(d.tamIngresoMin===null||r.tamIngresoMin<d.tamIngresoMin))d.tamIngresoMin=r.tamIngresoMin;
      if(r.tamSalidaMin!==null&&r.tamSalidaMin!==undefined&&(d.tamSalidaMin===null||r.tamSalidaMin>d.tamSalidaMin))d.tamSalidaMin=r.tamSalidaMin;
      // TAM no asigna planta. Planta proviene de Turnos/Status y diccionario.
    }

    if(source==='status'){
      // v3.6: Status ya viene consolidado por operador/día.
      if(r.loginMin!==null&&r.loginMin!==undefined&&(d.loginMin===null||r.loginMin<d.loginMin))d.loginMin=r.loginMin;
      if(r.asignacionMin!==null&&r.asignacionMin!==undefined&&(d.asignacionMin===null||r.asignacionMin<d.asignacionMin))d.asignacionMin=r.asignacionMin;
      if(r.primeraCargaMin!==null&&r.primeraCargaMin!==undefined&&(d.primeraCargaMin===null||r.primeraCargaMin<d.primeraCargaMin))d.primeraCargaMin=r.primeraCargaMin;
      // Compatibilidad defensiva con registros antiguos del mismo modelo.
      if(r.eventoKind==='login'&&(d.loginMin===null||r.eventoMin<d.loginMin))d.loginMin=r.eventoMin;
      if(r.eventoKind==='asignado'&&(d.asignacionMin===null||r.eventoMin<d.asignacionMin))d.asignacionMin=r.eventoMin;
      if(r.eventoKind==='primera_carga'&&(d.primeraCargaMin===null||r.eventoMin<d.primeraCargaMin))d.primeraCargaMin=r.eventoMin;
    }
  }
  const rows=[...map.values()].map(d=>({...d,fuentes:[...d.fuentes],planta:d.planta||'Sin planta',zona:d.zona|| (d.planta&&d.planta!=='Sin planta'?inferZona(d.planta):'Sin zona')}));
  rows.sort((a,b)=>a.fecha.localeCompare(b.fecha)||a.operadorKey.localeCompare(b.operadorKey));
  const byDate=new Map();for(const r of rows){if(!byDate.has(r.fecha))byDate.set(r.fecha,[]);byDate.get(r.fecha).push(r);}
  const plants=[...new Set(rows.map(r=>r.planta).filter(p=>p&&p!=='Sin planta'))].sort((a,b)=>a.localeCompare(b,'es'));
  const zones=[...new Set(rows.map(r=>r.zona).filter(z=>z&&z!=='Sin zona'))].sort((a,b)=>a.localeCompare(b,'es'));
  const opMap=new Map();
  for(const r of rows){
    if(!opMap.has(r.operadorKey))opMap.set(r.operadorKey,{key:r.operadorKey,id:r.operadorId||'',nombre:r.operadorNombre||r.operadorId||r.operadorKey,plantas:new Set(),zonas:new Set()});
    const o=opMap.get(r.operadorKey);
    if(r.planta&&r.planta!=='Sin planta')o.plantas.add(r.planta);
    if(r.zona&&r.zona!=='Sin zona')o.zonas.add(r.zona);
  }
  const operators=[...opMap.values()].map(o=>({...o,plantas:[...o.plantas].sort(),zonas:[...o.zonas].sort()})).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
  historicalDailyCache={revision,rows,byDate,plants,zones,operators};
  return historicalDailyCache;
}
function getHistoricalRuntimeIndex(){ return getHistoricalDailyIndex(); }

function histCfg(query={}){
  const num=(v,d,min=0,max=240)=>{const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):d;};
  return {
    sourceStart:String(query.sourceStart||'logeo')==='citacion'?'citacion':'logeo',
    tolTurnCitation:num(query.tolTurnCitation,30,0,120),
    tolAssignment:num(query.tolAssignment,30,0,180),
    tolTurn:num(query.tolTurn,10,0,120),
    tolCitation:num(query.tolCitation,10,0,120),
    atrasoLeve:num(query.atrasoLeve,10,1,120),
    atrasoModerado:num(query.atrasoModerado,20,2,180),
  };
}
function histStats(values){
  const v=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!v.length)return {n:0,promedio:null,mediana:null,min:null,max:null,p90:null};
  const avg=v.reduce((a,b)=>a+b,0)/v.length;
  const med=v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;
  const p90=v[Math.min(v.length-1,Math.ceil(v.length*.9)-1)];
  return {n:v.length,promedio:round1(avg),mediana:round1(med),min:round1(v[0]),max:round1(v.at(-1)),p90:round1(p90)};
}
function histMetricPct(ok,total){return total?round1(ok/total*100):null;}
function histClassGeneral(v){if(v===null)return 'Sin datos';if(v>=90)return 'Excelente';if(v>=80)return 'Buena';if(v>=70)return 'Regular';return 'Crítica';}
function histMetricsForMode(rows,cfg,mode='logeo'){
  const base=histMetrics(rows,cfg);
  if(String(mode||'logeo')==='citacion'){
    return {...base,turnVsAssignment:null,turnVsAssignmentN:0,adherenciaTurno:null,adherenciaTurnoN:0,atrasoTurno:{n:0,promedio:null,mediana:null,min:null,max:null,p90:null,porcentaje:null},adherenciaGeneral:null,clasificacionGeneral:'Sin datos',mode:'citacion'};
  }
  return {...base,turnVsCitation:null,turnVsCitationN:0,adherenciaCitacion:null,adherenciaCitacionN:0,atrasoCitacion:{n:0,promedio:null,mediana:null,min:null,max:null,p90:null,porcentaje:null},adherenciaGeneral:null,clasificacionGeneral:'Sin datos',mode:'logeo'};
}
function histMetrics(rows,cfg){
  let tvcN=0,tvcOk=0,tvaN=0,tvaOk=0,atN=0,atOk=0,acN=0,acOk=0;
  const dead=[],delayCit=[],delayTurn=[],tamVsTurno=[],tamVsLogeo=[],tamVsAsignacion=[];
  for(const r of rows){
    if(r.turnoMin!==null&&r.citacionMin!==null){tvcN++;const d=histMinutesDiff(r.citacionMin,r.turnoMin);if(d!==null&&Math.abs(d)<=cfg.tolTurnCitation)tvcOk++;}
    if(r.turnoMin!==null&&r.asignacionMin!==null){tvaN++;const d=histMinutesDiff(r.asignacionMin,r.turnoMin);if(d!==null&&Math.abs(d)<=cfg.tolAssignment)tvaOk++;}
    if(r.turnoMin!==null&&r.loginMin!==null){atN++;const d=histMinutesDiff(r.loginMin,r.turnoMin);if(d!==null&&Math.abs(d)<=cfg.tolTurn)atOk++;if(d!==null)delayTurn.push(Math.max(0,d));}
    if(r.citacionMin!==null&&r.loginMin!==null){acN++;const d=histMinutesDiff(r.loginMin,r.citacionMin);if(d!==null&&Math.abs(d)<=cfg.tolCitation)acOk++;if(d!==null)delayCit.push(Math.max(0,d));}
    const start=cfg.sourceStart==='citacion'?r.citacionMin:r.loginMin;
    if(start!==null&&r.asignacionMin!==null){const d=histMinutesDiff(r.asignacionMin,start);if(d!==null&&d>=0&&d<=720)dead.push(d);}
    if(r.tamIngresoMin!==null&&r.turnoMin!==null){const d=histMinutesDiff(r.tamIngresoMin,r.turnoMin);if(d!==null)tamVsTurno.push(d);}
    if(r.tamIngresoMin!==null&&r.loginMin!==null){const d=histMinutesDiff(r.loginMin,r.tamIngresoMin);if(d!==null)tamVsLogeo.push(d);}
    if(r.tamIngresoMin!==null&&r.asignacionMin!==null){const d=histMinutesDiff(r.asignacionMin,r.tamIngresoMin);if(d!==null&&d>=0&&d<=720)tamVsAsignacion.push(d);}
  }
  const values=[histMetricPct(tvcOk,tvcN),histMetricPct(tvaOk,tvaN),histMetricPct(atOk,atN),histMetricPct(acOk,acN)].filter(v=>v!==null);
  const general=values.length?round1(values.reduce((a,b)=>a+b,0)/values.length):null;
  const citLate=delayCit.filter(x=>x>0),turnLate=delayTurn.filter(x=>x>0);
  return {
    turnVsCitation:histMetricPct(tvcOk,tvcN),turnVsCitationN:tvcN,
    turnVsAssignment:histMetricPct(tvaOk,tvaN),turnVsAssignmentN:tvaN,
    adherenciaTurno:histMetricPct(atOk,atN),adherenciaTurnoN:atN,
    adherenciaCitacion:histMetricPct(acOk,acN),adherenciaCitacionN:acN,
    adherenciaGeneral:general,clasificacionGeneral:histClassGeneral(general),
    tiempoMuerto:histStats(dead),
    atrasoCitacion:{...histStats(delayCit),porcentaje:acN?round1(citLate.length/acN*100):null},
    atrasoTurno:{...histStats(delayTurn),porcentaje:atN?round1(turnLate.length/atN*100):null},
    tamVsTurno:histStats(tamVsTurno),
    tamVsLogeo:histStats(tamVsLogeo),
    tamVsAsignacion:histStats(tamVsAsignacion),
    registros:rows.length,
    operadores:new Set(rows.map(r=>r.operadorKey)).size,
    plantas:new Set(rows.map(r=>r.planta).filter(p=>p&&p!=='Sin planta')).size,
  };
}
function histFilterBase(query={},rangeOverride=null){
  const idx=getHistoricalDailyIndex();
  const from=rangeOverride?.from||safeText(query.from),to=rangeOverride?.to||safeText(query.to);
  const zones=String(query.zonas||query.zona||'').split(',').map(safeText).filter(Boolean);
  const plants=String(query.plantas||'').split(',').map(safeText).filter(Boolean);
  const operators=String(query.operators||query.operator||'').split(',').map(safeText).filter(Boolean);
  return idx.rows.filter(r=>(!from||r.fecha>=from)&&(!to||r.fecha<=to)&&(!zones.length||zones.includes(r.zona))&&(!plants.length||plants.includes(r.planta))&&(!operators.length||operators.includes(r.operadorKey)));
}
function histPreviousRange(from,to){
  if(!from||!to)return null;
  const a=new Date(`${from}T12:00:00`),b=new Date(`${to}T12:00:00`);
  if(isNaN(a)||isNaN(b))return null;
  const days=Math.round((b-a)/86400000)+1;
  const pTo=new Date(a);pTo.setDate(pTo.getDate()-1);
  const pFrom=new Date(pTo);pFrom.setDate(pFrom.getDate()-days+1);
  const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return {from:fmt(pFrom),to:fmt(pTo)};
}
function histGroupMetrics(rows,key,cfg,previousRows=[],mode='logeo'){
  const prevMap=new Map();
  for(const r of previousRows){const k=r[key];if(!prevMap.has(k))prevMap.set(k,[]);prevMap.get(k).push(r);}
  const m=new Map();for(const r of rows){const k=r[key];if(!k||k==='Sin planta'||k==='Sin zona')continue;if(!m.has(k))m.set(k,[]);m.get(k).push(r);}
  return [...m.entries()].map(([name,items])=>{
    const met=histMetricsForMode(items,cfg,mode),prev=histMetricsForMode(prevMap.get(name)||[],cfg,mode);
    return {name,...met,variacionGeneral:met.adherenciaGeneral!==null&&prev.adherenciaGeneral!==null?round1(met.adherenciaGeneral-prev.adherenciaGeneral):null,variacionTurno:met.adherenciaTurno!==null&&prev.adherenciaTurno!==null?round1(met.adherenciaTurno-prev.adherenciaTurno):null};
  });
}
function histOperatorGroups(rows,cfg,previousRows=[],mode='logeo'){
  const prev=new Map();for(const r of previousRows){if(!prev.has(r.operadorKey))prev.set(r.operadorKey,[]);prev.get(r.operadorKey).push(r);}
  const m=new Map();for(const r of rows){if(!m.has(r.operadorKey))m.set(r.operadorKey,[]);m.get(r.operadorKey).push(r);}
  return [...m.entries()].map(([key,items])=>{
    const first=items[0],met=histMetricsForMode(items,cfg,mode),pm=histMetricsForMode(prev.get(key)||[],cfg,mode);
    return {
      key,operador:first.operadorNombre||first.operadorId||key,operadorId:first.operadorId||'',planta:first.planta||'Sin planta',zona:first.zona||'Sin zona',
      dias:new Set(items.map(x=>x.fecha)).size,...met,
      variacionGeneral:met.adherenciaGeneral!==null&&pm.adherenciaGeneral!==null?round1(met.adherenciaGeneral-pm.adherenciaGeneral):null,
      variacionTurno:met.adherenciaTurno!==null&&pm.adherenciaTurno!==null?round1(met.adherenciaTurno-pm.adherenciaTurno):null
    };
  });
}
function histRank(arr,metric,direction='desc',limit=10){
  return arr.filter(x=>{
    const parts=metric.split('.');
    let v=x;for(const p of parts)v=v?.[p];
    return v!==null&&v!==undefined&&Number.isFinite(Number(v));
  }).sort((a,b)=>{
    const get=o=>metric.split('.').reduce((v,p)=>v?.[p],o);
    const av=Number(get(a)),bv=Number(get(b));
    return direction==='asc'?av-bv:bv-av;
  }).slice(0,limit);
}
function aggregateHistoricalEnterprise(rows,granularity='week',cfg=histCfg({}),mode='logeo'){
  const g=new Map();for(const r of rows){const k=historicalPeriodKey(r.fecha,granularity);if(!g.has(k))g.set(k,[]);g.get(k).push(r);}
  return [...g.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([periodo,items])=>({periodo,...histMetricsForMode(items,cfg,mode)}));
}
function historicalAvg(rows,field){const v=rows.map(r=>Number(r?.[field])).filter(Number.isFinite);return v.length?round1(v.reduce((a,b)=>a+b,0)/v.length):null;}
function histInsights(metrics,plants,zones,ops){
  const insights=[],alerts=[];
  const validPlants=plants.filter(x=>x.adherenciaGeneral!==null).sort((a,b)=>b.adherenciaGeneral-a.adherenciaGeneral);
  const validZones=zones.filter(x=>x.adherenciaGeneral!==null).sort((a,b)=>b.adherenciaGeneral-a.adherenciaGeneral);
  if(validPlants[0])insights.push(`Mejor planta del período: ${validPlants[0].name} (${validPlants[0].adherenciaGeneral}% índice general).`);
  if(validPlants.at(-1))insights.push(`Planta con mayor oportunidad de mejora: ${validPlants.at(-1).name} (${validPlants.at(-1).adherenciaGeneral}%).`);
  if(validZones[0])insights.push(`Mejor zona: ${validZones[0].name} (${validZones[0].adherenciaGeneral}%).`);
  const dead=histRank(ops,'tiempoMuerto.promedio','desc',3);if(dead.length)insights.push(`Mayor tiempo muerto promedio: ${dead.map(x=>`${x.operador} ${x.tiempoMuerto.promedio} min`).join(' · ')}.`);
  const recurrent=ops.filter(x=>Number(x.atrasoTurno.porcentaje)>=50&&x.atrasoTurno.n>=2).sort((a,b)=>b.atrasoTurno.porcentaje-a.atrasoTurno.porcentaje).slice(0,5);
  if(recurrent.length)alerts.push(`Reincidencia en atraso de turno: ${recurrent.map(x=>`${x.operador} (${x.atrasoTurno.porcentaje}%)`).join(' · ')}.`);
  const deterioro=ops.filter(x=>x.variacionGeneral!==null&&x.variacionGeneral<=-10).sort((a,b)=>a.variacionGeneral-b.variacionGeneral).slice(0,5);
  if(deterioro.length)alerts.push(`Deterioro vs período anterior: ${deterioro.map(x=>`${x.operador} (${x.variacionGeneral} pp)`).join(' · ')}.`);
  if(metrics.adherenciaGeneral!==null&&metrics.adherenciaGeneral<70)alerts.push(`Índice general operacional crítico: ${metrics.adherenciaGeneral}%.`);
  if(!insights.length)insights.push('No existen datos suficientes para generar hallazgos comparativos en el período seleccionado.');
  if(!alerts.length)alerts.push('Sin alertas críticas con los umbrales actuales.');
  return {insights,alerts};
}


app.post('/api/historico/upload',requireAuth,historicalUpload.single('file'),(req,res)=>{
  try{
    const source=safeText(req.body?.source);
    if(!HISTORICAL_SOURCES[source]){if(req.file?.path)try{fs.unlinkSync(req.file.path)}catch{};return res.status(400).json({error:'Fuente histórica inválida'});}
    if(!req.file)return res.status(400).json({error:'No se recibió archivo'});
    const id=crypto.randomUUID(),job={id,source,file:req.file,user:req.user?.nombre||'Sistema',progress:5,stage:'Archivo recibido',createdAt:nowIso(),updatedAt:nowIso(),diagnostic:null,error:null};
    HIST_JOBS.set(id,job);
    enqueueHistoricalJob(job);
    return res.status(202).json({ok:true,jobId:id,file:req.file.originalname,size:req.file.size,queuePosition:job.queuePosition});
  }catch(err){return res.status(422).json({error:'No fue posible recibir el archivo',detalle:err?.message||String(err)});}
});
app.get('/api/historico/job/:id',requireAuth,(req,res)=>{
  const job=HIST_JOBS.get(req.params.id);if(!job)return res.status(404).json({error:'Proceso no encontrado o ya expiró'});
  return res.json({ok:true,id:job.id,source:job.source,progress:job.progress,stage:job.stage,queuePosition:job.queuePosition||0,diagnostic:publicDiagnostic(job.diagnostic),error:job.error,done:job.progress>=100});
});
app.post('/api/historico/job/:id/cancel',requireAuth,(req,res)=>{
  const job=HIST_JOBS.get(req.params.id);
  if(!job)return res.status(404).json({error:'Proceso no encontrado o ya expiró'});
  job.cancelled=true;job.error='La carga excedió el tiempo permitido. Verifique el archivo y vuelva a intentar.';
  job.stage='Cancelado por timeout';job.updatedAt=nowIso();
  return res.json({ok:true,id:job.id,cancelled:true});
});

app.post('/api/historico/ingesta',requireAuth,(req,res)=>{
  try{
    const source=safeText(req.body?.source),incoming=req.body?.datos,archivo=safeText(req.body?.archivo||'archivo'),modo=safeText(req.body?.modo||'append').toLowerCase(),finalizar=req.body?.finalizar===true;
    if(!HISTORICAL_SOURCES[source])return res.status(400).json({error:`Fuente histórica inválida: ${source}`});
    if(!Array.isArray(incoming)||!incoming.length)return res.status(400).json({error:'El archivo no contiene filas para procesar'});
    if(!Array.isArray(historicalWarehouse.records))historicalWarehouse.records=[];
    if(modo==='replace'){historicalWarehouse.records=historicalWarehouse.records.filter(r=>(r.source||r.fuente)!==source);historicalWarehouse.sources[source]={};}
    const existing=new Set(historicalWarehouse.records.filter(r=>(r.source||r.fuente)===source).map(histDedupeKey));
    const valid=[],errors=[];let ignored=0,duplicates=0,expanded=0;
    const normalized=normalizeRows(incoming);
    normalized.forEach((row,i)=>{
      const many=historicalNormalizeMany(source,row,archivo,i+1);expanded+=many.length;
      if(!many.length){ignored++;return;}
      for(const rec of many){
        const er=validateHistoricalRecord(source,rec);
        if(er.length){errors.push({fila:i+1,archivo,errores:er});continue;}
        const dk=histDedupeKey(rec);if(existing.has(dk)){duplicates++;continue;}existing.add(dk);valid.push(rec);
      }
    });
    historicalWarehouse.records.push(...valid);
    const prev=historicalSourceMeta(source);
    const sourceRows=historicalWarehouse.records.filter(r=>(r.source||r.fuente)===source);
    const dates=sourceRows.map(r=>r.fecha).filter(Boolean).sort();
    historicalWarehouse.sources[source]={
      source,label:HISTORICAL_SOURCES[source].label,status:sourceRows.length?'cargado':'sin_datos',
      records:sourceRows.length,files:[...new Set([...(prev.files||[]),archivo].filter(Boolean))],
      minDate:dates[0]||null,maxDate:dates.at(-1)||null,lastLoadedAt:nowIso(),loadedBy:req.user?.nombre||'Sistema',
      received:Number(prev.received||0)+normalized.length,stored:sourceRows.length,
      ignored:Number(prev.ignored||0)+ignored,rejected:Number(prev.rejected||0)+errors.length,duplicates:Number(prev.duplicates||0)+duplicates,
      errors:[...(prev.errors||[]),...errors].slice(-100)
    };
    historicalWarehouse.revision=Number(historicalWarehouse.revision||0)+1;
    historicalWarehouse.loaded_at=nowIso();
    historicalDailyCache.revision=-1;
    // Para cargas grandes se persiste al finalizar archivo/lote final, evitando reescribir
    // todo el warehouse por cada bloque.
    if(finalizar)persistHistoricalWarehouse();
    return res.json({ok:true,source,archivo,loteRecibido:normalized.length,loteGuardado:valid.length,expandidos:expanded,ignorados:ignored,duplicados:duplicates,rechazados:errors.length,meta:historicalWarehouse.sources[source]});
  }catch(err){
    registrarErrorDetallado({modulo:'historico',funcion:'POST /api/historico/ingesta',error:err?.message||String(err),stack:err?.stack});
    return res.status(422).json({error:'No fue posible consolidar el archivo histórico',detalle:err?.message||String(err)});
  }
});
app.post('/api/historico/finalizar',requireAuth,(req,res)=>{try{persistHistoricalWarehouse();return res.json({ok:true,revision:Number(historicalWarehouse?.revision||0)});}catch(err){return res.status(500).json({error:'No se pudo persistir la base histórica',detalle:err?.message||String(err)});}});
app.delete('/api/historico/fuente/:source',requireAuth,(req,res)=>{
  const source=safeText(req.params.source);if(!HISTORICAL_SOURCES[source])return res.status(400).json({error:'Fuente inválida'});
  historicalWarehouse.records=(historicalWarehouse.records||[]).filter(r=>(r.source||r.fuente)!==source);
  historicalWarehouse.sources[source]={};historicalWarehouse.revision=Number(historicalWarehouse.revision||0)+1;historicalDailyCache.revision=-1;persistHistoricalWarehouse();
  return res.json({ok:true,source});
});

function historicalFileDetails(source){
  const rows=(historicalWarehouse?.records||[]).filter(r=>(r.source||r.fuente)===source);
  const by=new Map();
  for(const r of rows){
    const archivo=safeText(r.archivo||'Archivo sin nombre');
    if(!by.has(archivo))by.set(archivo,{archivo,records:0,minDate:null,maxDate:null,operators:new Set(),plants:new Set()});
    const x=by.get(archivo);x.records++;
    if(r.fecha){if(!x.minDate||r.fecha<x.minDate)x.minDate=r.fecha;if(!x.maxDate||r.fecha>x.maxDate)x.maxDate=r.fecha;}
    if(r.operadorKey)x.operators.add(r.operadorKey);
    if(r.planta)x.plants.add(r.planta);
  }
  return [...by.values()].map(x=>({archivo:x.archivo,records:x.records,minDate:x.minDate,maxDate:x.maxDate,operators:x.operators.size,plants:x.plants.size})).sort((a,b)=>a.archivo.localeCompare(b.archivo,'es'));
}
function recomputeHistoricalSourceMeta(source){
  const sourceRows=(historicalWarehouse?.records||[]).filter(r=>(r.source||r.fuente)===source);
  const dates=sourceRows.map(r=>r.fecha).filter(Boolean).sort();
  const previous=historicalWarehouse.sources?.[source]||{};
  historicalWarehouse.sources[source]={
    ...previous,source,label:HISTORICAL_SOURCES[source]?.label||source,
    status:sourceRows.length?'cargado':'sin_datos',records:sourceRows.length,
    files:historicalFileDetails(source).map(x=>x.archivo),
    minDate:dates[0]||null,maxDate:dates.at(-1)||null,lastLoadedAt:previous.lastLoadedAt||null,loadedBy:previous.loadedBy||null
  };
  return historicalWarehouse.sources[source];
}
app.delete('/api/historico/archivo',requireAuth,(req,res)=>{
  try{
    const source=safeText(req.query.source),archivo=safeText(req.query.archivo);
    if(!HISTORICAL_SOURCES[source])return res.status(400).json({error:'Fuente histórica inválida'});
    if(!archivo)return res.status(400).json({error:'Debe indicar el archivo a eliminar'});
    const before=(historicalWarehouse.records||[]).length;
    historicalWarehouse.records=(historicalWarehouse.records||[]).filter(r=>!((r.source||r.fuente)===source&&safeText(r.archivo)===archivo));
    const removed=before-historicalWarehouse.records.length;
    if(historicalWarehouse.fileCache&&typeof historicalWarehouse.fileCache==='object')
      for(const [k,v] of Object.entries(historicalWarehouse.fileCache))
        if(v?.source===source&&safeText(v?.file)===archivo)delete historicalWarehouse.fileCache[k];
    recomputeHistoricalSourceMeta(source);
    historicalWarehouse.revision=Number(historicalWarehouse.revision||0)+1;
    historicalWarehouse.loaded_at=nowIso();historicalDailyCache.revision=-1;persistHistoricalWarehouse();
    return res.json({ok:true,source,archivo,removed,meta:historicalWarehouse.sources[source]});
  }catch(err){return res.status(422).json({error:'No fue posible eliminar el archivo histórico',detalle:err?.message||String(err)});}
});


app.get('/api/historico/errores/:diagId.xlsx',requireAuth,async(req,res)=>{
  try{
    const rep=HIST_ERROR_REPORTS.get(req.params.diagId);
    if(!rep)return res.status(404).json({error:'El detalle de errores ya expiró o no existe'});
    const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet('Errores');
    ws.columns=[
      {header:'Archivo',key:'file',width:32},{header:'Fuente',key:'source',width:18},{header:'Fila',key:'row',width:12},
      {header:'Campo',key:'field',width:24},{header:'Código',key:'code',width:30},{header:'Motivo',key:'reason',width:70},{header:'Tipo',key:'kind',width:16}
    ];
    for(const x of rep.rows)ws.addRow({file:rep.file,source:rep.source,...x});
    const buf=await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="errores_${safeText(rep.file).replace(/[^a-z0-9_.-]+/gi,'_')}.xlsx"`);
    return res.send(Buffer.from(buf));
  }catch(err){return res.status(422).json({error:'No fue posible generar el Excel de errores',detalle:err?.message||String(err)});}
});


function historicalSourceDateSets(){
  const records=Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[];
  const sets={turnos:new Set(),citaciones:new Set(),status:new Set(),tam:new Set()};
  for(const r of records){
    const source=r?.source||r?.fuente;
    if(sets[source]&&r?.fecha)sets[source].add(r.fecha);
  }
  return sets;
}

function historicalAvailableWeeks(){
  const idx=getHistoricalDailyIndex(),by=new Map();
  for(const r of idx.rows){
    if(!r?.fecha)continue;
    const key=historicalPeriodKey(r.fecha,'week'); // YYYY-Wxx
    if(!by.has(key))by.set(key,{
      key,from:null,to:null,operatorDays:0,operators:new Set(),
      turnos:0,citaciones:0,status:0,turnoCitacion:0,turnoStatus:0,citacionLogin:0
    });
    const x=by.get(key);x.operatorDays++;x.operators.add(r.operadorKey);
    if(!x.from||r.fecha<x.from)x.from=r.fecha;if(!x.to||r.fecha>x.to)x.to=r.fecha;
    const hasTurn=r.turnoMin!==null&&r.turnoMin!==undefined;
    const hasCit=r.citacionMin!==null&&r.citacionMin!==undefined;
    const hasLogin=r.loginMin!==null&&r.loginMin!==undefined;
    const hasStatus=hasLogin||(r.asignacionMin!==null&&r.asignacionMin!==undefined)||(r.primeraCargaMin!==null&&r.primeraCargaMin!==undefined);
    if(hasTurn)x.turnos++;if(hasCit)x.citaciones++;if(hasStatus)x.status++;
    if(hasTurn&&hasCit)x.turnoCitacion++;
    if(hasTurn&&hasStatus)x.turnoStatus++;
    if(hasCit&&hasLogin)x.citacionLogin++;
  }
  return [...by.values()].map(x=>({
    key:x.key,from:x.from,to:x.to,operatorDays:x.operatorDays,operators:x.operators.size,
    turnos:x.turnos,citaciones:x.citaciones,status:x.status,
    turnoCitacion:x.turnoCitacion,turnoStatus:x.turnoStatus,citacionLogin:x.citacionLogin,
    complete:x.turnoCitacion>0||x.turnoStatus>0||x.citacionLogin>0
  })).sort((a,b)=>a.key.localeCompare(b.key));
}

function latestCommonHistoricalDate(){
  const sets=historicalSourceDateSets();
  const loaded=Object.entries(sets).filter(([,s])=>s.size>0);
  if(!loaded.length)return null;
  // Prioridad: fecha más reciente con las 3 fuentes. Si aún falta una fuente,
  // usa la intersección de las fuentes efectivamente cargadas.
  const base=[...loaded[0][1]].sort();
  const common=base.filter(d=>loaded.every(([,s])=>s.has(d)));
  return common.at(-1)||null;
}
function historicalSourceRanges(){
  const acc={turnos:{records:0,dates:new Set()},citaciones:{records:0,dates:new Set()},status:{records:0,dates:new Set()},tam:{records:0,dates:new Set()}};
  for(const r of (historicalWarehouse.records||[])){
    const s=r.source||r.fuente;if(!acc[s])continue;
    acc[s].records++;if(r.fecha)acc[s].dates.add(r.fecha);
  }
  const out={};
  for(const [source,x] of Object.entries(acc)){
    const dates=[...x.dates].sort();
    out[source]={records:x.records,minDate:dates[0]||null,maxDate:dates.at(-1)||null,days:dates.length};
  }
  return out;
}
function historicalCoverage(query={}){
  const from=safeText(query.from),to=safeText(query.to);
  const zones=String(query.zonas||query.zona||'').split(',').map(safeText).filter(Boolean);
  const plants=String(query.plantas||'').split(',').map(safeText).filter(Boolean);
  const operators=String(query.operators||query.operator||'').split(',').map(safeText).filter(Boolean);
  const idx=getHistoricalDailyIndex();
  const rows=idx.rows.filter(r=>(!from||r.fecha>=from)&&(!to||r.fecha<=to)&&(!zones.length||zones.includes(r.zona))&&(!plants.length||plants.includes(r.planta))&&(!operators.length||operators.includes(r.operadorKey)));
  const raw=(historicalWarehouse.records||[]).filter(r=>(!from||r.fecha>=from)&&(!to||r.fecha<=to));
  const sourceRows={turnos:0,citaciones:0,status:0,tam:0};
  for(const r of raw){const s=r.source||r.fuente;if(sourceRows[s]!==undefined)sourceRows[s]++;}
  const withTurn=r=>r.turnoMin!==null&&r.turnoMin!==undefined;
  const withCit=r=>r.citacionMin!==null&&r.citacionMin!==undefined;
  const withLogin=r=>r.loginMin!==null&&r.loginMin!==undefined;
  const withAssign=r=>r.asignacionMin!==null&&r.asignacionMin!==undefined;
  const withTam=r=>r.tamIngresoMin!==null&&r.tamIngresoMin!==undefined;
  const withStatus=r=>withLogin(r)||withAssign(r)||(r.primeraCargaMin!==null&&r.primeraCargaMin!==undefined);

  const turnDays=rows.filter(withTurn).length,citDays=rows.filter(withCit).length,statusDays=rows.filter(withStatus).length,tamDays=rows.filter(withTam).length;
  const turnoCit=rows.filter(r=>withTurn(r)&&withCit(r)).length;
  const turnoStatus=rows.filter(r=>withTurn(r)&&withStatus(r)).length;
  const turnoLogin=rows.filter(r=>withTurn(r)&&withLogin(r)).length;
  const turnoAsign=rows.filter(r=>withTurn(r)&&withAssign(r)).length;
  const citLogin=rows.filter(r=>withCit(r)&&withLogin(r)).length;
  const allThree=rows.filter(r=>withTurn(r)&&withCit(r)&&withStatus(r)).length;
  const turnoTam=rows.filter(r=>withTurn(r)&&withTam(r)).length;
  const tamLogin=rows.filter(r=>withTam(r)&&withLogin(r)).length;
  const tamStatus=rows.filter(r=>withTam(r)&&withStatus(r)).length;
  const allFour=rows.filter(r=>withTurn(r)&&withCit(r)&&withStatus(r)&&withTam(r)).length;

  return {
    from,to,
    sourceRows,
    operatorDays:{turnos:turnDays,citaciones:citDays,status:statusDays,tam:tamDays},
    crosses:{turnoCitacion:turnoCit,turnoStatus,turnoLogin,turnoAsignacion:turnoAsign,citacionLogin:citLogin,tresFuentes:allThree,turnoTam,tamLogin,tamStatus,cuatroFuentes:allFour},
    unmatched:{
      turnoSinCitacion:Math.max(0,turnDays-turnoCit),
      turnoSinStatus:Math.max(0,turnDays-turnoStatus),
      citacionSinLogin:Math.max(0,citDays-citLogin)
    },
    operators:{
      total:new Set(rows.map(r=>r.operadorKey)).size,
      conTurno:new Set(rows.filter(withTurn).map(r=>r.operadorKey)).size,
      conCitacion:new Set(rows.filter(withCit).map(r=>r.operadorKey)).size,
      conStatus:new Set(rows.filter(withStatus).map(r=>r.operadorKey)).size,
      conTam:new Set(rows.filter(withTam).map(r=>r.operadorKey)).size
    },
    rows:rows.length
  };
}

function historicalFilesUsed(from='',to=''){
  const rows=(historicalWarehouse.records||[]).filter(r=>(!from||r.fecha>=from)&&(!to||r.fecha<=to));
  const map=new Map();
  for(const r of rows){
    const key=`${r.source}|${r.archivo||'Archivo sin nombre'}`;
    if(!map.has(key))map.set(key,{source:r.source,archivo:r.archivo||'Archivo sin nombre',records:0,minDate:null,maxDate:null});
    const x=map.get(key);x.records++;
    if(r.fecha){if(!x.minDate||r.fecha<x.minDate)x.minDate=r.fecha;if(!x.maxDate||r.fecha>x.maxDate)x.maxDate=r.fecha;}
  }
  return [...map.values()].map(x=>{
    const meta=historicalSourceMeta(x.source);
    return {...x,status:'Procesado',loadedAt:meta.lastLoadedAt||null,processedBy:meta.loadedBy||'Sistema'};
  }).sort((a,b)=>a.source.localeCompare(b.source)||a.archivo.localeCompare(b.archivo,'es'));
}
function validateHistoricalDashboardModel(rows,mode='logeo'){
  const issues=[],warnings=[];
  const has=(field)=>rows.some(r=>r[field]!==null&&r[field]!==undefined&&r[field]!=='');
  const requirements=[
    ['Operador / RUT','operadorKey'],['Fecha','fecha'],['Planta','planta'],['Zona','zona'],['Turno','turnoMin'],
    ['Status Break / Logeo','loginMin'],['Marcaje TAM','tamIngresoMin']
  ];
  if(mode==='citacion')requirements.push(['Citación','citacionMin']);
  for(const [label,field] of requirements)if(!has(field))issues.push(`Falta información consolidada: ${label}`);
  const linkedRows=rows.filter(r=>
    r.operadorKey&&r.fecha&&r.turnoMin!==null&&
    (mode==='citacion'?r.citacionMin!==null:r.loginMin!==null)
  ).length;
  if(rows.length&&linkedRows!==rows.length)warnings.push(`Diferencia encontrada entre datos procesados y KPI calculables: ${rows.length-linkedRows} operador/día sin cruce completo.`);
  return {ready:issues.length===0,issues,warnings,processedRows:rows.length,kpiLinkedRows:linkedRows,difference:Math.max(0,rows.length-linkedRows)};
}
function operatorDelayProfile(items,cfg){
  const vals=(fieldA,fieldB,positiveOnly=true)=>items.map(r=>{
    if(r[fieldA]===null||r[fieldA]===undefined||r[fieldB]===null||r[fieldB]===undefined)return null;
    const d=histMinutesDiff(r[fieldA],r[fieldB]);return d===null?null:(positiveOnly?Math.max(0,d):d);
  }).filter(Number.isFinite);
  const delayCit=vals('loginMin','citacionMin');
  const delayLogin=vals('loginMin','turnoMin');
  const delayTam=vals('tamIngresoMin','turnoMin');
  const s=(v)=>histStats(v);
  return {atrasoCitacion:s(delayCit),atrasoLogeo:s(delayLogin),atrasoTam:s(delayTam)};
}
function buildAdvancedOperatorRankings(rows,cfg){
  const groups=new Map();
  for(const r of rows){if(!groups.has(r.operadorKey))groups.set(r.operadorKey,[]);groups.get(r.operadorKey).push(r);}
  const ops=[...groups.entries()].map(([key,items])=>{
    const first=items[0],m=histMetrics(items,cfg),d=operatorDelayProfile(items,cfg);
    const incumplimientoTurno=m.adherenciaTurno===null?null:round1(100-m.adherenciaTurno);
    return {
      key,operador:first.operadorNombre||first.operadorId||key,rut:first.operadorId||key,
      planta:first.planta||'Sin planta',zona:first.zona||'Sin zona',
      eventos:items.length,atrasoCitacion:d.atrasoCitacion,atrasoLogeo:d.atrasoLogeo,atrasoTam:d.atrasoTam,
      incumplimientoTurno,adherenciaTurno:m.adherenciaTurno,adherenciaCitacion:m.adherenciaCitacion
    };
  });
  const metricPath={atrasoCitacion:'atrasoCitacion.promedio',atrasoLogeo:'atrasoLogeo.promedio',atrasoTam:'atrasoTam.promedio',incumplimientoTurno:'incumplimientoTurno'};
  const get=(o,p)=>p.split('.').reduce((v,k)=>v?.[k],o);
  const make=(metric)=>{
    const p=metricPath[metric],eligible=ops.filter(o=>Number.isFinite(Number(get(o,p))));
    const sorted=[...eligible].sort((a,b)=>Number(get(b,p))-Number(get(a,p)));
    return sorted.slice(0,10);
  };
  return {
    atrasoCitacion:make('atrasoCitacion'),
    atrasoLogeo:make('atrasoLogeo'),
    atrasoTam:make('atrasoTam'),
    incumplimientoTurno:make('incumplimientoTurno'),
    totalOperators:ops.length
  };
}

function histCrossLabel(r){
  const p=[];
  if(r.turnoMin!==null&&r.turnoMin!==undefined)p.push('Turno');
  if(r.citacionMin!==null&&r.citacionMin!==undefined)p.push('Citación');
  if(r.loginMin!==null&&r.loginMin!==undefined||r.asignacionMin!==null&&r.asignacionMin!==undefined||r.primeraCargaMin!==null&&r.primeraCargaMin!==undefined)p.push('Status');
  if(r.tamIngresoMin!==null&&r.tamIngresoMin!==undefined||r.tamSalidaMin!==null&&r.tamSalidaMin!==undefined)p.push('TAM');
  return p.join(' + ')||'Sin fuente';
}


app.get('/api/historico/health-check',requireAuth,(req,res)=>{
  try{
    return res.json({
      ok:true,
      health:historicalEndToEndHealth(req.query),
      weeks:historicalAvailableWeeks(),
      ranges:historicalSourceRanges(),
      files:historicalFilesUsed?historicalFilesUsed(safeText(req.query.from),safeText(req.query.to)):[]
    });
  }catch(err){
    return res.status(422).json({ok:false,error:'No fue posible auditar el modelo histórico',detalle:err?.message||String(err)});
  }
});

app.get('/api/historico/fuentes',requireAuth,(req,res)=>{
  const idx=getHistoricalDailyIndex(),records=Array.isArray(historicalWarehouse?.records)?historicalWarehouse.records:[];
  const dates=idx.rows.map(r=>r.fecha).filter(Boolean).sort();
  return res.json({
    ok:true,revision:Number(historicalWarehouse?.revision||0),totalRecords:records.length,totalDays:idx.rows.length,loadedAt:historicalWarehouse?.loaded_at||null,
    minDate:dates[0]||null,maxDate:dates.at(-1)||null,
    sources:Object.keys(HISTORICAL_SOURCES).map(k=>({source:k,label:HISTORICAL_SOURCES[k].label,...historicalSourceMeta(k),fileDetails:historicalFileDetails(k)})),
    plants:idx.plants,
    plantCatalog:idx.plants.map(planta=>({planta,zona:(idx.rows.find(r=>r.planta===planta)?.zona)||inferZona(planta)})),
    zones:idx.zones,operators:idx.operators,
    diagnostics:(historicalWarehouse.diagnostics||[]).slice(0,100),
    recommendedDate:latestCommonHistoricalDate(),
    sourceRanges:historicalSourceRanges(),
    availableWeeks:historicalAvailableWeeks(),
    plantDictionary:{
      loaded:true,
      source:'config/plant-dictionary.json',
      canonicalPlants:Array.isArray(PLANT_DICTIONARY?.plants)?PLANT_DICTIONARY.plants.length:Object.keys(PLANT_DICTIONARY?.plants||{}).length,
      note:'La homologación de planta se ejecuta después de leer cada fila; un timeout de apertura XLSX ocurre antes de esta etapa.'
    }
  });
});

function historicalEndToEndHealth(query={}){
  const rows=histFilterBase(query);
  const has=(r,k)=>r?.[k]!==null&&r?.[k]!==undefined;
  const out={
    rows:rows.length,
    operators:new Set(rows.map(r=>r.operadorKey).filter(Boolean)).size,
    plants:new Set(rows.map(r=>r.planta).filter(p=>p&&p!=='Sin planta')).size,
    sourceCoverage:{
      turnos:rows.filter(r=>has(r,'turnoMin')).length,
      citaciones:rows.filter(r=>has(r,'citacionMin')).length,
      statusLogin:rows.filter(r=>has(r,'loginMin')).length,
      statusAsignacion:rows.filter(r=>has(r,'asignacionMin')).length,
      tam:rows.filter(r=>has(r,'tamIngresoMin')).length
    },
    crosses:{
      turnoLogin:rows.filter(r=>has(r,'turnoMin')&&has(r,'loginMin')).length,
      citacionLogin:rows.filter(r=>has(r,'citacionMin')&&has(r,'loginMin')).length,
      turnoTam:rows.filter(r=>has(r,'turnoMin')&&has(r,'tamIngresoMin')).length,
      tamLogin:rows.filter(r=>has(r,'tamIngresoMin')&&has(r,'loginMin')).length,
      turnoCitacionStatus:rows.filter(r=>has(r,'turnoMin')&&has(r,'citacionMin')&&has(r,'loginMin')).length,
      cuatroFuentes:rows.filter(r=>has(r,'turnoMin')&&has(r,'citacionMin')&&has(r,'loginMin')&&has(r,'tamIngresoMin')).length
    }
  };
  out.readyLogeo=out.crosses.turnoLogin>0;
  out.readyCitacion=out.crosses.citacionLogin>0;
  out.readyTam=out.crosses.turnoTam>0||out.crosses.tamLogin>0;
  out.readyDashboard=out.rows>0&&(out.readyLogeo||out.readyCitacion||out.readyTam);
  out.reason=out.readyDashboard?'Modelo histórico cruzado y calculable.':'No existen cruces suficientes en el período seleccionado.';
  return out;
}

app.get('/api/historico/dashboard-enterprise',requireAuth,(req,res)=>{
  try{
    const cfg=histCfg(req.query),rows=histFilterBase(req.query),from=safeText(req.query.from),to=safeText(req.query.to);
    const e2eHealth=historicalEndToEndHealth(req.query);
    const mode=String(req.query.mode||'logeo')==='citacion'?'citacion':'logeo';
    const coverage=historicalCoverage(req.query);
    const integrity=validateHistoricalDashboardModel(rows,mode);
    const filesUsed=historicalFilesUsed(from,to);
    const prevRange=histPreviousRange(from,to),prevRows=prevRange?histFilterBase(req.query,prevRange):[];
    const granularity=['day','week','month','quarter','year'].includes(String(req.query.granularity))?String(req.query.granularity):'week';
    const metrics=histMetricsForMode(rows,cfg,mode),operators=histOperatorGroups(rows,cfg,prevRows,mode);
    const primaryMetric=mode==='citacion'?'adherenciaCitacion':'adherenciaTurno';
    const plants=histGroupMetrics(rows,'planta',cfg,prevRows,mode).sort((a,b)=>(b[primaryMetric]??-1)-(a[primaryMetric]??-1));
    const zones=histGroupMetrics(rows,'zona',cfg,prevRows,mode).sort((a,b)=>(b[primaryMetric]??-1)-(a[primaryMetric]??-1));
    const uniqueOperators=[...new Map(operators.map(o=>[o.key,o])).values()];
    const rankingMetric=mode==='citacion'?'adherenciaCitacion':'adherenciaTurno';
    const rankedBase=uniqueOperators.filter(o=>Number.isFinite(Number(o?.[rankingMetric])));
    const rankedDesc=[...rankedBase].sort((a,b)=>Number(b[rankingMetric])-Number(a[rankingMetric]));
    const rankedAsc=[...rankedBase].sort((a,b)=>Number(a[rankingMetric])-Number(b[rankingMetric]));
    const rankingTop=rankedDesc.slice(0,10);
    const topKeys=new Set(rankingTop.map(x=>x.key));
    const rankingCritical=rankedAsc.filter(x=>!topKeys.has(x.key)).slice(0,10);
    const operatorRanking={
      metric:rankingMetric,
      label:mode==='citacion'?'Adherencia a Citación':'Adherencia al Turno',
      totalEligible:rankedBase.length,
      top:rankingTop,
      critical:rankingCritical,
      reason:rankedBase.length?'':(mode==='citacion'
        ?'No existen operadores con Citación + LOGIN suficientes para calcular adherencia a citación.'
        :'No existen operadores con Turno + LOGIN suficientes para calcular adherencia al turno.')
    };
    const rankings={
      mejorTurno:histRank(uniqueOperators,'adherenciaTurno','desc'),mejorCitacion:histRank(uniqueOperators,'adherenciaCitacion','desc'),
      menorTiempoMuerto:histRank(uniqueOperators,'tiempoMuerto.promedio','asc'),menorAtrasoCitacion:histRank(uniqueOperators,'atrasoCitacion.promedio','asc'),menorAtrasoTurno:histRank(uniqueOperators,'atrasoTurno.promedio','asc'),
      critTiempoMuerto:histRank(uniqueOperators,'tiempoMuerto.promedio','desc'),critAtrasoCitacion:histRank(uniqueOperators,'atrasoCitacion.promedio','desc'),critAtrasoTurno:histRank(uniqueOperators,'atrasoTurno.promedio','desc'),
      critAdherenciaTurno:histRank(uniqueOperators,'adherenciaTurno','asc'),critAdherenciaCitacion:histRank(uniqueOperators,'adherenciaCitacion','asc')
    };
    const byPlant=plants.map(p=>{
      const pr=rows.filter(r=>r.planta===p.name),ppr=prevRows.filter(r=>r.planta===p.name),ops=histOperatorGroups(pr,cfg,ppr,mode);
      const rankMetric=mode==='citacion'?'adherenciaCitacion':'adherenciaTurno';
      const uniqueOps=[...new Map(ops.map(o=>[o.key,o])).values()];
      return {planta:p.name,zona:pr[0]?.zona||'',metrics:p,mode,rankMetric,mejores:histRank(uniqueOps,rankMetric,'desc'),criticos:histRank(uniqueOps,rankMetric,'asc')};
    });
    const trend=aggregateHistoricalEnterprise(rows,granularity,cfg,mode);
    const heatMap=new Map();for(const r of rows){if(r.planta==='Sin planta')continue;const d=r.turnoMin!==null&&r.loginMin!==null?Math.max(0,histMinutesDiff(r.loginMin,r.turnoMin)||0):null;if(d===null)continue;const k=`${r.planta}|${r.fecha}`;if(!heatMap.has(k))heatMap.set(k,[]);heatMap.get(k).push(d);}
    const heatmap=[...heatMap.entries()].map(([k,v])=>{const [planta,fecha]=k.split('|');return {planta,fecha,valor:round1(v.reduce((a,b)=>a+b,0)/v.length)};});
    const findings=histInsights(metrics,plants,zones,operators);
    const advancedRankings=buildAdvancedOperatorRankings(rows,cfg);
    return res.json({
      ok:true,source:'historicalWarehouse:file-attachments-only',from,to,previousRange:prevRange,granularity,cfg,mode,empty:rows.length===0,
      mensaje:rows.length?'':'NO SE ENCONTRARON DATOS PARA EL PERÍODO SELECCIONADO',
      metrics,trend,rankings,operatorRanking,advancedRankings,plants,zones,byPlant,heatmap,findings,coverage,integrity,filesUsed,e2eHealth,
      recommendedDate:latestCommonHistoricalDate(),
      sourceRanges:historicalSourceRanges(),
      detailed:rows.slice(0,2500).map(r=>({...r,crossLabel:histCrossLabel(r)})),totalDetailed:rows.length,
      catalog:{plants:getHistoricalDailyIndex().plants,zones:getHistoricalDailyIndex().zones,operators:getHistoricalDailyIndex().operators},
      audit:{revision:Number(historicalWarehouse?.revision||0),records:(historicalWarehouse?.records||[]).length,sources:Object.keys(HISTORICAL_SOURCES).map(k=>({source:k,...historicalSourceMeta(k)}))}
    });
  }catch(err){
    registrarErrorDetallado({modulo:'historico',funcion:'GET /api/historico/dashboard-enterprise',error:err?.message||String(err),stack:err?.stack});
    return res.status(422).json({error:'No fue posible construir Trazabilidad Intelligence',detalle:err?.message||String(err)});
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
    console.log(`[CCO][startup] CCO Intelligence v4.2.2 activo en puerto ${PORT}`);
    console.log(`[CCO][startup] Diccionario plantas: ${PLANT_DICTIONARY.plants.length} plantas, ${PLANT_DICTIONARY_LOOKUP.size} alias resolubles, ${Object.keys(PLANT_DICTIONARY.conflicts||{}).length} alias ambiguos`);
    if (NODE_ENV === 'production' && AUTH_SECRET === 'cco-dev-secret-change-me') console.warn('[CCO][security] Configure AUTH_SECRET en producción.');
  });
}

module.exports = { app, server, state, _test:{ buildOperatorRecords, buildRecordsWithDiagnostics, validateDataset, normalizeRows, parseTimeMinutes, parseDateKey, filterRowsForDate, ensurePlant, canonicalPlantName, normalizeId, sourceCoverageForDate, recordsToPlantRows, registrarErrorDetallado, FIELDS, historicalNormalizeRecord, validateHistoricalRecord, historicalPeriodKey, aggregateHistoricalEnterprise, historicalAvg, getHistoricalRuntimeIndex } };
