/**
 * src/routes/portal.js
 *
 * Router del portal del cliente (rol 'cliente').
 * AISLAMIENTO ESTRICTO: cliente_id SIEMPRE se obtiene de la sesion.
 * El request NUNCA dicta el cliente_id.
 */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const db        = require('../db/database');
const audit     = require('../lib/auditoria');
const moneda    = require('../lib/moneda');

const router = express.Router();

// ---------------------------------------------------------------------------
// GUARD: solo clientes con cliente_id valido
// ---------------------------------------------------------------------------

function soloCliente(req, res, next) {
  const u = req.session.usuario;
  if (u?.rol !== 'cliente' || !u.cliente_id) {
    return res.status(403).render('partials/error', {
      title:   'Acceso restringido',
      message: 'Seccion solo para clientes.'
    });
  }
  next();
}

router.use(soloCliente);

// ---------------------------------------------------------------------------
// HELPER ANTI-IDOR: vehiculo debe pertenecer al cliente de la sesion
// ---------------------------------------------------------------------------

function getVehiculo(id, clienteId) {
  return db
    .prepare('SELECT * FROM vehiculos WHERE id = ? AND cliente_id = ?')
    .get(id, clienteId);
}

// ---------------------------------------------------------------------------
// RATE LIMIT: POST /solicitudes (10 solicitudes cada 15 min por IP)
// ---------------------------------------------------------------------------

const limiterSolicitud = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiadas solicitudes. Espera unos minutos antes de intentar de nuevo.'
});

// ---------------------------------------------------------------------------
// GET /portal  — dashboard del cliente
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;

  const cliente = db
    .prepare('SELECT * FROM clientes WHERE id = ?')
    .get(clienteId);

  const vehiculos = db
    .prepare('SELECT * FROM vehiculos WHERE cliente_id = ? ORDER BY placa ASC')
    .all(clienteId);

  // Ultimas 10 ordenes de cualquier vehiculo del cliente
  const ordenesRecientes = db.prepare(`
    SELECT s.id, s.numero, s.descripcion, s.estado, s.fecha, s.costo, s.moneda,
           v.placa, v.marca, v.modelo
    FROM   servicios s
    JOIN   vehiculos v ON s.vehiculo_id = v.id
    WHERE  v.cliente_id = ?
    ORDER  BY s.fecha DESC, s.id DESC
    LIMIT  10
  `).all(clienteId);

  // Ultimas 10 solicitudes del cliente
  const solicitudes = db.prepare(`
    SELECT ss.id, ss.descripcion, ss.estado, ss.fecha, ss.fecha_resuelta,
           v.placa, v.marca, v.modelo
    FROM   solicitudes_servicio ss
    JOIN   vehiculos v ON ss.vehiculo_id = v.id
    WHERE  ss.cliente_id = ?
    ORDER  BY ss.fecha DESC
    LIMIT  10
  `).all(clienteId);

  res.render('portal/dashboard', {
    title:          'Mi Portal',
    cliente,
    vehiculos,
    ordenesRecientes,
    solicitudes
  });
});

// ---------------------------------------------------------------------------
// GET /portal/vehiculos/:id  — historial del vehiculo con montos y fotos
// ---------------------------------------------------------------------------

