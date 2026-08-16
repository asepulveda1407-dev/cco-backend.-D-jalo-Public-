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
  ['Minera Escondida', 'Norte', 'Antofagasta', ['1B']],
  ['Antofagasta', 'Norte', 'Antofagasta', ['1C']],
  ['Calama', 'Norte', 'Antofagasta', ['1D']],
  ['Diego de Almagro', 'Norte', 'Atacama', ['1J']],
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

// Registro de anomalías de datos detectadas durante el cálculo — para que un
// valor raro (como una hora de turno imposible) sea diagnosticable en segundos
// vía /api/diagnostico en vez de tener que reconstruir el caso a mano. Se
// limpia en cada llamada a construirAnalisisOperadores() para reflejar solo
// la última corrida.
let advertenciasDato = [];
function registrarAdvertenciaDato(campo, operadorId, operadorNombre, planta, motivo, valorCrudo) {
  advertenciasDato.push({
    campo, operadorId, operadorNombre, planta, motivo,
    valorCrudo: valorCrudo === undefined ? null : valorCrudo,
    ts: new Date().toISOString(),
  });
}

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
function buscarCampo(registro, candidatos, soloExacto) {
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
  if (soloExacto) return null;
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
// planta directo, código de planta (vía tabla de alias), o el formato "CÓDIGO - Nombre"
// (ej. "1W - Planta Concepcionhualpen", como trae el archivo de Citación_Operadores).
// Usa coincidencia EXACTA tras normalizar (no "contiene"), para evitar falsos positivos
// como "ARICA" calzando dentro de "VILLARICA".
function resolverPlantaCanonica(registro) {
  const nombresCanonicosNorm = new Map([...plantas.keys()].map((n) => [normalizarNombre(n), n]));

  const candidatoNombre = buscarCampo(registro, ['planta', 'plant', 'nombre planta', 'sitio', 'descripcion planta', 'descripción planta']);
  if (candidatoNombre) {
    const bruto = String(candidatoNombre).trim();
    const norm = normalizarNombre(bruto);
    if (nombresCanonicosNorm.has(norm)) return nombresCanonicosNorm.get(norm);
    const porCodigo = ALIAS_CODIGO_PLANTA[bruto.toUpperCase()];
    if (porCodigo) return porCodigo;
    // Formato "CÓDIGO - Nombre" (ej. "1W - Planta Concepcionhualpen"): probar solo el código
    const matchCodigoPrefijo = bruto.match(/^([A-Za-z0-9]{1,4})\s*-/);
    if (matchCodigoPrefijo) {
      const porCodigoPrefijo = ALIAS_CODIGO_PLANTA[matchCodigoPrefijo[1].toUpperCase()];
      if (porCodigoPrefijo) return porCodigoPrefijo;
    }
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
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================================
// CACHE: Leer index.html UNA SOLA VEZ al iniciar el servidor
// ============================================================================
let indexHtmlCache = null;

function cargarIndexHtml() {
  try {
    // Intentar múltiples rutas posibles
    const posiblesRutas = [
      path.join(__dirname, 'index.html'),
      path.join(process.cwd(), 'index.html'),
      '/app/index.html',
      './index.html'
    ];
    
    for (const ruta of posiblesRutas) {
      try {
        if (fs.existsSync(ruta)) {
          console.log(`✅ Encontrado index.html en: ${ruta}`);
          indexHtmlCache = fs.readFileSync(ruta, 'utf8');
          return indexHtmlCache;
        }
      } catch (e) {
        // Continuar con la siguiente ruta
      }
    }
    
    console.error('❌ No se encontró index.html en ninguna ruta conocida');
    return null;
  } catch (err) {
    console.error('Error al leer index.html:', err.message);
    return null;
  }
}

// ============================================================================
// RUTA RAÍZ: Servir index.html desde cache
// ============================================================================
app.get('/', (req, res) => {
  if (!indexHtmlCache) {
    // Intentar cargar nuevamente si no está en cache
    indexHtmlCache = cargarIndexHtml();
  }
  
  if (indexHtmlCache) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtmlCache);
  } else {
    res.status(500).send('Error: No se pudo cargar index.html');
  }
});

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

const VERSION_BACKEND = '2026-08-14-v10-nota-citaciones-vs-turnos';
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: VERSION_BACKEND }));

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

