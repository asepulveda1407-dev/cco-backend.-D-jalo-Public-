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
  nombre: ['operador','nombre_operador','nom_operador','operario','nombre','employee_name','nombre_funcionario'],
  planta: ['planta','planta_origen','origen','plta','descripcion_planta','descripción planta','plant'],
  zona: ['zona','region','región'],
  turno: ['turno_inicio','hora_inicio','hora_ingreso','hora ingreso','horaingreso','turno','inicio_turno'],
  citacion: ['citacion','citación','cita','hora_citacion','hora citacion','citacion_sugerida','citación sugerida'],
  logeo: ['logeo','marcacion','marcación','hora_logeo','hora logeo','entrada','login','fecha_hora','fecha hora'],
  estado: ['descripcion_estado','descripción estado','estado','status','status_description','descripcion status','descripción status'],
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

function operatorKey(row) {
  const id = normalizeId(pick(row, FIELDS.id));
  if (id) return `id:${id}`;
  const name = normalizeName(pick(row, FIELDS.nombre));
  return name ? `name:${name}` : '';
}
function rowOperator(row) {
  const id = normalizeId(pick(row, FIELDS.id));
  const nombre = safeText(pick(row, FIELDS.nombre)) || (id ? `Operador ${id}` : 'Sin nombre');
  return { id: id || normalizeName(nombre), nombre };
}

function inferZona(planta) {
  const p = normalizeName(planta);
  if (/antofag|calama|copiapo|la negra|norte/.test(p)) return 'Norte';
  if (/melipilla|espejo|santo domingo|quilicura|puente alto|san bernardo|renca|maipu|maipu|rm|central mix/.test(p)) return 'RM';
  if (/vina|viña|valparaiso|quilpue|los andes|san felipe|centro/.test(p)) return 'Centro';
  if (/concepcion|concepción|temuco|valdivia|osorno|puerto montt|sur/.test(p)) return 'Sur';
  return 'RM';
}

