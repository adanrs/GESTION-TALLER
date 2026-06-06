const express = require('express');
const router = express.Router();
const db = require('../db/database');
const audit = require('../lib/auditoria');

// ---------------------------------------------------------------------------
// Listar clientes
// ?archivados=1  -> muestra solo activo=0
// por defecto    -> muestra solo activo=1
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const buscar     = req.query.buscar    || '';
  const archivados = req.query.archivados === '1';
  const filtroActivo = archivados ? 0 : 1;

  let clientes;
  if (buscar) {
    clientes = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM vehiculos WHERE cliente_id = c.id AND activo = 1) AS total_vehiculos
      FROM clientes c
      WHERE c.activo = ?
        AND (c.nombre LIKE ? OR c.cedula LIKE ? OR c.telefono LIKE ?)
      ORDER BY c.nombre
    `).all(filtroActivo, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  } else {
    clientes = db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM vehiculos WHERE cliente_id = c.id AND activo = 1) AS total_vehiculos
      FROM clientes c
      WHERE c.activo = ?
      ORDER BY c.nombre
    `).all(filtroActivo);
  }

  res.render('clientes/index', { title: 'Clientes', clientes, buscar, archivados });
});

// ---------------------------------------------------------------------------
// Formulario nuevo cliente
// ---------------------------------------------------------------------------
router.get('/crear', (req, res) => {
  res.render('clientes/form', { title: 'Nuevo Cliente', cliente: {}, errors: [] });
});

// Guardar nuevo cliente
router.post('/crear', (req, res) => {
  const { nombre, cedula, telefono, email, direccion } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.render('clientes/form', {
      title: 'Nuevo Cliente',
      cliente: req.body,
      errors: ['El nombre es obligatorio']
    });
  }
  db.prepare('INSERT INTO clientes (nombre, cedula, telefono, email, direccion) VALUES (?, ?, ?, ?, ?)')
    .run(nombre.trim(), cedula?.trim(), telefono?.trim(), email?.trim(), direccion?.trim());
  res.flash('success', 'Cliente creado exitosamente');
  res.redirect('/clientes');
});

// ---------------------------------------------------------------------------
// Ver detalle de cliente
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });

  // Solo vehiculos activos en el detalle
  const vehiculos = db.prepare(
    'SELECT * FROM vehiculos WHERE cliente_id = ? AND activo = 1 ORDER BY marca, modelo'
  ).all(cliente.id);

  res.render('clientes/detalle', { title: cliente.nombre, cliente, vehiculos });
});

// ---------------------------------------------------------------------------
// Formulario editar cliente
// ---------------------------------------------------------------------------
router.get('/:id/editar', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });
  res.render('clientes/form', { title: 'Editar Cliente', cliente, errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { nombre, cedula, telefono, email, direccion } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.render('clientes/form', {
      title: 'Editar Cliente',
      cliente: { ...req.body, id: req.params.id },
      errors: ['El nombre es obligatorio']
    });
  }
  db.prepare('UPDATE clientes SET nombre=?, cedula=?, telefono=?, email=?, direccion=? WHERE id=?')
    .run(nombre.trim(), cedula?.trim(), telefono?.trim(), email?.trim(), direccion?.trim(), req.params.id);
  res.flash('success', 'Cliente actualizado');
  res.redirect(`/clientes/${req.params.id}`);
});

// ---------------------------------------------------------------------------
// SOFT-DELETE: archivar cliente (activo = 0)
// ---------------------------------------------------------------------------
router.post('/:id/eliminar', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE clientes SET activo = 0 WHERE id = ?').run(id);
  res.flash('success', 'Cliente archivado');
  audit.registrar({
    usuario: req.session.usuario,
    accion: 'archivar',
    entidad: 'cliente',
    entidad_id: Number(id)
  });
  res.redirect('/clientes');
});

// ---------------------------------------------------------------------------
// RESTAURAR cliente (activo = 1)
// ---------------------------------------------------------------------------
router.post('/:id/restaurar', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE clientes SET activo = 1 WHERE id = ?').run(id);
  res.flash('success', 'Cliente restaurado');
  audit.registrar({
    usuario: req.session.usuario,
    accion: 'restaurar',
    entidad: 'cliente',
    entidad_id: Number(id)
  });
  res.redirect(`/clientes/${id}`);
});