app.get('/api/plantas', (req, res) => {
  res.json([...plantas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)));
});

app.put('/api/plantas/:nombre/config', (req, res) => {
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

app.get('/api/bitacora', (req, res) => {
  res.json(bitacora.slice(0, 200));
});

app.post('/api/bitacora', (req, res) => {
  const { planta, tipo, detalle, operador_id, operador_nombre, fecha_hora } = req.body;
  if (!planta || !tipo || !detalle) return res.status(400).json({ error: 'planta, tipo y detalle son requeridos' });

  const registro = {
    id: nextBitacoraId++,
    fecha_hora: fecha_hora || new Date().toISOString(),
    usuario: req.user.nombre,
    rol: req.user.rol,
    planta,
    tipo,
    operador_id: operador_id || null,
    operador_nombre: operador_nombre || null,
    detalle,
    creado_en: new Date().toISOString(),
  };
  bitacora.unshift(registro);

  registrarAuditoria({ usuario: req.user.nombre, entidad: 'bitacora', entidad_id: registro.id, accion: 'insert', anterior: null, nuevo: registro });

  broadcast('nacional', 'bitacora:nueva', registro);
  broadcast('planta:' + planta, 'bitacora:nueva', registro);

  res.status(201).json(registro);
});

// Lista liviana de operadores de una planta (para el selector de la Bitácora),
// tomada de la misma fuente que Análisis de operadores (Turnos, semana correcta).
app.get('/api/operadores', (req, res) => {
  const plantaFiltro = req.query.planta || null;
  if (!plantaFiltro || !plantas.has(plantaFiltro)) {
    return res.status(400).json({ error: 'Debes indicar una planta válida (?planta=...)' });
  }
  const operadores = construirAnalisisOperadores(plantaFiltro).map((o) => ({ id: o.id, nombre: o.nombre }));
  operadores.sort((a, b) => a.nombre.localeCompare(b.nombre));
  res.json(operadores);
});

app.get('/api/auditoria', (req, res) => {
  if (!puedeEditarConfigGlobal(req.user)) return res.status(403).json({ error: 'Sin permiso' });
  res.json(auditoria.slice(0, 100));
});

// ---------------------------------------------------------------------------
// 5. Ingesta de datos (Turnos / Citaciones / Logeo) — recibe filas ya parseadas
//    en el navegador desde el Excel (SheetJS), no el archivo binario. Esto evita
//    tener que procesar XLSX en el servidor.
// ---------------------------------------------------------------------------

const TIPOS_INGESTA = ['turnos', 'citaciones', 'logeo'];

app.post('/api/ingesta', (req, res) => {
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
app.get('/api/ingesta/estado', (req, res) => {
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
// 6.5 Análisis de operadores: compara Turno (hora programada) vs Logeo real vs
//     Primera asignación real, detectando atrasos/adelantos en minutos.
//     Basado en la máquina de estados real de Logeo: LOGIN/PRE-VIAJE (inicio
//     de turno) -> ... -> ASIGNADO (primera asignación de carga).
// ---------------------------------------------------------------------------

// Convierte una hora en cualquier formato común a minutos desde medianoche.
// Devuelve null si no se pudo.
//
// FIX (2026-08-14, v9) — bug de zona horaria que producía horas fantasma
// (ej. Juan Diaz / ID 1004315, turno real 08:00 mostrado como 12:42):
//
// ANTES: cuando el valor llegaba como Date o como string con fecha+hora
// ("YYYY-MM-DD HH:MM..."), se hacía `new Date(valor)` y se leía la hora con
// `getUTCHours()/getUTCMinutes()`. El problema es que SheetJS, al leer una
// celda Excel de tipo "hora pura" (ej. 08:00, sin fecha), genera un Date en
// hora LOCAL del navegador del usuario (America/Santiago, UTC-3/UTC-4), pero
// al serializarse a JSON con .toISOString() ese Date se convierte a UTC. El
// backend en Render corre en UTC, así que técnicamente "coincide" — PERO si
// en cualquier punto de la cadena (navegador del usuario, o el propio SheetJS
// con cellDates+UTC) la hora ya se generó pensando que la celda estaba en UTC
// en vez de hora local, se termina sumando o restando el offset de Chile una
// vez de más o de menos. Resultado: una hora que no es ninguna de las dos
// versiones "razonables" (ni la local ni la UTC cruda), sino una tercera
// hora corrida por el offset — exactamente el síntoma reportado (08:00 real
// mostrado como 12:42, un desfase de +4:42 que no corresponde a ningún
// offset estándar de Chile, lo cual indica un doble ajuste de zona horaria
// en la cadena SheetJS -> JSON -> Node).
//
// AHORA: se elimina por completo la dependencia de Date/UTC para extraer la
// hora. Se prioriza SIEMPRE la extracción directa de dígitos "HH:MM" desde
// el string, sin pasar nunca por conversión de zona horaria. Si el valor es
// un objeto Date, se leen sus componentes en hora LOCAL del proceso (no UTC)
// como fallback explícito, pero solo como último recurso — nunca como
// primera opción — porque un objeto Date para una hora "pura" no tiene una
// interpretación de zona horaria correcta y objetivamente única.
function horaAMinutos(valor) {
  if (valor === null || valor === undefined || valor === '') return null;

  // 1) PRIORIDAD MÁXIMA: extraer "HH:MM" directamente del string, sin pasar
  //    nunca por Date/UTC. Cubre "08:00", "08:00:00", y también strings con
  //    fecha+hora tipo "1899-12-30T08:00:00.000Z" o "2026-08-10 08:00:00"
  //    (se toma el componente de hora tal cual está escrito, sin reinterpretar
  //    zona horaria).
  const texto = String(valor).trim();

  // "HH:MM" o "HH:MM:SS" puro (con o sin fecha adelante)
  const matchConFecha = texto.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z)?$/);
  if (matchConFecha) {
    const h = parseInt(matchConFecha[1], 10);
    const mi = parseInt(matchConFecha[2], 10);
    if (h >= 0 && h < 24 && mi >= 0 && mi < 60) return h * 60 + mi;
  }

  // 2) Fallback: objeto Date real (poco común tras JSON.stringify, pero se
  //    contempla por si el registro llega sin serializar). Se usan los
  //    componentes LOCALES del proceso, no UTC — el proceso en Render corre
  //    en UTC por defecto, así que esto es equivalente a UTC ahí, pero deja
  //    de forzar una interpretación UTC si el proceso corriera en otra TZ.
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return valor.getHours() * 60 + valor.getMinutes();
  }

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
      // OJO: fin.setHours() opera en hora LOCAL del proceso Node, mientras
      // que fechaRef e ini/fin vienen de strings ISO en UTC. En un servidor
      // que corre en UTC (típico en Render), esto coincide por casualidad,
      // pero es frágil: se reemplaza por una construcción explícita en UTC
      // para que el límite de fin de semana (23:59:59) sea siempre correcto
      // sin depender de en qué zona horaria esté configurado el proceso.
      fin.setUTCHours(23, 59, 59, 999);
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
  advertenciasDato = []; // se reinicia en cada corrida, refleja solo esta ejecución
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

  // 2.5) Citación por operador — SOLO disponible si el archivo de Citaciones
  // cargado trae columna de ID de operador (formato "Citación_Operadores": ID
  // Operador + Citación sugerida). El formato antiguo de despachos/pedidos no
  // tiene esta columna, así que para esos casos simplemente no hay dato.
  // IMPORTANTE: se busca EXCLUSIVAMENTE la columna "Citación sugerida", en modo
  // estricto (sin coincidencia parcial), para no confundirla nunca con otras
  // columnas de hora que trae el mismo archivo (ej. "Logeo Tablet", "Inicio
  // primera carga", "Hora solicitada primera obra").
  const citacionPorOperador = new Map(); // key = planta|id -> minutos
  for (const r of ingestas.citaciones.registros) {
    const id = idOperadorDeRegistro(r);
    if (!id) continue; // este archivo no trae ID de operador, se omite
    const planta = resolverPlantaCanonica(r);
    if (!planta) continue;
    const horaStr = buscarCampo(r, ['citacion sugerida', 'citación sugerida'], true);
    const minutos = horaAMinutos(horaStr);
    if (minutos === null) continue;
    citacionPorOperador.set(planta + '|' + id, minutos);
  }

  // 3) Recorrer la selección de un turno por operador (ya filtrada a la semana correcta)
  const operadores = [];
  for (const [key, r] of turnosPorOperador) {
    const planta = resolverPlantaCanonica(r);
    if (nombrePlantaFiltro && planta !== nombrePlantaFiltro) continue;
    const id = idOperadorDeRegistro(r);
    if (!planta || !id) continue;

    const nombre = nombreOperadorDeRegistro(r) || id;
    // IMPORTANTE: el candidato de búsqueda es EXCLUSIVAMENTE columnas de hora
    // real (Hora_ingreso). Antes se incluía 'turno asignado' como fallback,
    // pero esa columna (Turno_asignado) contiene códigos de turno tipo "A-6",
    // no una hora — mezclar ambos conceptos es un bug de diseño que puede
    // producir horas corruptas o basura silenciosa. Se elimina el fallback.
    const horaTurnoStr = buscarCampo(r, ['hora ingreso', 'hora_ingreso'], true);
    const turnoMin = horaAMinutos(horaTurnoStr);
    if (horaTurnoStr !== null && turnoMin === null) {
      // Se encontró un valor en la columna de hora de turno, pero no se pudo
      // convertir a una hora válida. Se registra para diagnóstico en vez de
      // fallar en silencio (antes esto simplemente devolvía turno: null sin
      // dejar rastro de por qué).
      registrarAdvertenciaDato('turno', id, nombre, planta, 'Hora_ingreso no convertible', horaTurnoStr);
    }
    // Validación de rango operativo: los turnos de la operación real van de
    // 07:00 a 11:00 (ventana confirmada por Alberto). Un turno fuera de ese
    // rango casi seguro es un dato corrupto o mal leído del Excel — se marca
    // como sospechoso en vez de mostrarse como si fuera un valor normal, para
    // que la anomalía sea visible en /api/diagnostico en lugar de aparecer
    // silenciosamente en una tabla como si fuera un turno legítimo.
    const RANGO_TURNO_MIN = 7 * 60;   // 07:00
    const RANGO_TURNO_MAX = 11 * 60;  // 11:00
    if (turnoMin !== null && (turnoMin < RANGO_TURNO_MIN || turnoMin > RANGO_TURNO_MAX)) {
      registrarAdvertenciaDato('turno', id, nombre, planta,
        `Hora de turno fuera del rango operativo (07:00-11:00): ${formatoHHMM(turnoMin)}`, horaTurnoStr);
    }

    const eventos = eventosPorOperador.get(key) || [];
    const logeoMin = primerEvento(eventos, 'LOGIN');
    const asignacionMin = logeoMin !== null ? primerEvento(eventos, 'ASIGNADO', logeoMin) : null;
    // La hora de citación solo se muestra/considera si la planta tiene el
    // flag "citacion" en 'si' (configurable en Ajustes → Plantas). Si está
    // en 'no' (como Divisa Central Mix, La Divisa Oriente/Poniente, Lo
    // Espejo, Melipilla en la config actual de RM), la citación nunca se usa
    // aunque el archivo de Citaciones traiga datos para esa planta — sale
    // siempre null/"—", tal como pide Alberto.
    const plantaUsaCitacion = plantas.get(planta)?.citacion === 'si';
    const citacionMin = plantaUsaCitacion && citacionPorOperador.has(key) ? citacionPorOperador.get(key) : null;

    const atrasoTurnoMin = turnoMin !== null && logeoMin !== null ? logeoMin - turnoMin : null;
    const esperaAsignacionMin = logeoMin !== null && asignacionMin !== null ? asignacionMin - logeoMin : null;

    const planta_cfg = plantas.get(planta) || { tol_v: 5, tol_a: 15 };
    const puntualidad = clasificarPuntualidad(atrasoTurnoMin, planta_cfg);

    operadores.push({
      planta,
      id,
      nombre,
      turno: formatoHHMM(turnoMin),
      citacion: formatoHHMM(citacionMin),
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

app.get('/api/analisis-operadores', (req, res) => {
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

// ---------------------------------------------------------------------------
// 6.55 Diagnóstico de calidad de datos — expone las anomalías detectadas
//      durante el último cálculo (turnos fuera del rango operativo 07:00-11:00,
//      valores de hora no convertibles, etc). Existe para poder responder en
//      segundos "¿de dónde salió este valor raro?" mostrando el valor CRUDO
//      exacto tal como llegó del Excel, en vez de tener que reconstruir el
//      caso a mano cada vez que aparece un dato que no cuadra.
// ---------------------------------------------------------------------------
app.get('/api/diagnostico', (req, res) => {
  // Fuerza un recálculo para asegurar que advertenciasDato refleje el estado
  // actual de las 3 ingestas, no una corrida anterior desactualizada.
  construirAnalisisOperadores(null);
  res.json({
    generado_en: new Date().toISOString(),
    totalAdvertencias: advertenciasDato.length,
    advertencias: advertenciasDato,
    fechaLogeoUsadaComoReferencia: fechaLogeoDetectada(),
    ingestasCargadas: {
      turnos: { cantidad: ingestas.turnos.registros.length, archivo: ingestas.turnos.archivo, subido_en: ingestas.turnos.subido_en },
      citaciones: { cantidad: ingestas.citaciones.registros.length, archivo: ingestas.citaciones.archivo, subido_en: ingestas.citaciones.subido_en },
      logeo: { cantidad: ingestas.logeo.registros.length, archivo: ingestas.logeo.archivo, subido_en: ingestas.logeo.subido_en },
    },
  });
});

// ---------------------------------------------------------------------------
// 6.6 Tabla completa de operadores para el Reporte Ejecutivo — mismas columnas
//     que exige Alberto: id, nombre, planta, hora turno, hora citación, hora
//     logeo, hora asignación, tiempo muerto, atraso/adelanto. Es la misma data
//     de construirAnalisisOperadores(), solo expuesta completa (no Top 10) y
//     ordenable, para que el reporte pueda mostrar la tabla íntegra si se pide.
// ---------------------------------------------------------------------------
app.get('/api/tabla-operadores', (req, res) => {
  const zonaFiltro = req.query.zona || null;
  const plantaFiltro = req.query.planta || null;
  const ordenarPor = req.query.orden || 'planta'; // planta | atraso | tiempoMuerto | nombre
  const soloProblemas = req.query.soloProblemas === '1'; // si true: excluye "a_tiempo"

  if (plantaFiltro && !plantas.has(plantaFiltro)) return res.status(404).json({ error: 'Planta no encontrada' });

  let operadores = construirAnalisisOperadores(plantaFiltro);

  if (zonaFiltro) operadores = operadores.filter((o) => plantas.get(o.planta)?.zona === zonaFiltro);
  if (soloProblemas) operadores = operadores.filter((o) => o.categoria !== 'a_tiempo');

  operadores = operadores.map((o) => ({
    id: o.id,
    nombre: o.nombre,
    planta: o.planta,
    zona: plantas.get(o.planta)?.zona || null,
    horaTurno: o.turno,
    // Bandera para el frontend: turno fuera del rango operativo real
    // (07:00-11:00). Permite resaltar la fila en rojo aunque el resto del
    // cálculo (atraso/adelanto) haya salido "normal" — un turno imposible
    // invalida esa fila entera y no debe pasar desapercibido en la tabla.
    horaTurnoSospechosa: o.turno !== null && (() => {
      const [h, m] = o.turno.split(':').map(Number);
      const min = h * 60 + m;
      return min < 7 * 60 || min > 11 * 60;
    })(),
    horaCitacion: o.citacion,
    horaLogeo: o.logeo,
    horaAsignacion: o.asignacion,
    tiempoMuertoMin: o.esperaAsignacionMin,
    desviacionMin: o.atrasoTurnoMin, // negativo = adelantado, positivo = atrasado
    estado: o.etiqueta,
    categoria: o.categoria,
  }));

  const comparadores = {
    planta: (a, b) => a.planta.localeCompare(b.planta) || a.nombre.localeCompare(b.nombre),
    nombre: (a, b) => a.nombre.localeCompare(b.nombre),
    atraso: (a, b) => (b.desviacionMin ?? -9999) - (a.desviacionMin ?? -9999),
    tiempoMuerto: (a, b) => (b.tiempoMuertoMin ?? -1) - (a.tiempoMuertoMin ?? -1),
  };
  operadores.sort(comparadores[ordenarPor] || comparadores.planta);

  res.json({
    zona: zonaFiltro,
    planta: plantaFiltro,
    total: operadores.length,
    operadores,
  });
});

app.get('/api/reporte', (req, res) => {
  try {
    const zonaFiltro = req.query.zona || null;
    const plantasFiltro = req.query.plantas ? req.query.plantas.split(',').filter(Boolean) : null;
    const nombresPlantas = [...plantas.keys()].filter(
      (n) => (!zonaFiltro || plantas.get(n).zona === zonaFiltro) && (!plantasFiltro || plantasFiltro.includes(n))
    );

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

  // --- KPIs nacionales exclusivos: Adelantamiento al turno y Tiempo muerto ---
  // (dentro del alcance de zona/plantas filtradas, no todo el país siempre)
  const adelantadosNacional = operadoresNacional.filter((o) => o.categoria === 'adelantado');
  const adelantadosPctNacional = operadoresNacional.length
    ? Math.round((adelantadosNacional.length / operadoresNacional.length) * 1000) / 10
    : null;

  // Ranking nacional de mayor ADELANTO (para Operaciones: quiénes llegan más
  // temprano de lo esperado, útil para replanificar turnos/citaciones).
  // "citacionHora" viene poblado SOLO si el archivo de Citaciones cargado trae
  // columna de ID de operador (formato "Citación_Operadores"). El formato
  // antiguo de despachos/pedidos por planta no la tiene, y queda en null.
  const rankingAdelantados = [...adelantadosNacional]
    .sort((a, b) => a.atrasoTurnoMin - b.atrasoTurnoMin) // más negativo primero = más adelanto
    .slice(0, 10)
    .map((o) => ({
      id: o.id,
      nombre: o.nombre,
      planta: o.planta,
      turno: o.turno,
      citacionHora: o.citacion,
      logeo: o.logeo,
      asignacion: o.asignacion,
      adelantoMin: Math.abs(o.atrasoTurnoMin),
    }));

  // Ranking nacional de mayor TIEMPO MUERTO (para Despacho: dónde se pierden
  // más minutos entre que el operador logea y recibe su primera carga)
  const rankingTiempoMuertoNacional = operadoresNacional
    .filter((o) => o.esperaAsignacionMin !== null)
    .sort((a, b) => b.esperaAsignacionMin - a.esperaAsignacionMin)
    .slice(0, 10)
    .map((o) => ({
      id: o.id,
      nombre: o.nombre,
      planta: o.planta,
      turno: o.turno,
      citacionHora: o.citacion,
      logeo: o.logeo,
      asignacion: o.asignacion,
      esperaMin: o.esperaAsignacionMin,
    }));

  // --- Citaciones: SOLO contar si la planta está configurada con citacion: 'si' ---
  // Esto asegura que no se contaminen totales con plantas que NO usan citaciones.
  // Cualquier citación de planta con citacion: 'no' se EXCLUYE completamente.
  function contarFilasPorPlanta(tipo) {
    const conteo = {};
    for (const nombre of nombresPlantas) conteo[nombre] = 0;
    let sinPlantaVacia = 0;
    let sinPlantaCodigoDesconocido = 0;
    let excluidosPorCitacionNo = 0; // NEW: contador de registros excluidos por citacion='no'
    
    for (const r of ingestas[tipo].registros) {
      const crudo = buscarCampo(r, ['planta', 'plant', 'nombre planta', 'sitio', 'descripcion planta', 'numero planta', 'número planta']);
      const match = resolverPlantaCanonica(r);
      
      if (zonaFiltro && match && plantas.get(match)?.zona !== zonaFiltro) continue;
      
      // NEW: Si es el tipo 'citaciones', validar que la planta tenga citacion='si'
      // Si no, EXCLUIR completamente (no contar en ningún lado)
      if (tipo === 'citaciones' && match && plantas.get(match)?.citacion !== 'si') {
        excluidosPorCitacionNo++;
        continue; // EXCLUIR este registro completamente
      }
      
      if (match && conteo.hasOwnProperty(match)) {
        conteo[match]++;
      } else if (!crudo || String(crudo).trim() === '') {
        sinPlantaVacia++;
      } else {
        sinPlantaCodigoDesconocido++;
      }
    }
    return { 
      conteo, 
      sinPlantaVacia, 
      sinPlantaCodigoDesconocido, 
      sinPlantaReconocida: sinPlantaVacia + sinPlantaCodigoDesconocido,
      excluidosPorCitacionNo, // NEW: información de registros excluidos
    };
  }
  const citacionesPorPlanta = contarFilasPorPlanta('citaciones');
  // sinPlantaReconocida de logeo/turnos ahora se mide a nivel de operador, no de fila cruda:
  const logeoFilasCrudas = contarFilasPorPlanta('logeo'); // solo para el conteo de filas sin homologar

  // --- Citados sin turno base: operadores que aparecen en Citaciones (con ID
  // de operador, formato "Citación_Operadores") pero NO están en la selección
  // de Turnos de la semana correspondiente. Esto explica el caso normal donde
  // totalCitaciones > totalTurnos (refuerzos, préstamos entre plantas, cambios
  // de última hora) para que no se lea como un error de conteo en el reporte.
  const idsOperadoresTurnos = new Set(operadoresNacional.map((o) => o.planta + '|' + o.id));
  const idsOperadoresCitados = new Set();
  for (const r of ingestas.citaciones.registros) {
    const id = idOperadorDeRegistro(r);
    if (!id) continue; // archivo sin columna de ID de operador (formato antiguo), no se puede cruzar
    const planta = resolverPlantaCanonica(r);
    if (!planta || !nombresPlantas.includes(planta)) continue;
    idsOperadoresCitados.add(planta + '|' + id);
  }
  const citadosSinTurnoBase = [...idsOperadoresCitados].filter((key) => !idsOperadoresTurnos.has(key));

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
  // OJO: totalCitaciones ahora es la SUMA de lo que aparece en la tabla por planta
  // (antes mostraba el total crudo del archivo, que incluía filas sin planta
  // reconocible, y por eso no cuadraba con la suma de la tabla).
  const totalCitaciones = Object.values(citacionesPorPlanta.conteo).reduce((s, v) => s + v, 0);
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
  // Aclaración cuando Citaciones > Turnos: no es un error de conteo, son dos
  // universos distintos (operadores citados hoy vs. operadores programados en
  // la semana base). Se explica solo cuando aplica, para no ensuciar el
  // reporte en el caso normal donde ambos números son coherentes entre sí.
  if (citadosSinTurnoBase.length > 0) {
    lineas.push(
      `Nota: ${citadosSinTurnoBase.length} operador(es) con citación no figuran en la programación base de Turnos de la semana — posible refuerzo, préstamo entre plantas o cambio de última hora. Citaciones y Turnos miden universos distintos (citados del día vs. programados de la semana), por lo que Citaciones puede superar a Turnos sin ser un error de datos.`
    );
  }
  if (plantasTiempoMuertoAlto.length) {
    lineas.push(
      `Tiempo muerto sobre 30 min: ${plantasTiempoMuertoAlto.map((f) => `${f.planta} (${f.tiempoMuertoPromedioMin} min)`).join(', ')}.`
    );
  }
  const sinPlantaVaciaTotal = citacionesPorPlanta.sinPlantaVacia + logeoFilasCrudas.sinPlantaVacia;
  const sinPlantaCodigoTotal = citacionesPorPlanta.sinPlantaCodigoDesconocido + logeoFilasCrudas.sinPlantaCodigoDesconocido;
  const totalSinReconocer = sinPlantaVaciaTotal + sinPlantaCodigoTotal;
  if (totalSinReconocer > 0) {
    const detalle = [];
    if (sinPlantaVaciaTotal) detalle.push(`${sinPlantaVaciaTotal} con el campo planta vacío (ej. pedidos anulados)`);
    if (sinPlantaCodigoTotal) detalle.push(`${sinPlantaCodigoTotal} con un código de planta desconocido (nunca visto en Logeo, sin nombre posible)`);
    lineas.push(`Atención: ${totalSinReconocer} filas de Citaciones/Logeo no se pudieron cruzar a ninguna planta — ${detalle.join(' y ')}.`);
  }
  // NEW: Alerta de exclusión por citacion='no'
  if (citacionesPorPlanta.excluidosPorCitacionNo > 0) {
    lineas.push(`⚠️ EXCLUSIÓN: ${citacionesPorPlanta.excluidosPorCitacionNo} registros de Citaciones fueron EXCLUIDOS porque sus plantas NO tienen citación habilitada (citacion='no'). Estos registros NO aparecen en ningún total ni indicador.`);
  }
  if (bitacora.length) {
    lineas.push(`Eventos registrados en bitácora en este período: ${bitacora.length}.`);
  }

  res.json({
    generado_en: new Date().toISOString(),
    generado_por: req.user.nombre,
    zona: zonaFiltro,
    plantasFiltro,
    resumen: {
      totalTurnos,
      totalCitaciones,
      totalLogeo,
      totalPlantas: nombresPlantas.length,
      filasSinReconocer: totalSinReconocer,
      filasSinReconocerDetalle: { plantaVacia: sinPlantaVaciaTotal, codigoDesconocido: sinPlantaCodigoTotal },
      tiempoMuertoPromedioMin: tiempoMuertoPromedioNacionalMin,
      adelantadosPct: adelantadosPctNacional,
      adelantadosCantidad: adelantadosNacional.length,
      citadosSinTurnoBaseCantidad: citadosSinTurnoBase.length,
    },
    porPlanta: filasPlanta,
    narrativa: lineas,
    rankingAdelantados,
    rankingTiempoMuertoNacional,
  });
  } catch (err) {
    console.error('Error en /api/reporte:', err.message, err.stack);
    res.status(500).json({ error: 'Error al generar el reporte: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`CCO backend (memoria) escuchando en el puerto ${PORT}`);
});
