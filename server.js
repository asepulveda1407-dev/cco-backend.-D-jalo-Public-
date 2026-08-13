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
  } else {
    // Actualiza rol/zona en cada login: si alguien vuelve a entrar con otro
    // rol o zona, debe reflejarse (antes quedaba "pegado" al primer login).
    user = { ...user, rol, zona: zona || null };
  }
  usuarios.set(nombre, user);
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

// ---------------------------------------------------------------------------
// 6.5 Análisis de operadores: compara Turno (hora programada) vs Logeo real vs
//     Primera asignación real, detectando atrasos/adelantos en minutos.
//     Basado en la máquina de estados real de Logeo: LOGIN/PRE-VIAJE (inicio
//     de turno) -> ... -> ASIGNADO (primera asignación de carga).
// ---------------------------------------------------------------------------

// Convierte una hora en cualquier formato común (Date/ISO, "HH:MM", "HH:MM:SS",
// "YYYY-MM-DD HH:MM:SS") a minutos desde medianoche. Devuelve null si no se pudo.
function horaAMinutos(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  // Date real o string ISO con fecha y hora
  if (valor instanceof Date || /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}/.test(String(valor))) {
    const d = new Date(valor);
    if (!isNaN(d.getTime())) return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  // "HH:MM" o "HH:MM:SS"
  const m = String(valor).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return null;
}

