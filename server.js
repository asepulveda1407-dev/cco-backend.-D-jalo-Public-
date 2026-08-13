// ============================================================================
// CCO Intelligence — Backend de prototipo, VERSIÓN STACKBLITZ
// (idéntico en endpoints y comportamiento al backend/server.js original;
//  la única diferencia es el almacenamiento: en memoria pura JS en vez de
//  SQLite, porque StackBlitz corre Node dentro del navegador -WebContainers-
//  y no soporta módulos nativos compilados como better-sqlite3).
//
//  IMPORTANTE: esto es solo para la demo en el navegador. En producción
//  (Azure) se usa la versión con base de datos real, documentada en
//  docs/01_ARQUITECTURA_TECNICA.md. Aquí los datos se pierden si se
//  reinicia el proyecto de StackBlitz — es intencional, es una demo.
// ============================================================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'demo-secret-cco-cambiar-en-produccion';
const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// 1. "Base de datos" en memoria
// ---------------------------------------------------------------------------
let nextUsuarioId = 1;
let nextBitacoraId = 1;
let nextAuditoriaId = 1;

const usuarios = new Map(); // nombre -> usuario

const plantas = new Map([
  ['Til Til', { id: 1, nombre: 'Til Til', zona: 'RM', region: 'Metropolitana', tol_v: 5, tol_a: 15, tol_asig: 30, tol_carga: 45, citacion: 'no', actualizado_por: 'seed', actualizado_en: new Date().toISOString() }],
  ['Viña del Mar', { id: 2, nombre: 'Viña del Mar', zona: 'Centro', region: 'Valparaíso', tol_v: 5, tol_a: 15, tol_asig: 30, tol_carga: 45, citacion: 'no', actualizado_por: 'seed', actualizado_en: new Date().toISOString() }],
  ['Los Andes', { id: 3, nombre: 'Los Andes', zona: 'Centro', region: 'Valparaíso', tol_v: 5, tol_a: 15, tol_asig: 30, tol_carga: 45, citacion: 'no', actualizado_por: 'seed', actualizado_en: new Date().toISOString() }],
  ['Antofagasta', { id: 4, nombre: 'Antofagasta', zona: 'Norte', region: 'Antofagasta', tol_v: 5, tol_a: 15, tol_asig: 30, tol_carga: 45, citacion: 'no', actualizado_por: 'seed', actualizado_en: new Date().toISOString() }],
]);

let bitacora = []; // más reciente primero
let auditoria = []; // más reciente primero

// ---------------------------------------------------------------------------
// 2. Auth de demo
// ---------------------------------------------------------------------------
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Token inválido o ausente' });
  }
}

function puedeEditarConfigGlobal(user) {
  return user.rol === 'supervisor_nacional' || user.rol === 'gerencia';
}

// ---------------------------------------------------------------------------
// 3. App + WebSocket
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.on('join', ({ planta }) => {
    socket.join('nacional');
    if (planta) socket.join('planta:' + planta);
  });
});

function broadcast(room, event, payload) {
  io.to(room).emit(event, payload);
}

function registrarAuditoria({ usuario, entidad, entidad_id, accion, anterior, nuevo }) {
  auditoria.unshift({
    id: nextAuditoriaId++,
    usuario,
    entidad,
    entidad_id: String(entidad_id ?? ''),
    accion,
    valor_anterior: JSON.stringify(anterior ?? null),
    valor_nuevo: JSON.stringify(nuevo ?? null),
    ts: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 4. Endpoints (mismo contrato que la versión con base de datos)
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/api/auth/login', (req, res) => {
  const { nombre, rol, zona } = req.body;
  if (!nombre || !rol) return res.status(400).json({ error: 'nombre y rol son requeridos' });
  let user = usuarios.get(nombre);
  if (!user) {
    user = {
      id: nextUsuarioId++,
      nombre,
      email: nombre.toLowerCase().replace(/\s+/g, '.') + '@polpaicosoluciones.cl',
      rol,
      zona: zona || null,
    };
    usuarios.set(nombre, user);
  }
  const token = jwt.sign({ id: user.id, nombre: user.nombre, rol: user.rol, zona: user.zona }, JWT_SECRET, {
    expiresIn: '8h',
  });
  res.json({ token, user });
});

app.get('/api/plantas', authMiddleware, (req, res) => {
  res.json([...plantas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)));
});

app.put('/api/plantas/:nombre/config', authMiddleware, (req, res) => {
  if (!puedeEditarConfigGlobal(req.user)) {
    return res.status(403).json({ error: 'Rol sin permiso para editar configuración de planta' });
  }
  const { nombre } = req.params;
  const anterior = plantas.get(nombre);
  if (!anterior) return res.status(404).json({ error: 'Planta no encontrada' });

  const { tol_v, tol_a, tol_asig, tol_carga, citacion } = req.body;
  const nuevo = {
    ...anterior,
    tol_v: tol_v ?? anterior.tol_v,
    tol_a: tol_a ?? anterior.tol_a,
    tol_asig: tol_asig ?? anterior.tol_asig,
    tol_carga: tol_carga ?? anterior.tol_carga,
    citacion: citacion ?? anterior.citacion,
    actualizado_por: req.user.nombre,
    actualizado_en: new Date().toISOString(),
  };
  plantas.set(nombre, nuevo);

  registrarAuditoria({ usuario: req.user.nombre, entidad: 'configuraciones_planta', entidad_id: nombre, accion: 'update', anterior, nuevo });

  broadcast('nacional', 'config:actualizada', nuevo);
  broadcast('planta:' + nombre, 'config:actualizada', nuevo);

  res.json(nuevo);
});

app.get('/api/bitacora', authMiddleware, (req, res) => {
  res.json(bitacora.slice(0, 200));
});

app.post('/api/bitacora', authMiddleware, (req, res) => {
  const { planta, tipo, detalle, fecha_hora } = req.body;
  if (!planta || !tipo || !detalle) return res.status(400).json({ error: 'planta, tipo y detalle son requeridos' });

  const registro = {
    id: nextBitacoraId++,
    fecha_hora: fecha_hora || new Date().toISOString(),
    usuario: req.user.nombre,
    rol: req.user.rol,
    planta,
    tipo,
    detalle,
    creado_en: new Date().toISOString(),
  };
  bitacora.unshift(registro);

  registrarAuditoria({ usuario: req.user.nombre, entidad: 'bitacora', entidad_id: registro.id, accion: 'insert', anterior: null, nuevo: registro });

  broadcast('nacional', 'bitacora:nueva', registro);
  broadcast('planta:' + planta, 'bitacora:nueva', registro);

  res.status(201).json(registro);
});

app.get('/api/auditoria', authMiddleware, (req, res) => {
  if (!puedeEditarConfigGlobal(req.user)) return res.status(403).json({ error: 'Sin permiso' });
  res.json(auditoria.slice(0, 100));
});

server.listen(PORT, () => {
  console.log(`CCO backend (memoria) escuchando en el puerto ${PORT}`);
});