function ensurePlant(name, zone) {
  const clean = safeText(name) || 'Sin planta';
  if (!state.plantas[clean]) {
    state.plantas[clean] = {
      nombre: clean,
      zona: zone || inferZona(clean),
      tol_v: 5,
      tol_a: 30,
      tol_asig: 30,
      citacion: 'no',
      actualizado_por: 'Sistema',
      actualizado_en: nowIso(),
    };
  }
  return state.plantas[clean];
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

function buildOperatorRecords() {
  const shifts = getTurnos();
  const citations = getCitaciones();
  const logs = getLogeo();
  const cByKey = new Map();
  const logsByKey = new Map();

  for (const c of citations) {
    const key = operatorKey(c); if (!key) continue;
    if (!cByKey.has(key)) cByKey.set(key, []);
    cByKey.get(key).push(c);
  }
  for (const l of logs) {
    const key = operatorKey(l); if (!key) continue;
    if (!logsByKey.has(key)) logsByKey.set(key, []);
    logsByKey.get(key).push(l);
  }

  return shifts.map((t, idx) => {
    const key = operatorKey(t) || `row:${idx}`;
    const { id, nombre } = rowOperator(t);
    const planta = safeText(pick(t, FIELDS.planta)) || 'Sin planta';
    const pCfg = ensurePlant(planta, safeText(pick(t, FIELDS.zona)) || undefined);
    const turnoMin = parseTimeMinutes(pick(t, FIELDS.turno));

    const cs = cByKey.get(key) || [];
    let citacionMin = null;
    for (const c of cs) {
      const m = parseTimeMinutes(pick(c, FIELDS.citacion));
      if (m !== null && (citacionMin === null || Math.abs(diffMinutes(m, turnoMin)) < Math.abs(diffMinutes(citacionMin, turnoMin)))) citacionMin = m;
    }

    const ls = logsByKey.get(key) || [];
    const events = ls.map(l => ({
      row: l,
      min: parseTimeMinutes(getEventTimeValue(l)),
      estado: normalizeName(pick(l, FIELDS.estado)),
    })).filter(x => x.min !== null);

    let loginEvent = events.find(e => /login|logeo|logeado|entrada/.test(e.estado));
    if (!loginEvent && events.length) loginEvent = [...events].sort((a,b) => Math.abs(diffMinutes(a.min, turnoMin)) - Math.abs(diffMinutes(b.min, turnoMin)))[0];
    const logeoMin = loginEvent?.min ?? null;

    const assignmentCandidates = events.filter(e => /asignad/.test(e.estado));
    let asignacionMin = null;
    if (assignmentCandidates.length && logeoMin !== null) {
      const after = assignmentCandidates.map(e => ({...e, d: diffMinutes(e.min, logeoMin)})).filter(e => e.d >= 0).sort((a,b)=>a.d-b.d);
      asignacionMin = after[0]?.min ?? assignmentCandidates[0]?.min ?? null;
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

    return {
      key, id, nombre, planta, zona: pCfg.zona,
      turnoMin, citacionMin, logeoMin, asignacionMin,
      horaTurno: fmtMinutes(turnoMin), horaCitacion: fmtMinutes(citacionMin), horaLogeo: fmtMinutes(logeoMin), horaAsignacion: fmtMinutes(asignacionMin),
      turno: fmtMinutes(turnoMin), citacionHora: fmtMinutes(citacionMin), logeo: fmtMinutes(logeoMin), asignacion: fmtMinutes(asignacionMin),
      atrasoTurnoMin: atraso,
      adelantoMin: atraso !== null && atraso < 0 ? Math.abs(atraso) : 0,
      tiempoMuertoMin,
      esperaMin: tiempoMuertoMin,
      esperaAsignacionMin: tiempoMuertoMin,
      categoria, estado,
      etiqueta: estado,
      horaTurnoSospechosa: turnoMin !== null && (turnoMin < 5*60 || turnoMin > 23*60+59),
    };
  });
}

function filterScope(records, query) {
  const zona = safeText(query.zona || '');
  const plantas = String(query.plantas || '').split(',').map(s=>s.trim()).filter(Boolean);
  return records.filter(r => (!zona || r.zona === zona) && (!plantas.length || plantas.includes(r.planta)));
}

function datasetPlantCount(type, planta) {
  const rows = state.datasets[type].datos || [];
  return rows.filter(r => safeText(pick(r, FIELDS.planta)) === planta).length;
}

app.get('/health', (req, res) => res.json({
  ok: true,
  service: 'CCO Intelligence',
  version: '1.0.0',
  env: NODE_ENV,
  timestamp: nowIso(),
  uptime_s: Math.round(process.uptime()),
  persistence: DATA_FILE,
}));

app.post('/api/auth/login', (req, res) => {
  const nombre = safeText(req.body?.nombre);
  const rol = safeText(req.body?.rol || 'coordinador');
  const zona = safeText(req.body?.zona || '');
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const allowedRoles = new Set(['admin','gerencia','supervisor_nacional','supervisor_zona','supervisor_planta','coordinador','lectura']);
  if (!allowedRoles.has(rol)) return res.status(400).json({ error: 'Rol inválido' });
  const user = { nombre, rol, zona };
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
      },
    };
    if (tipo === 'turnos') {
      for (const row of result.valid) ensurePlant(pick(row, FIELDS.planta), pick(row, FIELDS.zona));
    }
    state.audit.unshift({ id: crypto.randomUUID(), action:'ingesta', tipo, archivo, usuario:req.user.nombre, fecha:nowIso() });
    state.audit = state.audit.slice(0, 2000);
    persistState();
    const info = { tipo, cantidad: result.valid.length, subido_por: req.user.nombre, filas_rechazadas: result.rejected.length };
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

app.get('/api/plantas', requireAuth, (req, res) => {
  res.json(Object.values(state.plantas).sort((a,b)=>a.zona.localeCompare(b.zona,'es') || a.nombre.localeCompare(b.nombre,'es')));
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
  for (const row of getTurnos()) {
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
  let records = buildOperatorRecords();
  if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
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
  const records = buildOperatorRecords().filter(r=>r.planta===planta);
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
  let records = filterScope(buildOperatorRecords(), req.query);
  if (req.user.zona) records = records.filter(r=>r.zona===req.user.zona);
  const plantNames = [...new Set(records.map(r=>r.planta))];
  if (!plantNames.length) return res.status(400).json({ error:'No hay turnos cargados para el alcance seleccionado' });
  const byPlant = plantNames.map(planta=>{
    const rs=records.filter(r=>r.planta===planta);
    const logged=rs.filter(r=>r.logeoMin!==null);
    const tm=rs.filter(r=>r.tiempoMuertoMin!==null);
    return {
      planta,
      zona:ensurePlant(planta).zona,
      turnos:rs.length,
      citaciones:rs.filter(r=>r.citacionMin!==null).length,
      logeo:logged.length,
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
    generado_en:nowIso(),
    zona:req.query.zona || req.user.zona || null,
    plantasFiltro:req.query.plantas?String(req.query.plantas).split(',').filter(Boolean):null,
    resumen:{
      totalTurnos:records.length,
      totalCitaciones:records.filter(r=>r.citacionMin!==null).length,
      totalLogeo:records.filter(r=>r.logeoMin!==null).length,
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
  console.log(`CCO Intelligence v1.0.0 activo en puerto ${PORT}`);
  if (NODE_ENV === 'production' && AUTH_SECRET === 'cco-dev-secret-change-me') {
    console.warn('ADVERTENCIA: configure AUTH_SECRET en producción.');
  }
});