router.get('/vehiculos/:id', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;
  const vehId     = parseInt(req.params.id, 10);

  const vehiculo = getVehiculo(vehId, clienteId);
  if (!vehiculo) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Vehiculo no encontrado.'
    });
  }

  // -- Ordenes de servicio con mecanico y total de repuestos --
  const servicios = db.prepare(`
    SELECT s.id, s.numero, s.descripcion, s.estado, s.fecha, s.costo, s.moneda,
           s.kilometraje,
           u.nombre AS mecanico_nombre,
           COALESCE((
             SELECT SUM(si.cantidad * si.precio_unitario)
             FROM   servicio_items si
             WHERE  si.servicio_id = s.id
             AND    si.tipo        = 'Repuesto'
           ), 0) AS total_repuestos
    FROM   servicios s
    LEFT   JOIN usuarios u ON s.mecanico_id = u.id
    WHERE  s.vehiculo_id = ?
    ORDER  BY s.fecha DESC, s.id DESC
  `).all(vehId);

  // -- Cotizaciones con total calculado --
  const cotizaciones = db.prepare(`
    SELECT c.id, c.numero, c.fecha, c.estado, c.moneda,
           c.aplica_iva, c.iva_porcentaje,
           COALESCE((
             SELECT SUM(cd.cantidad * cd.precio_unitario)
             FROM   cotizacion_detalles cd
             WHERE  cd.cotizacion_id = c.id
           ), 0) AS subtotal
    FROM   cotizaciones c
    WHERE  c.vehiculo_id = ?
    ORDER  BY c.fecha DESC, c.id DESC
  `).all(vehId);

  // Calcular total con IVA para cada cotizacion
  const cotizacionesConTotal = cotizaciones.map(c => {
    const iva   = c.aplica_iva ? c.subtotal * ((c.iva_porcentaje || 0) / 100) : 0;
    const total = c.subtotal + iva;
    return { ...c, iva, total };
  });

  // -- Unificar eventos ordenados por fecha desc --
  const eventos = [
    ...servicios.map(s => ({
      tipo:   'orden',
      fecha:  s.fecha,
      datos:  s
    })),
    ...cotizacionesConTotal.map(c => ({
      tipo:  'cotizacion',
      fecha: c.fecha,
      datos: c
    }))
  ].sort((a, b) => {
    const da = a.fecha || '';
    const db_ = b.fecha || '';
    if (db_ > da) return 1;
    if (db_ < da) return -1;
    return 0;
  });

  // -- KPIs (facturado separado por moneda: no se suman USD y CRC) --
  const ordenesCobradas   = servicios.filter(s => s.estado === 'Cobrada');
  const facturadoUsd      = ordenesCobradas.filter(s => (s.moneda || 'USD') !== 'CRC').reduce((acc, s) => acc + (s.costo || 0), 0);
  const facturadoCrc      = ordenesCobradas.filter(s => s.moneda === 'CRC').reduce((acc, s) => acc + (s.costo || 0), 0);
  const total_facturado   = moneda.fmtTotales(facturadoUsd, facturadoCrc);
  const ordenesPorFecha   = [...servicios].sort((a, b) => (b.fecha || '') > (a.fecha || '') ? 1 : -1);
  const ultima_visita     = ordenesPorFecha[0]?.fecha || null;
  const ordenesConKm      = servicios.filter(s => s.kilometraje);
  const ultimo_km         = ordenesConKm.length
    ? Math.max(...ordenesConKm.map(s => s.kilometraje))
    : null;

  const kpis = {
    total_ordenes: servicios.length,
    ultima_visita,
    ultimo_km,
    total_facturado
  };

  // -- Fotos del vehiculo y de sus ordenes --
  const fotosVehiculo = db.prepare(`
    SELECT f.id, f.archivo, f.nombre_original, f.descripcion,
           f.vehiculo_id, f.servicio_id
    FROM   fotos f
    WHERE  f.vehiculo_id = ? AND f.servicio_id IS NULL
    ORDER  BY f.id DESC
  `).all(vehId);

  const fotosServicio = db.prepare(`
    SELECT f.id, f.archivo, f.nombre_original, f.descripcion,
           f.vehiculo_id, f.servicio_id,
           s.numero AS servicio_numero
    FROM   fotos f
    JOIN   servicios s ON f.servicio_id = s.id
    WHERE  s.vehiculo_id = ?
    ORDER  BY f.id DESC
  `).all(vehId);

  const fotos = [...fotosVehiculo, ...fotosServicio];

  res.render('portal/historial', {
    title:    `Historial: ${vehiculo.placa}`,
    vehiculo,
    kpis,
    eventos,
    fotos
  });
});

// ---------------------------------------------------------------------------
// GET /portal/solicitudes  — listado de solicitudes del cliente
// ---------------------------------------------------------------------------

router.get('/solicitudes', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;

  const solicitudes = db.prepare(`
    SELECT ss.id, ss.descripcion, ss.estado, ss.fecha, ss.fecha_resuelta,
           ss.nota_taller, ss.servicio_id,
           v.placa, v.marca, v.modelo
    FROM   solicitudes_servicio ss
    JOIN   vehiculos v ON ss.vehiculo_id = v.id
    WHERE  ss.cliente_id = ?
    ORDER  BY ss.fecha DESC
  `).all(clienteId);

  res.render('portal/solicitudes_index', {
    title:      'Mis Solicitudes',
    solicitudes
  });
});

// ---------------------------------------------------------------------------
// GET /portal/solicitudes/crear  — formulario nueva solicitud
// ---------------------------------------------------------------------------

