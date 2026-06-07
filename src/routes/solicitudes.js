/**
 * src/routes/solicitudes.js
 *
 * Router admin de solicitudes de servicio enviadas por clientes desde el portal.
 * Solo accesible por rol 'admin'.
 */

'use strict';

const express = require('express');
const db      = require('../db/database');
const audit   = require('../lib/auditoria');

const router = express.Router();

// ---------------------------------------------------------------------------
// GUARD: solo admin
// ---------------------------------------------------------------------------

function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', {
      title:   'Acceso denegado',
      message: 'Esta seccion es solo para el encargado.'
    });
  }
  next();
}

router.use(soloAdmin);

// ---------------------------------------------------------------------------
// GET /solicitudes  — bandeja de solicitudes con filtro opcional por estado
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const estadoFiltro = (req.query.estado || '').trim() || null;

  let sql = `
    SELECT ss.id, ss.descripcion, ss.estado, ss.fecha, ss.fecha_resuelta,
           ss.nota_taller, ss.servicio_id, ss.cliente_id, ss.vehiculo_id,
           c.nombre  AS cliente_nombre,
           v.placa, v.marca, v.modelo
    FROM   solicitudes_servicio ss
    JOIN   clientes  c ON ss.cliente_id  = c.id
    JOIN   vehiculos v ON ss.vehiculo_id = v.id
  `;

  let params = [];

  if (estadoFiltro) {
    sql += ' WHERE ss.estado = ?';
    params = [estadoFiltro];
  }

  sql += ' ORDER BY ss.fecha DESC';

  const solicitudes = db.prepare(sql).all(...params);

  res.render('solicitudes/index', {
    title:      'Solicitudes',
    solicitudes,
    estado:     estadoFiltro
  });
});

// ---------------------------------------------------------------------------
// GET /solicitudes/:id  — detalle de una solicitud
// ---------------------------------------------------------------------------

router.get('/:id', (req, res) => {
  const solId = parseInt(req.params.id, 10);

  const solicitud = db.prepare(`
    SELECT ss.id, ss.descripcion, ss.estado, ss.fecha, ss.fecha_resuelta,
           ss.nota_taller, ss.servicio_id, ss.cliente_id, ss.vehiculo_id,
           c.nombre  AS cliente_nombre,
           v.placa, v.marca, v.modelo
    FROM   solicitudes_servicio ss
    JOIN   clientes  c ON ss.cliente_id  = c.id
    JOIN   vehiculos v ON ss.vehiculo_id = v.id
    WHERE  ss.id = ?
  `).get(solId);

  if (!solicitud) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Solicitud no encontrada.'
    });
  }

  res.render('solicitudes/detalle', {
    title:    'Solicitud',
    solicitud
  });
});

// ---------------------------------------------------------------------------
// POST /solicitudes/:id/aprobar
// ---------------------------------------------------------------------------

router.post('/:id/aprobar', (req, res) => {
  const solId   = parseInt(req.params.id, 10);
  const usuario = req.session.usuario;

  const solicitud = db
    .prepare('SELECT * FROM solicitudes_servicio WHERE id = ?')
    .get(solId);

  if (!solicitud) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Solicitud no encontrada.'
    });
  }

  const estadoAnterior = solicitud.estado;

  db.prepare(`
    UPDATE solicitudes_servicio
    SET    estado = 'Aprobada', fecha_resuelta = datetime('now')
    WHERE  id = ?
  `).run(solId);

  audit.registrar({
    usuario,
    accion:          'APROBAR',
    entidad:         'solicitudes_servicio',
    entidad_id:      solId,
    estado_anterior: estadoAnterior,
    estado_nuevo:    'Aprobada'
  });

  res.flash('success', 'Solicitud aprobada.');
  res.redirect(`/solicitudes/${solId}`);
});

// ---------------------------------------------------------------------------
// POST /solicitudes/:id/rechazar
// ---------------------------------------------------------------------------

router.post('/:id/rechazar', (req, res) => {
  const solId     = parseInt(req.params.id, 10);
  const usuario   = req.session.usuario;
  const notaTaller = (req.body.nota_taller || '').trim();

  const solicitud = db
    .prepare('SELECT * FROM solicitudes_servicio WHERE id = ?')
    .get(solId);

  if (!solicitud) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Solicitud no encontrada.'
    });
  }

  const estadoAnterior = solicitud.estado;

  db.prepare(`
    UPDATE solicitudes_servicio
    SET    estado = 'Rechazada',
           nota_taller = ?,
           fecha_resuelta = datetime('now')
    WHERE  id = ?
  `).run(notaTaller || null, solId);

  audit.registrar({
    usuario,
    accion:          'RECHAZAR',
    entidad:         'solicitudes_servicio',
    entidad_id:      solId,
    estado_anterior: estadoAnterior,
    estado_nuevo:    'Rechazada',
    detalle:         notaTaller ? `Nota: ${notaTaller.substring(0, 200)}` : null
  });

  res.flash('success', 'Solicitud rechazada.');
  res.redirect(`/solicitudes/${solId}`);
});

// ---------------------------------------------------------------------------
// POST /solicitudes/:id/convertir  — crea orden de servicio desde la solicitud
// ---------------------------------------------------------------------------

router.post('/:id/convertir', (req, res) => {
  const solId   = parseInt(req.params.id, 10);
  const usuario = req.session.usuario;

  const solicitud = db
    .prepare('SELECT * FROM solicitudes_servicio WHERE id = ?')
    .get(solId);

  if (!solicitud) {
    return res.status(404).render('partials/error', {
      title:   'No encontrado',
      message: 'Solicitud no encontrada.'
    });
  }

  // Si ya fue convertida no repetir
  if (solicitud.servicio_id) {
    res.flash('warning', `Esta solicitud ya fue convertida a la orden #${solicitud.servicio_id}.`);
    return res.redirect(`/solicitudes/${solId}`);
  }

  // Generar folio
  const { generarNumeroOrden } = require('./servicios');
  const folio = generarNumeroOrden();

  // Transaccion atomica
  const convertir = db.transaction(() => {
    const descripcionOrden = `Generada desde solicitud #${solId}: ${solicitud.descripcion}`;

    const infoServicio = db.prepare(`
      INSERT INTO servicios (vehiculo_id, numero, descripcion, estado, costo)
      VALUES (?, ?, ?, 'Pendiente', 0)
    `).run(solicitud.vehiculo_id, folio, descripcionOrden);

    const nuevoServicioId = infoServicio.lastInsertRowid;

    db.prepare(`
      UPDATE solicitudes_servicio
      SET    estado = 'Convertida',
             servicio_id = ?,
             fecha_resuelta = datetime('now')
      WHERE  id = ?
    `).run(nuevoServicioId, solId);

    return nuevoServicioId;
  });

  const nuevoServicioId = convertir();

  audit.registrar({
    usuario,
    accion:          'CONVERTIR',
    entidad:         'solicitudes_servicio',
    entidad_id:      solId,
    estado_anterior: solicitud.estado,
    estado_nuevo:    'Convertida',
    detalle:         `Orden ${folio} (id=${nuevoServicioId}) creada`
  });

  res.flash('success', `Orden ${folio} creada exitosamente.`);
  res.redirect(`/servicios/${nuevoServicioId}`);
});

module.exports = router;
