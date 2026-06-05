const express = require('express');
const router = express.Router();
const db = require('../db/database');

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function parseItems(body) {
  const items = [];
  if (!body.item_tipo) return items;
  const tipos   = Array.isArray(body.item_tipo)        ? body.item_tipo        : [body.item_tipo];
  const descs   = Array.isArray(body.item_descripcion) ? body.item_descripcion : [body.item_descripcion];
  const cants   = Array.isArray(body.item_cantidad)    ? body.item_cantidad    : [body.item_cantidad];
  const precios = Array.isArray(body.item_precio)      ? body.item_precio      : [body.item_precio];
  for (let i = 0; i < tipos.length; i++) {
    if (descs[i]?.trim()) {
      items.push({
        tipo:           tipos[i] || 'Repuesto',
        descripcion:    descs[i].trim(),
        cantidad:       parseFloat(cants[i])   || 1,
        precio_unitario: parseFloat(precios[i]) || 0
      });
    }
  }
  return items;
}

// Estrategia editar tareas: DELETE + reinsert dentro de la transaccion.
// Antes del borrado se construye un mapa normalizado (descripcion.toLowerCase().trim() -> fila)
// para recuperar completado/tecnico/fecha_completado de las tareas que ya existian.
// Asi se conserva el progreso del mecanico cuando solo se reformatea texto o se reordena la lista.
function parseTareas(body) {
  if (!body.tarea_descripcion) return [];
  const descs = Array.isArray(body.tarea_descripcion) ? body.tarea_descripcion : [body.tarea_descripcion];
  return descs
    .map(d => (d || '').trim())
    .filter(d => d.length > 0);
}

// Estados validos de una orden (fuente de verdad)
const ESTADOS_VALIDOS = ['Pendiente', 'Asignada', 'En proceso', 'Completada', 'Por cobrar', 'Cobrada', 'Cancelada'];

/**
 * Guard: solo el encargado (admin) puede continuar.
 */
function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Solo el encargado puede realizar esta accion.'
    });
  }
  next();
}

/**
 * Obtiene la lista de mecanicos activos para pasar a los formularios.
 */
function getMecanicos() {
  return db.prepare(
    "SELECT id, nombre FROM usuarios WHERE rol='tecnico' AND activo=1 ORDER BY nombre"
  ).all();
}

/**
 * Obtiene la lista de vehiculos con cliente para pasar a los formularios.
 */
function getVehiculos() {
  return db.prepare(`
    SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
    FROM vehiculos v
    JOIN clientes c ON v.cliente_id = c.id
    ORDER BY c.nombre, v.placa
  `).all();
}

// ---------------------------------------------------------------------------
// LISTAR GET /
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const estado = req.query.estado || '';
  const buscar = (req.query.buscar || '').trim();
  const usuario = req.session.usuario;

  let query = `
    SELECT s.*,
           v.placa, v.marca, v.modelo,
           c.nombre  AS cliente_nombre,
           u.nombre  AS mecanico_nombre,
           COALESCE((
             SELECT SUM(si.cantidad * si.precio_unitario)
             FROM servicio_items si
             WHERE si.servicio_id = s.id
           ), 0) AS total_items
    FROM servicios s
    JOIN vehiculos v  ON s.vehiculo_id  = v.id
    JOIN clientes  c  ON v.cliente_id   = c.id
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
  `;
  const params = [];
  const conditions = [];

  // Restriccion por rol: el mecanico solo ve sus ordenes asignadas
  if (usuario?.rol === 'tecnico') {
    conditions.push('s.mecanico_id = ?');
    params.push(usuario.id);
  }

  if (estado) {
    conditions.push('s.estado = ?');
    params.push(estado);
  }

  if (buscar) {
    // Busqueda ampliada: placa, cliente, descripcion, tecnico, vin, cedula, telefono
    conditions.push(
      '(v.placa LIKE ? OR c.nombre LIKE ? OR s.descripcion LIKE ? OR s.tecnico LIKE ? OR v.vin LIKE ? OR c.cedula LIKE ? OR c.telefono LIKE ?)'
    );
    const term = `%${buscar}%`;
    params.push(term, term, term, term, term, term, term);
  }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.fecha DESC';

  const servicios = db.prepare(query).all(...params);
  res.render('servicios/index', { title: 'Servicios', servicios, estado, buscar });
});

