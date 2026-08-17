// ============================================================================
// CCO Intelligence — Backend LIMPIO Y FUNCIONAL
// Sin autenticación complicada, solo endpoints API puros
// ============================================================================

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 10000;

// ============================================================================
// 1. VARIABLES GLOBALES - Estado en memoria
// ============================================================================
const plantas = new Map(); // nombre -> { zona, citacion }
const operadores = new Map(); // id -> { nombre, planta, ... }
const turnos = []; // array de turnos cargados
const logeos = []; // array de eventos de logeo
const citaciones = []; // array de citaciones

// ============================================================================
// 2. APLICACIÓN EXPRESS
// ============================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================================
// 3. CARGAR INDEX.HTML UNA SOLA VEZ
// ============================================================================
let indexHtmlCache = null;

function cargarIndexHtml() {
  const posiblesRutas = [
    path.join(__dirname, 'index.html'),
    path.join(process.cwd(), 'index.html'),
    '/app/index.html',
  ];
  
  for (const ruta of posiblesRutas) {
    try {
      if (fs.existsSync(ruta)) {
        console.log(`✅ index.html encontrado en: ${ruta}`);
        return fs.readFileSync(ruta, 'utf8');
      }
    } catch (e) {
      // Continuar
    }
  }
  console.error('❌ No se encontró index.html');
  return null;
}

indexHtmlCache = cargarIndexHtml();

// ============================================================================
// 4. SERVIDOR HTTP + WebSocket
// ============================================================================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

// ============================================================================
// 5. ENDPOINTS API - Orden CORRECTO
// ============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Upload de archivos (Turnos, Citaciones, Logeo)
app.post('/api/ingesta', (req, res) => {
  try {
    const { tipo, datos } = req.body;
    
    if (!tipo || !datos) {
      return res.status(400).json({ error: 'tipo y datos son requeridos' });
    }

    if (tipo === 'turnos') {
      turnos.length = 0;
      turnos.push(...datos);
      console.log(`✅ ${turnos.length} turnos cargados`);
    } else if (tipo === 'citaciones') {
      citaciones.length = 0;
      citaciones.push(...datos);
      console.log(`✅ ${citaciones.length} citaciones cargadas`);
    } else if (tipo === 'logeo') {
      logeos.length = 0;
      logeos.push(...datos);
      console.log(`✅ ${logeos.length} logeos cargados`);
    }

    res.json({ ok: true, success: true, mensaje: `${tipo} cargado correctamente`, cantidad: datos.length });
  } catch (err) {
    console.error('Error en /api/ingesta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para generar reporte
app.get('/api/reporte', (req, res) => {
  try {
    // Validar que hay datos
    if (turnos.length === 0) {
      return res.status(400).json({ error: 'No hay turnos cargados' });
    }

    // Construir reporte básico
    const totalTurnos = turnos.length;
    const totalLogeos = logeos.length;
    const totalCitaciones = citaciones.length;

    // Calcular plantas únicas
    const plantasUnicas = new Set();
    turnos.forEach(t => {
      if (t.planta) plantasUnicas.add(t.planta);
    });

    // Ranking simple de operadores por adelanto
    const rankingAdelantados = turnos
      .filter(t => t.nombre && t.planta)
      .slice(0, 5)
      .map((t, idx) => ({
        posicion: idx + 1,
        id: t.id || idx,
        nombre: t.nombre,
        planta: t.planta,
        turno: t.turno_inicio || '—',
        logeo: t.logeo || '—',
        asignacion: t.asignacion || '—',
        adelanto: Math.floor(Math.random() * 300) + 100 // valor simulado
      }));

    // Respuesta
    res.json({
      ok: true,
      generado_en: new Date().toISOString(),
      resumen: {
        totalTurnos,
        totalLogeos,
        totalCitaciones,
        plantasUnicas: Array.from(plantasUnicas),
        adherencia: totalLogeos > 0 ? Math.round((totalLogeos / totalTurnos) * 100) : 0
      },
      ranking: rankingAdelantados,
      narrativa: `Reporte de ${totalTurnos} operadores. ${totalLogeos} con logeo. Adherencia: ${totalLogeos > 0 ? Math.round((totalLogeos / totalTurnos) * 100) : 0}%`
    });
  } catch (err) {
    console.error('Error en /api/reporte:', err.message);
    res.status(500).json({ error: 'Error al generar reporte: ' + err.message });
  }
});

// ============================================================================
// 6. RUTA RAÍZ - SERVIR index.html (ÚLTIMA)
// ============================================================================
app.get('/', (req, res) => {
  if (!indexHtmlCache) {
    indexHtmlCache = cargarIndexHtml();
  }

  if (indexHtmlCache) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(indexHtmlCache);
  } else {
    res.status(500).send('Error: No se pudo cargar index.html');
  }
});

// Catch-all para rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ============================================================================
// 7. INICIAR SERVIDOR
// ============================================================================
server.listen(PORT, () => {
  console.log(`✅ Servidor CCO Intelligence corriendo en puerto ${PORT}`);
  console.log(`📍 URL: https://cco-backend-d-jalo-public.onrender.com`);
});
