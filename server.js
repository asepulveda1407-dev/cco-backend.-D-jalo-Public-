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

// ---------------------------------------------------------------------------
// Homologación de plantas: nombre canónico (el que usan los Turnos) + alias por
// código de planta (los que usan Citaciones/Logeo, ej. '1U' = Curicó). Extraído
// directamente de datos reales de Polpaico. Zona es una asignación razonable por
// ubicación geográfica — revisar/ajustar si no calza con la zonificación interna.
// ---------------------------------------------------------------------------
const PLANTAS_REALES = [
  ['Arica', 'Norte', 'Arica y Parinacota', ['3B']],
  ['Iquique AH', 'Norte', 'Tarapacá', ['1A']],
  ['Copiapó', 'Norte', 'Atacama', ['1K']],
  ['Coquimbo', 'Norte', 'Coquimbo', ['1L']],
  ['Ovalle', 'Norte', 'Coquimbo', ['1M']],
  ['Lo Espejo', 'RM', 'Metropolitana', ['410', '411']],
  ['La Divisa Oriente', 'RM', 'Metropolitana', ['422']],
  ['La Divisa Poniente', 'RM', 'Metropolitana', ['401']],
  ['Divisa Central Mix', 'RM', 'Metropolitana', ['451']],
  ['Melipilla', 'RM', 'Metropolitana', ['2U']],
  ['Viña del Mar', 'Centro', 'Valparaíso', ['1Q']],
  ['Los Andes', 'Centro', 'Valparaíso', ['52']],
  ['Santo Domingo', 'Centro', 'Valparaíso', ['1P']],
  ['Rancagua', 'Centro', "O'Higgins", ['1R']],
  ['San Vicente', 'Centro', "O'Higgins", ['1S']],
  ['Curicó', 'Centro', 'Maule', ['1U']],
  ['Talca', 'Centro', 'Maule', ['1V']],
  ['Linares', 'Centro', 'Maule', ['1T']],
  ['Chillán', 'Sur', 'Ñuble', ['3D']],
  ['Concepción Hualpén', 'Sur', 'Biobío', ['1W']],
  ['Coronel', 'Sur', 'Biobío', ['2C']],
  ['Los Ángeles', 'Sur', 'Biobío', ['2X']],
  ['Temuco', 'Sur', 'Araucanía', ['2Y']],
  ['Villarrica', 'Sur', 'Araucanía', ['2G']],
  ['Castro', 'Sur', 'Los Lagos', ['2H']],
  ['Puerto Montt', 'Sur', 'Los Lagos', ['2I']],
];

const plantas = new Map(
  PLANTAS_REALES.map(([nombre, zona, region], idx) => [
    nombre,
    { id: idx + 1, nombre, zona, region, tol_v: 5, tol_a: 15, tol_asig: 30, tol_carga: 45, citacion: 'no', actualizado_por: 'seed', actualizado_en: new Date().toISOString() },
  ])
);

// Código de planta -> nombre canónico (para Citaciones/Logeo, que suelen traer código en vez de nombre)
const ALIAS_CODIGO_PLANTA = {};
PLANTAS_REALES.forEach(([nombre, , , codigos]) => {
  (codigos || []).forEach((c) => { ALIAS_CODIGO_PLANTA[c.toUpperCase()] = nombre; });
});

let bitacora = []; // más reciente primero
let auditoria = []; // más reciente primero

// Datos de ingesta: turnos (programación), citaciones (hora citada por Syncrotess/similar),
// logeo (marcación real del operador). Cada uno es un array de registros "crudos" tal cual
// vinieron del Excel, más metadatos de quién/cuándo se subió.
let ingestas = {
  turnos: { registros: [], subido_por: null, subido_en: null, archivo: null },
  citaciones: { registros: [], subido_por: null, subido_en: null, archivo: null },
  logeo: { registros: [], subido_por: null, subido_en: null, archivo: null },
};