// ---------------------------------------------------------------------------
// HISTORIAL DEL CLIENTE (solo admin)
// ---------------------------------------------------------------------------
router.get('/:id/historial', (req, res) => {
  if (!req.session.usuario || req.session.usuario.rol !== 'admin') {
    return res.status(403).render('partials/error', { title: 'Acceso denegado', message: 'Solo administradores pueden ver el historial de cliente' });
  }

  const id = req.params.id;
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!cliente) return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });

  // Todos los vehiculos del cliente (activos e inactivos) para historial completo
  const vehiculos = db.prepare(`
    SELECT v.*
    FROM vehiculos v
    WHERE v.cliente_id = ?
    ORDER BY v.marca, v.modelo
  `).all(id);

  // Todos los servicios del cliente con info de vehiculo, mecanico y repuestos
  const servicios = db.prepare(`
    SELECT s.*,
           v.placa,
           v.marca,
           v.modelo,
           COALESCE(u.nombre, s.tecnico) AS mecanico_nombre,
           COALESCE((
             SELECT SUM(si.cantidad * si.precio_unitario)
             FROM servicio_items si WHERE si.servicio_id = s.id
           ), 0) AS total_repuestos
    FROM servicios s
    JOIN vehiculos v ON s.vehiculo_id = v.id
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
    WHERE v.cliente_id = ?
    ORDER BY s.fecha DESC
  `).all(id);

  // Todas las cotizaciones del cliente con total
  const cotizaciones = db.prepare(`
    SELECT cot.*,
           v.placa,
           v.marca,
           v.modelo,
           COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS total
    FROM cotizaciones cot
    JOIN vehiculos v ON cot.vehiculo_id = v.id
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
    WHERE v.cliente_id = ?
    GROUP BY cot.id
    ORDER BY cot.fecha DESC
  `).all(id);

  // KPIs del cliente
  const kpiRow = db.prepare(`
    SELECT
      COUNT(DISTINCT v.id)                                          AS total_vehiculos,
      COUNT(DISTINCT s.id)                                          AS total_ordenes,
      MAX(s.fecha)                                                  AS ultima_visita,
      COALESCE(SUM(CASE WHEN s.cobrado = 1
        THEN s.costo + COALESCE((
          SELECT SUM(si2.cantidad * si2.precio_unitario)
          FROM servicio_items si2 WHERE si2.servicio_id = s.id
        ), 0)
        ELSE 0 END), 0)                                             AS total_gastado
    FROM vehiculos v
    LEFT JOIN servicios s ON s.vehiculo_id = v.id
    WHERE v.cliente_id = ?
  `).get(id);

  const kpis = {
    total_vehiculos : kpiRow.total_vehiculos  || 0,
    total_ordenes   : kpiRow.total_ordenes    || 0,
    ultima_visita   : kpiRow.ultima_visita    || null,
    total_gastado   : kpiRow.total_gastado    || 0
  };

  // Construir array de eventos unificados ordenados por fecha DESC
  const eventos = [];

  for (const s of servicios) {
    eventos.push({
      tipo          : 'orden',
      fecha         : s.fecha,
      id            : s.id,
      numero        : s.numero    || null,
      estado        : s.estado,
      mecanico_nombre: s.mecanico_nombre || null,
      total         : s.costo + s.total_repuestos,
      placa         : s.placa,
      resumen       : s.descripcion
    });
  }

  for (const cot of cotizaciones) {
    eventos.push({
      tipo          : 'cotizacion',
      fecha         : cot.fecha,
      id            : cot.id,
      numero        : cot.numero  || null,
      estado        : cot.estado,
      mecanico_nombre: null,
      total         : cot.total,
      placa         : cot.placa,
      resumen       : cot.notas   || null
    });
  }

  // Ordenar por fecha DESC (TEXT 'YYYY-MM-DD HH:MM:SS' ordena correctamente como string)
  eventos.sort((a, b) => {
    const fa = a.fecha || '';
    const fb = b.fecha || '';
    if (fb > fa) return 1;
    if (fb < fa) return -1;
    return 0;
  });

  res.render('clientes/historial', {
    title    : `Historial - ${cliente.nombre}`,
    cliente,
    vehiculos,
    kpis,
    eventos
  });
});

module.exports = router;
