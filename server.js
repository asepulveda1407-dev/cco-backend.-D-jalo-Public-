const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;

// ============================================================================
// ESTADO EN MEMORIA
// ============================================================================
const almacenamiento = {
  turnos: { datos: [], metadatos: null, estado: 'no_cargado' },
  citaciones: { datos: [], metadatos: null, estado: 'no_cargado' },
  logeo: { datos: [], metadatos: null, estado: 'no_cargado' }
};

const plantas = new Map();
let usuarioActual = { nombre: 'Sistema', rol: 'admin' };

// ============================================================================
// NORMALIZADOR DE ENCABEZADOS
// ============================================================================
function normalizarEncabezados(datos) {
  if (!Array.isArray(datos) || datos.length === 0) return datos;
  
  const primeraFila = datos[0];
  const mapa = {};
  
  // Crear mapeo de encabezados originales a normalizados
  Object.keys(primeraFila).forEach(key => {
    const keyNorm = key
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remover tildes
      .replace(/[^a-z0-9_]/g, '_')      // Solo alfanuméricos y guiones
      .replace(/_+/g, '_')              // Eliminar guiones múltiples
      .replace(/^_|_$/g, '');           // Remover guiones al inicio/final
    
    mapa[key] = keyNorm;
  });
  
  // Normalizar todas las filas
  return datos.map(fila => {
    const filaNorm = {};
    Object.entries(fila).forEach(([key, value]) => {
      const keyNorm = mapa[key];
      filaNorm[keyNorm] = value;
    });
    return filaNorm;
  });
}

// ============================================================================
// VALIDADORES CON ALIAS
// ============================================================================
const ALIAS_CAMPOS = {
  turnos: {
    operador: ['operador', 'oper', 'operario', 'nombre_operador', 'nom_operador'],
    planta: ['planta', 'planta_origen', 'origen', 'plta'],
    turno_inicio: ['turno_inicio', 'hora_inicio', 'hora_ingreso', 'hora inicio', 'horaingreso', 'turno']
  },
  citaciones: {
    operador: ['operador', 'oper', 'operario', 'nombre_operador', 'nom_operador'],
    citacion: ['citacion', 'cita', 'hora_citacion', 'hora citacion']
  },
  logeo: {
    operador: ['operador', 'oper', 'operario', 'nombre_operador', 'nom_operador', 'numero_funcionario'],
    logeo: ['logeo', 'marcacion', 'hora_logeo', 'hora logeo', 'entrada']
  }
};

function obtenerCampoReal(fila, aliases) {
  for (const alias of aliases) {
    if (alias in fila && fila[alias] !== null && fila[alias] !== undefined && String(fila[alias]).trim() !== '') {
      return fila[alias];
    }
  }
  return null;
}

function validarTurnos(datos) {
  const validas = [];
  const rechazadas = [];
  const errores = [];

  datos.forEach((fila, idx) => {
    const operador = obtenerCampoReal(fila, ALIAS_CAMPOS.turnos.operador);
    const planta = obtenerCampoReal(fila, ALIAS_CAMPOS.turnos.planta);
    const turno = obtenerCampoReal(fila, ALIAS_CAMPOS.turnos.turno_inicio);

    if (!operador) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "operador" vacío o no encontrado`);
      return;
    }
    if (!planta) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "planta" vacío o no encontrado`);
      return;
    }
    if (!turno) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "turno_inicio" vacío o no encontrado`);
      return;
    }

    validas.push({...fila, _operador: operador, _planta: planta, _turno_inicio: turno});
  });

  return { validas, rechazadas, errores };
}

function validarCitaciones(datos) {
  const validas = [];
  const rechazadas = [];
  const errores = [];

  datos.forEach((fila, idx) => {
    const operador = obtenerCampoReal(fila, ALIAS_CAMPOS.citaciones.operador);

    if (!operador) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "operador" vacío o no encontrado`);
      return;
    }

    validas.push({...fila, _operador: operador});
  });

  return { validas, rechazadas, errores };
}