function formatoHHMM(minutos) {
  if (minutos === null || minutos === undefined) return null;
  const m = ((minutos % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

function idOperadorDeRegistro(registro) {
  const v = buscarCampo(registro, ['id operador', 'id_operador', 'numero funcionario', 'número funcionario']);
  return v !== null && v !== undefined ? String(v).trim() : null;
}

function nombreOperadorDeRegistro(registro) {
  return (
    buscarCampo(registro, ['conductor', 'operador', 'nombre operador']) ||
    [buscarCampo(registro, ['primero empleado']), buscarCampo(registro, ['ultimo empleado', 'último empleado'])]
      .filter(Boolean)
      .join(' ') ||
    null
  );
}

// Clasifica la comparación turno vs logeo en categorías CON NOMBRE EXPLÍCITO
// (no solo color), usando las tolerancias configuradas para la planta.
function clasificarPuntualidad(atrasoMin, tolerancias) {
  if (atrasoMin === null) return { categoria: 'sin_logeo', etiqueta: 'Sin logeo registrado' };
  if (atrasoMin < -5) return { categoria: 'adelantado', etiqueta: `Adelantado ${Math.abs(atrasoMin)} min` };
  if (atrasoMin <= tolerancias.tol_v) return { categoria: 'a_tiempo', etiqueta: 'A tiempo' };
  if (atrasoMin <= tolerancias.tol_a) return { categoria: 'atraso_leve', etiqueta: `Atraso leve (${atrasoMin} min)` };
  return { categoria: 'atraso_critico', etiqueta: `Atraso crítico (${atrasoMin} min)` };
}

// Construye, para cada operador presente en Turnos, su comparación real
// contra Logeo (hora de LOGIN/PRE-VIAJE) y primera asignación (hora del
// primer estado ASIGNADO posterior al logeo).
//
// IMPORTANTE: los Turnos suelen venir en un archivo con VARIAS semanas (cada
// operador aparece una vez por semana). El Logeo, en cambio, normalmente es
// de UN día puntual. Si comparáramos contra todas las semanas, la mayoría
// saldría "sin logeo" solo porque esa fila es de otra semana. Por eso, se
// detecta automáticamente la fecha real del logeo cargado y se usa SOLO la
// fila de Turno cuya semana (Fecha_inicio_semana/Fecha_fin_semana) contiene
// esa fecha.
function fechaLogeoDetectada() {
  for (const r of ingestas.logeo.registros) {
    const horaStr = buscarCampo(r, ['hora inicio', 'hora']);
    if (!horaStr) continue;
    const d = new Date(horaStr);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Devuelve, por operador+planta, UNA sola fila de Turno: la de la semana que
// contiene la fecha real del Logeo cargado (evita sumar/comparar contra
// varias semanas a la vez cuando el archivo de Turnos cubre un rango largo).
// La reutilizan tanto /api/reporte como /api/analisis-operadores para que
// ambos cuenten exactamente lo mismo.
function turnosDelDiaCorrespondiente() {
  const fechaRef = fechaLogeoDetectada();
  const turnosPorOperador = new Map(); // key = planta|id -> fila de turno elegida
  for (const r of ingestas.turnos.registros) {
    const planta = resolverPlantaCanonica(r);
    const id = idOperadorDeRegistro(r);
    if (!planta || !id) continue;
    const key = planta + '|' + id;

    const inicioSemana = buscarCampo(r, ['fecha_inicio_semana', 'fecha inicio semana']);
    const finSemana = buscarCampo(r, ['fecha_fin_semana', 'fecha fin semana']);
    let coincideSemana = true;
    if (fechaRef && inicioSemana && finSemana) {
      const ini = new Date(inicioSemana);
      const fin = new Date(finSemana);
      fin.setHours(23, 59, 59, 999);
      coincideSemana = fechaRef >= ini && fechaRef <= fin;
    }

    const existente = turnosPorOperador.get(key);
    if (coincideSemana) {
      if (!existente || !existente._coincideSemana) turnosPorOperador.set(key, { ...r, _coincideSemana: true });
    } else if (!existente) {
      turnosPorOperador.set(key, { ...r, _coincideSemana: false });
    }
  }
  return turnosPorOperador; // Map key -> fila
}

function construirAnalisisOperadores(nombrePlantaFiltro) {
  // 1) Una sola fila de turno por operador, ya filtrada a la semana correcta
  const turnosPorOperador = turnosDelDiaCorrespondiente();

  // 2) Agrupar logeo por operador (planta+id), ordenado cronológicamente
  const eventosPorOperador = new Map(); // key = planta|id -> [{minutos, estado}]
  for (const r of ingestas.logeo.registros) {
    const planta = resolverPlantaCanonica(r);
    const id = idOperadorDeRegistro(r);
    if (!planta || !id) continue;
    const horaStr = buscarCampo(r, ['hora inicio', 'hora']);
    const minutos = horaAMinutos(horaStr);
    if (minutos === null) continue;
    const estado = String(buscarCampo(r, ['descripcion estado', 'descripción estado', 'estado']) || '').toUpperCase();
    const key = planta + '|' + id;
    if (!eventosPorOperador.has(key)) eventosPorOperador.set(key, []);
    eventosPorOperador.get(key).push({ minutos, estado });
  }
  for (const eventos of eventosPorOperador.values()) eventos.sort((a, b) => a.minutos - b.minutos);

  function primerEvento(eventos, patron, desdeMinutos) {
    for (const e of eventos) {
      if (desdeMinutos !== undefined && e.minutos < desdeMinutos) continue;
      if (e.estado.includes(patron)) return e.minutos;
    }
    return null;
  }

  // 3) Recorrer la selección de un turno por operador (ya filtrada a la semana correcta)
  const operadores = [];
  for (const [key, r] of turnosPorOperador) {
    const planta = resolverPlantaCanonica(r);
    if (nombrePlantaFiltro && planta !== nombrePlantaFiltro) continue;
    const id = idOperadorDeRegistro(r);
    if (!planta || !id) continue;

    const nombre = nombreOperadorDeRegistro(r) || id;
    const horaTurnoStr = buscarCampo(r, ['hora ingreso', 'hora_ingreso', 'turno asignado']);
    const turnoMin = horaAMinutos(horaTurnoStr);

    const eventos = eventosPorOperador.get(key) || [];
    const logeoMin = primerEvento(eventos, 'LOGIN');
    const asignacionMin = logeoMin !== null ? primerEvento(eventos, 'ASIGNADO', logeoMin) : null;

    const atrasoTurnoMin = turnoMin !== null && logeoMin !== null ? logeoMin - turnoMin : null;
    const esperaAsignacionMin = logeoMin !== null && asignacionMin !== null ? asignacionMin - logeoMin : null;

    const planta_cfg = plantas.get(planta) || { tol_v: 5, tol_a: 15 };
    const puntualidad = clasificarPuntualidad(atrasoTurnoMin, planta_cfg);

    operadores.push({
      planta,
      id,
      nombre,
      turno: formatoHHMM(turnoMin),
      logeo: formatoHHMM(logeoMin),
      asignacion: formatoHHMM(asignacionMin),
      atrasoTurnoMin,
      esperaAsignacionMin,
      categoria: puntualidad.categoria,
      etiqueta: puntualidad.etiqueta,
    });
  }
  return operadores;
}

app.get('/api/analisis-operadores', authMiddleware, (req, res) => {
  const plantaFiltro = req.query.planta || null;
  if (plantaFiltro && !plantas.has(plantaFiltro)) {
    return res.status(404).json({ error: 'Planta no encontrada' });
  }
  const operadores = construirAnalisisOperadores(plantaFiltro);

  const conLogeo = operadores.filter((o) => o.logeo !== null);
  const sinLogeo = operadores.filter((o) => o.logeo === null);
  const atrasados = operadores.filter((o) => o.categoria === 'atraso_critico' || o.categoria === 'atraso_leve');
  const atrasadosCriticos = operadores.filter((o) => o.categoria === 'atraso_critico');
  const adelantados = operadores.filter((o) => o.categoria === 'adelantado');
  const conAsignacion = operadores.filter((o) => o.esperaAsignacionMin !== null);
  const logeadosSinAsignacion = conLogeo.filter((o) => o.esperaAsignacionMin === null);

  const promedio = (arr, campo) => (arr.length ? Math.round((arr.reduce((s, o) => s + o[campo], 0) / arr.length) * 10) / 10 : null);

  const resumen = {
    totalOperadores: operadores.length,
    conLogeo: conLogeo.length,
    sinLogeo: sinLogeo.length,
    adherenciaTurnoPct: operadores.length ? Math.round(((operadores.length - atrasados.length - sinLogeo.length) / operadores.length) * 1000) / 10 : null,
    atrasadosPct: operadores.length ? Math.round((atrasados.length / operadores.length) * 1000) / 10 : null,
    atrasadosCriticos: atrasadosCriticos.length,
    adelantadosPct: operadores.length ? Math.round((adelantados.length / operadores.length) * 1000) / 10 : null,
    logeadosSinAsignacion: logeadosSinAsignacion.length,
    esperaAsignacionPromedioMin: promedio(conAsignacion, 'esperaAsignacionMin'),
    atrasoPromedioMin: promedio(operadores.filter((o) => o.atrasoTurnoMin !== null), 'atrasoTurnoMin'),
  };

  // Diagnóstico automático (basado en reglas, no en un modelo externo) — mismo
  // espíritu que el motor de "Inteligencia operacional" del HTML original.
  let diagnostico = 'ESTABLE';
  if (resumen.totalOperadores > 0) {
    const coberturaPct = (resumen.conLogeo / resumen.totalOperadores) * 100;
    if (coberturaPct < 50 || resumen.atrasadosCriticos > resumen.totalOperadores * 0.2) diagnostico = 'CRÍTICO';
    else if (coberturaPct < 85 || resumen.atrasadosCriticos > 0) diagnostico = 'ATENCIÓN';
  }

  const diagnosticoLineas = [];
  if (sinLogeo.length) diagnosticoLineas.push(`${sinLogeo.length} operador(es) sin logeo registrado — validar ausencia, atraso extremo o falla de registro.`);
  if (logeadosSinAsignacion.length) diagnosticoLineas.push(`${logeadosSinAsignacion.length} operador(es) logeados sin asignación aún — revisar cola de despacho.`);
  if (atrasadosCriticos.length) diagnosticoLineas.push(`${atrasadosCriticos.length} operador(es) con atraso crítico respecto al turno.`);
  if (resumen.esperaAsignacionPromedioMin !== null) diagnosticoLineas.push(`Tiempo muerto promedio (logeo → asignación): ${resumen.esperaAsignacionPromedioMin} min.`);

  // Ranking de mayores desviaciones respecto al turno (para identificar operadores problemáticos)
  const ranking = [...operadores]
    .filter((o) => o.atrasoTurnoMin !== null)
    .sort((a, b) => Math.abs(b.atrasoTurnoMin) - Math.abs(a.atrasoTurnoMin))
    .slice(0, 15);

  // Ranking de TIEMPO MUERTO: operadores que más esperaron entre logeo y su
  // primera asignación (objetivo ≤30 min, igual umbral que el resto de la app).
  const UMBRAL_TIEMPO_MUERTO_OK = 30;
  const UMBRAL_TIEMPO_MUERTO_ATENCION = 60;
  function clasificarTiempoMuerto(min) {
    if (min === null) return 'sin_dato';
    if (min <= UMBRAL_TIEMPO_MUERTO_OK) return 'ok';
    if (min <= UMBRAL_TIEMPO_MUERTO_ATENCION) return 'atencion';
    return 'critico';
  }
  const rankingTiempoMuerto = [...operadores]
    .filter((o) => o.esperaAsignacionMin !== null)
    .map((o) => ({ ...o, tiempoMuertoCategoria: clasificarTiempoMuerto(o.esperaAsignacionMin) }))
    .sort((a, b) => b.esperaAsignacionMin - a.esperaAsignacionMin)
    .slice(0, 15);
  const logeadosEsperandoAhora = conLogeo.filter((o) => o.esperaAsignacionMin === null); // logeados, aún sin asignar (tiempo muerto en curso)

  res.json({
    planta: plantaFiltro,
    resumen,
    diagnostico,
    diagnosticoLineas,
    ranking,
    rankingTiempoMuerto,
    logeadosEsperandoAhora: logeadosEsperandoAhora.length,
    operadores,
  });
});

app.get('/api/reporte', authMiddleware, (req, res) => {

  const zonaFiltro = req.query.zona || null;
  const nombresPlantas = [...plantas.keys()].filter((n) => !zonaFiltro || plantas.get(n).zona === zonaFiltro);

  // --- Turnos y Logeo: se calculan a partir del mismo análisis por operador
  // que usa /api/analisis-operadores (deduplicado a la semana correcta, y
  // contando OPERADORES ÚNICOS con logeo, no cada evento crudo de estado). ---
  const operadoresNacional = construirAnalisisOperadores(null).filter((o) => nombresPlantas.includes(o.planta));
  const turnosPorPlantaOp = {}; // conteo de operadores exigibles por planta
  const conLogeoPorPlanta = {}; // conteo de operadores con logeo por planta
  const esperasPorPlanta = {}; // arreglo de esperaAsignacionMin por planta (para promedio de tiempo muerto)
  for (const nombre of nombresPlantas) { turnosPorPlantaOp[nombre] = 0; conLogeoPorPlanta[nombre] = 0; esperasPorPlanta[nombre] = []; }
  for (const o of operadoresNacional) {
    if (!turnosPorPlantaOp.hasOwnProperty(o.planta)) continue;
    turnosPorPlantaOp[o.planta]++;
    if (o.logeo !== null) conLogeoPorPlanta[o.planta]++;
    if (o.esperaAsignacionMin !== null) esperasPorPlanta[o.planta].push(o.esperaAsignacionMin);
  }
  const promedioArr = (arr) => (arr.length ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);

  // --- Citaciones: siguen siendo conteo de filas (son registros de despacho/
  // carga programada, no turnos de operador, así que no se deduplican igual). ---
  function contarFilasPorPlanta(tipo) {
    const conteo = {};
    for (const nombre of nombresPlantas) conteo[nombre] = 0;
    let sinPlantaReconocida = 0;
    for (const r of ingestas[tipo].registros) {
      const match = resolverPlantaCanonica(r);
      if (zonaFiltro && match && plantas.get(match)?.zona !== zonaFiltro) continue;
      if (match && conteo.hasOwnProperty(match)) conteo[match]++;
      else sinPlantaReconocida++;
    }
    return { conteo, sinPlantaReconocida };
  }
  const citacionesPorPlanta = contarFilasPorPlanta('citaciones');
  // sinPlantaReconocida de logeo/turnos ahora se mide a nivel de operador, no de fila cruda:
  const logeoFilasCrudas = contarFilasPorPlanta('logeo'); // solo para el conteo de filas sin homologar

  const filasPlanta = nombresPlantas.map((nombre) => {
    const turnos = turnosPorPlantaOp[nombre] || 0;
    const citaciones = citacionesPorPlanta.conteo[nombre] || 0;
    const logeo = conLogeoPorPlanta[nombre] || 0;
    const adherenciaLogeo = turnos > 0 ? Math.round((logeo / turnos) * 1000) / 10 : null;
    const adherenciaCitacion =
      plantas.get(nombre).citacion === 'si' && turnos > 0 ? Math.round((citaciones / turnos) * 1000) / 10 : null;
    const tiempoMuertoPromedioMin = promedioArr(esperasPorPlanta[nombre]);
    return { planta: nombre, zona: plantas.get(nombre).zona, turnos, citaciones, logeo, adherenciaLogeo, adherenciaCitacion, tiempoMuertoPromedioMin };
  });

  const totalTurnos = operadoresNacional.length; // operadores exigibles hoy (deduplicado), no filas crudas
  const totalCitaciones = zonaFiltro
    ? Object.values(citacionesPorPlanta.conteo).reduce((s, v) => s + v, 0)
    : ingestas.citaciones.registros.length;
  const totalLogeo = operadoresNacional.filter((o) => o.logeo !== null).length; // operadores con logeo, no eventos crudos
  const tiempoMuertoPromedioNacionalMin = promedioArr(operadoresNacional.filter((o) => o.esperaAsignacionMin !== null).map((o) => o.esperaAsignacionMin));
  const plantasTiempoMuertoAlto = filasPlanta.filter((f) => f.tiempoMuertoPromedioMin !== null && f.tiempoMuertoPromedioMin > 30);

  const plantasSinDatos = filasPlanta.filter((f) => f.turnos === 0).map((f) => f.planta);
  const plantasBajaAdherencia = filasPlanta.filter((f) => f.adherenciaLogeo !== null && f.adherenciaLogeo < 90);

  // Narrativa automática breve, en español, estilo ejecutivo
  const lineas = [];
  const fecha = new Date().toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' });
  lineas.push(`Reporte ejecutivo CCO — generado ${fecha} por ${req.user.nombre}.`);
  lineas.push(
    `Datos cargados: ${totalTurnos} operadores exigibles (turno correspondiente al día del logeo), ${totalCitaciones} citaciones, ${totalLogeo} operadores con logeo registrado, sobre ${nombresPlantas.length} plantas configuradas.`
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
  if (tiempoMuertoPromedioNacionalMin !== null) {
    lineas.push(`Tiempo muerto promedio (logeo → asignación): ${tiempoMuertoPromedioNacionalMin} min (objetivo ≤ 30 min).`);
  }
  if (plantasTiempoMuertoAlto.length) {
    lineas.push(
      `Tiempo muerto sobre 30 min: ${plantasTiempoMuertoAlto.map((f) => `${f.planta} (${f.tiempoMuertoPromedioMin} min)`).join(', ')}.`
    );
  }
  const totalSinReconocer = citacionesPorPlanta.sinPlantaReconocida + logeoFilasCrudas.sinPlantaReconocida;
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
    zona: zonaFiltro,
    resumen: {
      totalTurnos,
      totalCitaciones,
      totalLogeo,
      totalPlantas: nombresPlantas.length,
      filasSinReconocer: totalSinReconocer,
      tiempoMuertoPromedioMin: tiempoMuertoPromedioNacionalMin,
    },
    porPlanta: filasPlanta,
    narrativa: lineas,
  });
});

server.listen(PORT, () => {
  console.log(`CCO backend (memoria) escuchando en el puerto ${PORT}`);
});