router.get('/solicitudes/crear', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;

  const vehiculos = db
    .prepare('SELECT id, placa, marca, modelo FROM vehiculos WHERE cliente_id = ? ORDER BY placa ASC')
    .all(clienteId);

  res.render('portal/solicitud_form', {
    title:    'Solicitar Servicio',
    vehiculos,
    errors:   []
  });
});

// ---------------------------------------------------------------------------
// POST /portal/solicitudes  — crear solicitud (con rate limit)
// ---------------------------------------------------------------------------

router.post('/solicitudes', limiterSolicitud, (req, res) => {
  const clienteId = req.session.usuario.cliente_id;
  const usuario   = req.session.usuario;

  const vehiculoId  = parseInt(req.body.vehiculo_id, 10) || null;
  const descripcion = (req.body.descripcion || '').trim();

  const errors = [];

  // Validar vehiculo_id (anti-IDOR: debe pertenecer al cliente)
  let vehiculo = null;
  if (!vehiculoId) {
    errors.push('Debes seleccionar un vehiculo.');
  } else {
    vehiculo = getVehiculo(vehiculoId, clienteId);
    if (!vehiculo) {
      // No revelar existencia: mismo mensaje generico
      errors.push('Debes seleccionar un vehiculo valido.');
    }
  }

  // Validar descripcion
  if (!descripcion) {
    errors.push('La descripcion no puede estar vacia.');
  } else if (descripcion.length > 2000) {
    errors.push('La descripcion no puede superar 2000 caracteres.');
  }

  if (errors.length > 0) {
    const vehiculos = db
      .prepare('SELECT id, placa, marca, modelo FROM vehiculos WHERE cliente_id = ? ORDER BY placa ASC')
      .all(clienteId);
    return res.status(422).render('portal/solicitud_form', {
      title:    'Solicitar Servicio',
      vehiculos,
      errors
    });
  }

  const info = db.prepare(`
    INSERT INTO solicitudes_servicio (cliente_id, vehiculo_id, descripcion, estado)
    VALUES (?, ?, ?, 'Solicitada')
  `).run(clienteId, vehiculoId, descripcion);

  audit.registrar({
    usuario,
    accion:     'CREAR',
    entidad:    'solicitudes_servicio',
    entidad_id: info.lastInsertRowid,
    estado_nuevo: 'Solicitada',
    detalle:    `Vehiculo ${vehiculo.placa}: ${descripcion.substring(0, 100)}`
  });

  res.flash('success', 'Solicitud enviada correctamente. El taller la revisara pronto.');
  res.redirect('/portal/solicitudes');
});

// ---------------------------------------------------------------------------
// GET /portal/cotizaciones/:id/pdf  — PDF de cotizacion (solo si es del cliente)
// ---------------------------------------------------------------------------

router.get('/cotizaciones/:id/pdf', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;
  const cotId     = parseInt(req.params.id, 10);

  // Verificar pertenencia: la cotizacion pertenece a un vehiculo del cliente
  const row = db.prepare(`
    SELECT v.cliente_id, cot.numero
    FROM   cotizaciones cot
    JOIN   vehiculos v ON cot.vehiculo_id = v.id
    WHERE  cot.id = ?
  `).get(cotId);

  if (!row || row.cliente_id !== clienteId) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Cotizacion no encontrada.'
    });
  }

  const { construirPDF } = require('./cotizaciones');
  const resultado = construirPDF(cotId);
  if (!resultado) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'No se pudo generar el PDF de la cotizacion.'
    });
  }

  const { doc, cot } = resultado;
  const numero = (cot.numero || `cot-${cotId}`).replace(/[^a-zA-Z0-9-]/g, '');

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="cotizacion-${numero}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ---------------------------------------------------------------------------
// GET /portal/vehiculos/:id/reporte  — reporte PDF del vehiculo
// ---------------------------------------------------------------------------

router.get('/vehiculos/:id/reporte', (req, res) => {
  const clienteId = req.session.usuario.cliente_id;
  const vehId     = parseInt(req.params.id, 10);

  const vehiculo = getVehiculo(vehId, clienteId);
  if (!vehiculo) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Vehiculo no encontrado.'
    });
  }

  const { streamReporteVehiculo } = require('./reportes');
  const ok = streamReporteVehiculo(res, vehiculo.id);
  if (!ok) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'No se pudo generar el reporte del vehiculo.'
    });
  }
});

module.exports = router;