function validarLogeo(datos) {
  const validas = [];
  const rechazadas = [];
  const errores = [];

  datos.forEach((fila, idx) => {
    const operador = obtenerCampoReal(fila, ALIAS_CAMPOS.logeo.operador);
    const logeo = obtenerCampoReal(fila, ALIAS_CAMPOS.logeo.logeo);

    if (!operador) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "operador" vacío o no encontrado`);
      return;
    }
    if (!logeo) {
      rechazadas.push(fila);
      errores.push(`Fila ${idx + 1}: campo "logeo" vacío o no encontrado`);
      return;
    }

    validas.push({...fila, _operador: operador, _logeo: logeo});
  });

  return { validas, rechazadas, errores };
}

// ============================================================================
// EXPRESS
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let indexHtmlCache = null;
function cargarIndexHtml() {
  const rutas = [
    path.join(__dirname, 'index.html'),
    path.join(process.cwd(), 'index.html'),
    '/app/index.html',
  ];
  for (const ruta of rutas) {
    try {
      if (fs.existsSync(ruta)) {
        console.log(`✅ index.html encontrado en: ${ruta}`);
        return fs.readFileSync(ruta, 'utf8');
      }
    } catch (e) {}
  }
  return null;
}
indexHtmlCache = cargarIndexHtml();

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ============================================================================
// ENDPOINTS
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Endpoint UNIVERSAL de ingesta (soporta tanto "registros" como "datos")
app.post('/api/ingesta', (req, res) => {
  try {
    let { tipo, registros, datos, archivo } = req.body;
    
    // CORRECCIÓN #1: Aceptar tanto "registros" como "datos"
    const datosFinales = datos || registros;
    
    // VALIDACIÓN CRÍTICA
    if (!tipo) {
      return res.status(400).json({ error: 'Campo "tipo" requerido', tipo_recibido: typeof tipo });
    }
    
    if (!Array.isArray(datosFinales)) {
      return res.status(400).json({ 
        error: `Datos no es un arreglo (recibido: ${typeof datosFinales})`,
        tipo 
      });
    }
    
    if (datosFinales.length === 0) {
      return res.status(400).json({ 
        error: 'El archivo está vacío - no contiene filas para procesar',
        tipo 
      });
    }

    // CORRECCIÓN #2: Normalizar encabezados
    const datosNormalizados = normalizarEncabezados(datosFinales);

    // Validar según tipo
    let resultado;
    if (tipo === 'turnos') {
      resultado = validarTurnos(datosNormalizados);
    } else if (tipo === 'citaciones') {
      resultado = validarCitaciones(datosNormalizados);
    } else if (tipo === 'logeo') {
      resultado = validarLogeo(datosNormalizados);
    } else {
      return res.status(400).json({ error: `Tipo desconocido: ${tipo}` });
    }

    // Guardar en almacenamiento
    almacenamiento[tipo].datos = resultado.validas;
    almacenamiento[tipo].metadatos = {
      filas_totales: datosFinales.length,
      filas_validas: resultado.validas.length,
      filas_rechazadas: resultado.rechazadas.length,
      errores: resultado.errores.slice(0, 10),
      archivo,
      cargado_en: new Date().toISOString(),
      cargado_por: usuarioActual.nombre
    };
    almacenamiento[tipo].estado = 'cargado';

    // Extraer plantas si es Turnos
    if (tipo === 'turnos') {
      const plantasSet = new Set(resultado.validas.map(t => t._planta).filter(Boolean));
      plantasSet.forEach(nombre => {
        if (!plantas.has(nombre)) {
          plantas.set(nombre, {
            zona: 'RM',
            citacion_activa: false,
            tolerancia_a_tiempo: 5,
            tolerancia_max_atraso: 30,
            espera_max_asignacion: 20
          });
        }
      });
    }

    console.log(`✅ ${tipo}: ${resultado.validas.length}/${datosFinales.length} filas válidas`);

    res.json({
      ok: true,
      tipo,
      filas_totales: datosFinales.length,
      filas_validas: resultado.validas.length,
      filas_rechazadas: resultado.rechazadas.length,
      errores: resultado.errores.slice(0, 5),
      plantas: tipo === 'turnos' ? Array.from(plantas.keys()) : undefined
    });

  } catch (err) {
    console.error('❌ Error en /api/ingesta:', err.message);
    res.status(500).json({ error: `Error interno: ${err.message}` });
  }
});

// Obtener estado de ingesta
app.get('/api/ingesta/estado', (req, res) => {
  res.json({
    ok: true,
    turnos: almacenamiento.turnos.metadatos,
    citaciones: almacenamiento.citaciones.metadatos,
    logeo: almacenamiento.logeo.metadatos
  });
});

// Obtener plantas
app.get('/api/plantas', (req, res) => {
  res.json({
    ok: true,
    plantas: Array.from(plantas.entries()).map(([nombre, config]) => ({
      nombre,
      ...config
    }))
  });
});

// Generar reporte
app.get('/api/reporte', (req, res) => {
  try {
    const turnos = almacenamiento.turnos.datos;
    const logeos = almacenamiento.logeo.datos;
    const citaciones = almacenamiento.citaciones.datos;

    if (!turnos.length) {
      return res.status(400).json({ error: 'No hay turnos cargados' });
    }

    const conLogeo = logeos.length;
    const totalOperadores = turnos.length;
    const adherencia = totalOperadores > 0 ? Math.round((conLogeo / totalOperadores) * 100) : 0;

    res.json({
      ok: true,
      resumen: {
        totalOperadores,
        conLogeo,
        adherencia,
        turnosValidas: almacenamiento.turnos.metadatos?.filas_validas || 0,
        citacionesValidas: almacenamiento.citaciones.metadatos?.filas_validas || 0,
        logeoValidas: almacenamiento.logeo.metadatos?.filas_validas || 0
      },
      generado_por: usuarioActual.nombre,
      generado_en: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ruta raíz
app.get('/', (req, res) => {
  if (indexHtmlCache) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtmlCache);
  } else {
    res.status(500).send('Error: index.html no disponible');
  }
});

// ============================================================================
// SOCKET.IO (para síncronización en tiempo real)
// ============================================================================
io.on('connection', (socket) => {
  console.log('✅ Cliente conectado:', socket.id);

  socket.on('ingesta-actualizada', (datos) => {
    io.emit('ingesta-actualizada', datos);
  });

  socket.on('disconnect', () => {
    console.log('❌ Cliente desconectado:', socket.id);
  });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
server.listen(PORT, () => {
  console.log(`✅ CCO Intelligence Backend v2.0 corriendo en puerto ${PORT}`);
  console.log(`📍 https://cco-backend-d-jalo-public.onrender.com`);
  console.log(`🔧 Correcciones aplicadas:`);
  console.log(`   ✓ Aceptar tanto "registros" como "datos"`);
  console.log(`   ✓ Normalización de encabezados`);
  console.log(`   ✓ Validación con alias de campos`);
  console.log(`   ✓ Mensajes de error específicos`);
});