// ---------------------------------------------------------------------------
// CREAR GET /crear  (solo admin)
// ---------------------------------------------------------------------------
router.get('/crear', soloAdmin, (req, res) => {
  res.render('servicios/form', {
    title: 'Nuevo Servicio',
    servicio:  { vehiculo_id: req.query.vehiculo_id || '', items: [], tareas: [] },
    vehiculos:  getVehiculos(),
    mecanicos:  getMecanicos(),
    errors:    []
  });
});

// ---------------------------------------------------------------------------
// CREAR POST /crear  (solo admin)
// ---------------------------------------------------------------------------
router.post('/crear', soloAdmin, (req, res) => {
  const { vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas } = req.body;
  // mecanico_id puede venir vacio -> NULL
  const mecanico_id = req.body.mecanico_id ? parseInt(req.body.mecanico_id, 10) : null;
  const items  = parseItems(req.body);
  const tareas = parseTareas(req.body);
  const errors = [];

  if (!vehiculo_id)         errors.push('Debe seleccionar un vehiculo');
  if (!descripcion?.trim()) errors.push('La descripcion es obligatoria');

  if (errors.length) {
    return res.render('servicios/form', {
      title:    'Nuevo Servicio',
      servicio: { ...req.body, items, tareas: tareas.map(d => ({ descripcion: d, completado: 0 })) },
      vehiculos: getVehiculos(),
      mecanicos: getMecanicos(),
      errors
    });
  }

  // Determinar estado final:
  // - Si el form envia estado valido, respetarlo.
  // - Si no, usar 'Pendiente'.
  // - Excepcion: si se asigna mecanico y el estado resultante es 'Pendiente', promover a 'Asignada'.
  let estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'Pendiente';
  if (mecanico_id && estadoFinal === 'Pendiente') {
    estadoFinal = 'Asignada';
  }

  const insertServ = db.prepare(
    'INSERT INTO servicios (vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas, mecanico_id) VALUES (?,?,?,?,?,?,?,?)'
  );
  const insertItem  = db.prepare('INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
  const insertTarea = db.prepare('INSERT INTO servicio_tareas (servicio_id, descripcion, completado, orden) VALUES (?,?,0,?)');

  db.transaction(() => {
    const result = insertServ.run(
      vehiculo_id, descripcion.trim(), kilometraje || null,
      tecnico?.trim(), estadoFinal, costo || 0, notas?.trim(), mecanico_id
    );
    const servId = result.lastInsertRowid;
    for (const it of items) {
      insertItem.run(servId, it.tipo, it.descripcion, it.cantidad, it.precio_unitario);
    }
    for (let i = 0; i < tareas.length; i++) {
      insertTarea.run(servId, tareas[i], i);
    }
  })();

  res.flash('success', 'Servicio registrado');
  res.redirect('/servicios');
});

// ---------------------------------------------------------------------------
// DETALLE GET /:id
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const servicio = db.prepare(`
    SELECT s.*, v.placa, v.marca, v.modelo, c.nombre AS cliente_nombre,
           v.id AS vehiculo_id, u.nombre AS mecanico_nombre,
           s.fecha_completado, s.cobrado, s.fecha_cobro
    FROM servicios s
    JOIN vehiculos  v  ON s.vehiculo_id  = v.id
    JOIN clientes   c  ON v.cliente_id   = c.id
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  // Guard de acceso para mecanico: solo puede ver sus propias ordenes
  const usuario = req.session.usuario;
  if (usuario?.rol === 'tecnico' && servicio.mecanico_id !== usuario.id) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Esta orden no esta asignada a ti.'
    });
  }

  const items  = db.prepare('SELECT * FROM servicio_items  WHERE servicio_id = ?').all(servicio.id);
  const totalItems = items.reduce((sum, i) => sum + i.cantidad * i.precio_unitario, 0);

  const tareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY orden, id').all(servicio.id);
  const totalTareas       = tareas.length;
  const tareasCompletadas = tareas.filter(t => t.completado).length;

  const comentarios = db.prepare(
    'SELECT * FROM servicio_comentarios WHERE servicio_id = ? ORDER BY fecha DESC, id DESC'
  ).all(servicio.id);

  res.render('servicios/detalle', {
    title: 'Servicio',
    servicio,
    items,
    totalItems,
    tareas,
    totalTareas,
    tareasCompletadas,
    comentarios
  });
});

// ---------------------------------------------------------------------------
// EDITAR GET /:id/editar  (solo admin)
// ---------------------------------------------------------------------------
router.get('/:id/editar', soloAdmin, (req, res) => {
  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(req.params.id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }
  servicio.items  = db.prepare('SELECT * FROM servicio_items  WHERE servicio_id = ?').all(servicio.id);
  servicio.tareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY orden, id').all(servicio.id);

  res.render('servicios/form', {
    title:    'Editar Servicio',
    servicio,
    vehiculos: getVehiculos(),
    mecanicos: getMecanicos(),
    errors:   []
  });
});

// ---------------------------------------------------------------------------
// EDITAR POST /:id/editar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/editar', soloAdmin, (req, res) => {
  const { vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas } = req.body;
  const mecanico_id = req.body.mecanico_id ? parseInt(req.body.mecanico_id, 10) : null;
  const items  = parseItems(req.body);
  const tareas = parseTareas(req.body);
  const errors = [];

  if (!vehiculo_id)         errors.push('Debe seleccionar un vehiculo');
  if (!descripcion?.trim()) errors.push('La descripcion es obligatoria');

  if (errors.length) {
    return res.render('servicios/form', {
      title:    'Editar Servicio',
      servicio: { ...req.body, id: req.params.id, items, tareas: tareas.map(d => ({ descripcion: d, completado: 0 })) },
      vehiculos: getVehiculos(),
      mecanicos: getMecanicos(),
      errors
    });
  }

  // Estado: respetar el valor del form si es valido.
  // Si se asigna mecanico y el estado resultante es 'Pendiente', promover a 'Asignada'.
  let estadoFinal = ESTADOS_VALIDOS.includes(estado) ? estado : 'Pendiente';
  if (mecanico_id && estadoFinal === 'Pendiente') {
    estadoFinal = 'Asignada';
  }

  // Mapa de tareas previas para conservar progreso del mecanico
  const prevTareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ?').all(req.params.id);
  const prevMap    = new Map(prevTareas.map(t => [t.descripcion.toLowerCase().trim(), t]));

  const updateServ  = db.prepare(
    'UPDATE servicios SET vehiculo_id=?, descripcion=?, kilometraje=?, tecnico=?, estado=?, costo=?, notas=?, mecanico_id=? WHERE id=?'
  );
  const deleteItems  = db.prepare('DELETE FROM servicio_items  WHERE servicio_id=?');
  const insertItem   = db.prepare('INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
  const deleteTareas = db.prepare('DELETE FROM servicio_tareas WHERE servicio_id=?');
  const insertTarea  = db.prepare('INSERT INTO servicio_tareas (servicio_id, descripcion, completado, tecnico, fecha_completado, orden) VALUES (?,?,?,?,?,?)');

  db.transaction(() => {
    updateServ.run(vehiculo_id, descripcion.trim(), kilometraje || null, tecnico?.trim(), estadoFinal, costo || 0, notas?.trim(), mecanico_id, req.params.id);
    deleteItems.run(req.params.id);
    for (const it of items) {
      insertItem.run(req.params.id, it.tipo, it.descripcion, it.cantidad, it.precio_unitario);
    }
    deleteTareas.run(req.params.id);
    for (let i = 0; i < tareas.length; i++) {
      const prev          = prevMap.get(tareas[i].toLowerCase().trim());
      const completado    = prev ? prev.completado    : 0;
      const tecnicoTarea  = prev ? prev.tecnico       : null;
      const fechaComp     = prev ? prev.fecha_completado : null;
      insertTarea.run(req.params.id, tareas[i], completado, tecnicoTarea, fechaComp, i);
    }
  })();

  res.flash('success', 'Servicio actualizado');
  res.redirect(`/servicios/${req.params.id}`);
});

// ---------------------------------------------------------------------------
// TOGGLE TAREA POST /:id/tareas/:tareaId/toggle
// (admin y mecanico con acceso a la orden)
// ---------------------------------------------------------------------------
router.post('/:id/tareas/:tareaId/toggle', (req, res) => {
  const tarea = db.prepare('SELECT * FROM servicio_tareas WHERE id = ? AND servicio_id = ?')
    .get(req.params.tareaId, req.params.id);

  if (!tarea) {
    res.flash('danger', 'Tarea no encontrada');
    return res.redirect(`/servicios/${req.params.id}`);
  }

  // Guard de acceso: verificar que el mecanico tenga acceso a esta orden
  const usuario = req.session.usuario;
  if (usuario?.rol === 'tecnico') {
    const servicio = db.prepare('SELECT mecanico_id FROM servicios WHERE id = ?').get(req.params.id);
    if (!servicio || servicio.mecanico_id !== usuario.id) {
      return res.status(403).render('partials/error', {
        title: 'Acceso denegado',
        message: 'Esta orden no esta asignada a ti.'
      });
    }
  }

  if (tarea.completado) {
    // Reabrir tarea: limpiar estado
    db.prepare('UPDATE servicio_tareas SET completado=0, tecnico=NULL, fecha_completado=NULL WHERE id=?').run(tarea.id);
  } else {
    // Marcar como hecha: registrar quien y cuando
    const nombreTecnico = req.session.usuario ? req.session.usuario.nombre : null;
    const fechaAhora    = new Date().toLocaleString('es-CR');
    db.prepare('UPDATE servicio_tareas SET completado=1, tecnico=?, fecha_completado=? WHERE id=?')
      .run(nombreTecnico, fechaAhora, tarea.id);
  }

  res.flash('success', 'Tarea actualizada');
  res.redirect(`/servicios/${req.params.id}`);
});

// ---------------------------------------------------------------------------
// COMENTARIO POST /:id/comentario
// (admin o mecanico asignado a la orden)
// ---------------------------------------------------------------------------
router.post('/:id/comentario', (req, res) => {
  const id      = req.params.id;
  const usuario = req.session.usuario;
  const texto   = (req.body.comentario || '').trim();

  if (!texto) {
    res.flash('danger', 'El comentario no puede estar vacio');
    return res.redirect(`/servicios/${id}`);
  }

  // Verificar acceso: admin siempre; mecanico solo si es el asignado
  const servicio = db.prepare('SELECT mecanico_id FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  if (usuario?.rol === 'tecnico' && servicio.mecanico_id !== usuario.id) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Esta orden no esta asignada a ti.'
    });
  }

  db.prepare(
    'INSERT INTO servicio_comentarios (servicio_id, usuario_id, autor, comentario) VALUES (?,?,?,?)'
  ).run(id, usuario.id, usuario.nombre, texto);

  res.flash('success', 'Comentario agregado');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// COMPLETAR ORDEN POST /:id/completar
// (admin o mecanico asignado)
// ---------------------------------------------------------------------------
router.post('/:id/completar', (req, res) => {
  const id      = req.params.id;
  const usuario = req.session.usuario;

  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  // Guard de acceso
  if (usuario?.rol === 'tecnico' && servicio.mecanico_id !== usuario.id) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Esta orden no esta asignada a ti.'
    });
  }

  // Validar que todas las tareas esten completadas (solo si hay tareas)
  const tareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ?').all(id);
  if (tareas.length > 0) {
    const pendientes = tareas.filter(t => !t.completado).length;
    if (pendientes > 0) {
      res.flash('danger', `Faltan ${pendientes} tarea(s) por completar`);
      return res.redirect(`/servicios/${id}`);
    }
  }

  const fechaAhora = new Date().toLocaleString('es-CR');
  db.prepare("UPDATE servicios SET estado='Completada', fecha_completado=? WHERE id=?")
    .run(fechaAhora, id);

  res.flash('success', 'Orden marcada como completada');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// POR COBRAR POST /:id/por-cobrar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/por-cobrar', soloAdmin, (req, res) => {
  const id = req.params.id;
  const servicio = db.prepare('SELECT id FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  db.prepare("UPDATE servicios SET estado='Por cobrar' WHERE id=?").run(id);

  res.flash('success', 'Orden marcada como por cobrar');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// COBRAR POST /:id/cobrar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/cobrar', soloAdmin, (req, res) => {
  const id = req.params.id;
  const servicio = db.prepare('SELECT id FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  const fechaAhora = new Date().toLocaleString('es-CR');
  db.prepare("UPDATE servicios SET estado='Cobrada', cobrado=1, fecha_cobro=? WHERE id=?")
    .run(fechaAhora, id);

  res.flash('success', 'Orden marcada como cobrada');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// ELIMINAR POST /:id/eliminar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/eliminar', soloAdmin, (req, res) => {
  db.prepare('DELETE FROM servicios WHERE id = ?').run(req.params.id);
  res.flash('success', 'Servicio eliminado');
  res.redirect('/servicios');
});

module.exports = router;