// Intenta encontrar, entre las llaves de un registro, la que mejor calza con una lista de
// nombres de columna candidatos (insensible a mayúsculas/acentos/espacios), igual que hacía
// el HTML original con su función col(). Devuelve el VALOR de esa columna, o null.
function buscarCampo(registro, candidatos) {
  const normalizar = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  const llaves = Object.keys(registro || {});
  for (const cand of candidatos) {
    const candNorm = normalizar(cand);
    const encontrada = llaves.find((k) => normalizar(k) === candNorm);
    if (encontrada) return registro[encontrada];
  }
  // Segundo intento: coincidencia parcial (contiene)
  for (const cand of candidatos) {
    const candNorm = normalizar(cand);
    const encontrada = llaves.find((k) => normalizar(k).includes(candNorm));
    if (encontrada) return registro[encontrada];
  }
  return null;
}

function normalizarNombre(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resuelve el nombre canónico de planta de un registro probando, en orden: nombre de
// planta directo, código de planta (vía tabla de alias). Usa coincidencia EXACTA tras
// normalizar (no "contiene"), para evitar falsos positivos como "ARICA" calzando dentro
// de "VILLARICA".
function resolverPlantaCanonica(registro) {
  const nombresCanonicosNorm = new Map([...plantas.keys()].map((n) => [normalizarNombre(n), n]));

  const candidatoNombre = buscarCampo(registro, ['planta', 'plant', 'nombre planta', 'sitio', 'descripcion planta', 'descripción planta']);
  if (candidatoNombre) {
    const norm = normalizarNombre(candidatoNombre);
    if (nombresCanonicosNorm.has(norm)) return nombresCanonicosNorm.get(norm);
    const porCodigo = ALIAS_CODIGO_PLANTA[String(candidatoNombre).toUpperCase().trim()];
    if (porCodigo) return porCodigo;
  }

  const candidatoCodigo = buscarCampo(registro, ['numero planta', 'número planta', 'codigo planta', 'código planta']);
  if (candidatoCodigo) {
    const porCodigo = ALIAS_CODIGO_PLANTA[String(candidatoCodigo).toUpperCase().trim()];
    if (porCodigo) return porCodigo;
  }

  return null;
}

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
app.use(express.json({ limit: '50mb' }));

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

// ---------------------------------------------------------------------------
// 5. Ingesta de datos (Turnos / Citaciones / Logeo) — recibe filas ya parseadas
//    en el navegador desde el Excel (SheetJS), no el archivo binario. Esto evita
//    tener que procesar XLSX en el servidor.
// ---------------------------------------------------------------------------

const TIPOS_INGESTA = ['turnos', 'citaciones', 'logeo'];

app.post('/api/ingesta', authMiddleware, (req, res) => {
  const { tipo, registros, archivo } = req.body;
  if (!TIPOS_INGESTA.includes(tipo)) {
    return res.status(400).json({ error: `tipo debe ser uno de: ${TIPOS_INGESTA.join(', ')}` });
  }
  if (!Array.isArray(registros) || registros.length === 0) {
    return res.status(400).json({ error: 'registros debe ser un arreglo no vacío' });
  }

  const anterior = { cantidad: ingestas[tipo].registros.length, archivo: ingestas[tipo].archivo };
  ingestas[tipo] = {
    registros,
    subido_por: req.user.nombre,
    subido_en: new Date().toISOString(),
    archivo: archivo || null,
  };

  registrarAuditoria({
    usuario: req.user.nombre,
    entidad: 'ingesta_' + tipo,
    entidad_id: archivo || tipo,
    accion: 'upload',
    anterior,
    nuevo: { cantidad: registros.length, archivo: archivo || null },
  });

  broadcast('nacional', 'ingesta:actualizada', {
    tipo,
    cantidad: registros.length,
    subido_por: req.user.nombre,
    subido_en: ingestas[tipo].subido_en,
    archivo: archivo || null,
  });

  res.status(201).json({
    tipo,
    cantidad: registros.length,
    subido_por: req.user.nombre,
    subido_en: ingestas[tipo].subido_en,
  });
});

// Estado actual de las 3 ingestas (para pintar la pestaña de Automatización/Carga de datos)
app.get('/api/ingesta/estado', authMiddleware, (req, res) => {
  const estado = {};
  for (const tipo of TIPOS_INGESTA) {
    estado[tipo] = {
      cantidad: ingestas[tipo].registros.length,
      subido_por: ingestas[tipo].subido_por,
      subido_en: ingestas[tipo].subido_en,
      archivo: ingestas[tipo].archivo,
    };
  }
  res.json(estado);
});

// ---------------------------------------------------------------------------
// 6. Reporte ejecutivo — calculado a partir de las 3 ingestas + la lista de
//    plantas/configuración ya existente. Sin datos, igual responde con la
//    estructura vacía para que el frontend no truene.
// ---------------------------------------------------------------------------

app.get('/api/reporte', authMiddleware, (req, res) => {
  const nombresPlantas = [...plantas.keys()];

  // Agrupa cada tipo de registro por planta canónica (nombre o código homologado)
  function contarPorPlanta(tipo) {
    const conteo = {};
    for (const nombre of nombresPlantas) conteo[nombre] = 0;
    let sinPlantaReconocida = 0;
    for (const r of ingestas[tipo].registros) {
      const match = resolverPlantaCanonica(r);
      if (match && conteo.hasOwnProperty(match)) conteo[match]++;
      else sinPlantaReconocida++;
    }
    return { conteo, sinPlantaReconocida };
  }

  const turnosPorPlanta = contarPorPlanta('turnos');
  const citacionesPorPlanta = contarPorPlanta('citaciones');
  const logeoPorPlanta = contarPorPlanta('logeo');

  const filasPlanta = nombresPlantas.map((nombre) => {
    const turnos = turnosPorPlanta.conteo[nombre] || 0;
    const citaciones = citacionesPorPlanta.conteo[nombre] || 0;
    const logeo = logeoPorPlanta.conteo[nombre] || 0;
    const adherenciaLogeo = turnos > 0 ? Math.round((logeo / turnos) * 1000) / 10 : null;
    const adherenciaCitacion =
      plantas.get(nombre).citacion === 'si' && turnos > 0 ? Math.round((citaciones / turnos) * 1000) / 10 : null;
    return { planta: nombre, zona: plantas.get(nombre).zona, turnos, citaciones, logeo, adherenciaLogeo, adherenciaCitacion };
  });

  const totalTurnos = ingestas.turnos.registros.length;
  const totalCitaciones = ingestas.citaciones.registros.length;
  const totalLogeo = ingestas.logeo.registros.length;

  const plantasSinDatos = filasPlanta.filter((f) => f.turnos === 0).map((f) => f.planta);
  const plantasBajaAdherencia = filasPlanta.filter((f) => f.adherenciaLogeo !== null && f.adherenciaLogeo < 90);

  // Narrativa automática breve, en español, estilo ejecutivo
  const lineas = [];
  const fecha = new Date().toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' });
  lineas.push(`Reporte ejecutivo CCO — generado ${fecha} por ${req.user.nombre}.`);
  lineas.push(
    `Datos cargados: ${totalTurnos} turnos, ${totalCitaciones} citaciones, ${totalLogeo} registros de logeo, sobre ${nombresPlantas.length} plantas configuradas.`
  );
  if (plantasSinDatos.length) {
    lineas.push(`Sin datos de turno cargados: ${plantasSinDatos.join(', ')}.`);
  }
  if (plantasBajaAdherencia.length) {
    lineas.push(
      `Adherencia de logeo bajo 90%: ${plantasBajaAdherencia.map((f) => `${f.planta} (${f.adherenciaLogeo}%)`).join(', ')}.`
    );
  } else if (totalTurnos > 0) {
    lineas.push('Todas las plantas con datos muestran adherencia de logeo igual o superior a 90%.');
  }
  const totalSinReconocer = turnosPorPlanta.sinPlantaReconocida + citacionesPorPlanta.sinPlantaReconocida + logeoPorPlanta.sinPlantaReconocida;
  if (totalSinReconocer > 0) {
    lineas.push(
      `Atención: ${totalSinReconocer} filas no se pudieron cruzar a ninguna planta conocida (nombre o código no reconocido en la tabla de homologación).`
    );
  }
  if (bitacora.length) {
    lineas.push(`Eventos registrados en bitácora en este período: ${bitacora.length}.`);
  }

  res.json({
    generado_en: new Date().toISOString(),
    generado_por: req.user.nombre,
    resumen: { totalTurnos, totalCitaciones, totalLogeo, totalPlantas: nombresPlantas.length, filasSinReconocer: totalSinReconocer },
    porPlanta: filasPlanta,
    narrativa: lineas,
  });
});

server.listen(PORT, () => {
  console.log(`CCO backend (memoria) escuchando en el puerto ${PORT}`);
});
