const express = require('express');
const router = express.Router();
const db = require('../db/database');

function parseItems(body) {
  const items = [];
  if (!body.item_tipo) return items;
  const tipos = Array.isArray(body.item_tipo) ? body.item_tipo : [body.item_tipo];
  const descs = Array.isArray(body.item_descripcion) ? body.item_descripcion : [body.item_descripcion];
  const cants = Array.isArray(body.item_cantidad) ? body.item_cantidad : [body.item_cantidad];
  const precios = Array.isArray(body.item_precio) ? body.item_precio : [body.item_precio];
  for (let i = 0; i < tipos.length; i++) {
    if (descs[i]?.trim()) {
      items.push({
        tipo: tipos[i] || 'Repuesto',
        descripcion: descs[i].trim(),
        cantidad: parseFloat(cants[i]) || 1,
        precio_unitario: parseFloat(precios[i]) || 0
      });
    }
  }
  return items;
}

// Listar servicios
router.get('/', (req, res) => {
  const estado = req.query.estado || '';
  const buscar = req.query.buscar || '';
  let query = `
    SELECT s.*, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre,
    COALESCE((SELECT SUM(si.cantidad * si.precio_unitario) FROM servicio_items si WHERE si.servicio_id = s.id), 0) as total_items
    FROM servicios s
    JOIN vehiculos v ON s.vehiculo_id = v.id
    JOIN clientes c ON v.cliente_id = c.id
  `;
  const params = [];
  const conditions = [];

  if (estado) {
    conditions.push('s.estado = ?');
    params.push(estado);
  }
  if (buscar) {
    conditions.push('(v.placa LIKE ? OR c.nombre LIKE ? OR s.descripcion LIKE ?)');
    params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.fecha DESC';

  const servicios = db.prepare(query).all(...params);
  res.render('servicios/index', { title: 'Servicios', servicios, estado, buscar });
});

// Crear servicio
router.get('/crear', (req, res) => {
  const vehiculos = db.prepare(`
    SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
    FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa
  `).all();
  res.render('servicios/form', {
    title: 'Nuevo Servicio',
    servicio: { vehiculo_id: req.query.vehiculo_id || '', items: [] },
    vehiculos,
    errors: []
  });
});

router.post('/crear', (req, res) => {
  const { vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas } = req.body;
  const items = parseItems(req.body);
  const errors = [];
  if (!vehiculo_id) errors.push('Debe seleccionar un vehiculo');
  if (!descripcion?.trim()) errors.push('La descripcion es obligatoria');

  if (errors.length) {
    const vehiculos = db.prepare(`
      SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa
    `).all();
    return res.render('servicios/form', { title: 'Nuevo Servicio', servicio: { ...req.body, items }, vehiculos, errors });
  }

  const insertServ = db.prepare('INSERT INTO servicios (vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas) VALUES (?,?,?,?,?,?,?)');
  const insertItem = db.prepare('INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    const result = insertServ.run(vehiculo_id, descripcion.trim(), kilometraje || null, tecnico?.trim(), estado || 'Pendiente', costo || 0, notas?.trim());
    const servId = result.lastInsertRowid;
    for (const it of items) {
      insertItem.run(servId, it.tipo, it.descripcion, it.cantidad, it.precio_unitario);
    }
  })();

  res.flash('success', 'Servicio registrado');
  res.redirect('/servicios');
});

// Detalle
router.get('/:id', (req, res) => {
  const servicio = db.prepare(`
    SELECT s.*, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre, v.id as vehiculo_id
    FROM servicios s
    JOIN vehiculos v ON s.vehiculo_id = v.id
    JOIN clientes c ON v.cliente_id = c.id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!servicio) return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });

  const items = db.prepare('SELECT * FROM servicio_items WHERE servicio_id = ?').all(servicio.id);
  const totalItems = items.reduce((sum, i) => sum + i.cantidad * i.precio_unitario, 0);
  res.render('servicios/detalle', { title: 'Servicio', servicio, items, totalItems });
});

router.get('/:id/editar', (req, res) => {
  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(req.params.id);
  if (!servicio) return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  servicio.items = db.prepare('SELECT * FROM servicio_items WHERE servicio_id = ?').all(servicio.id);
  const vehiculos = db.prepare(`
    SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
    FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa
  `).all();
  res.render('servicios/form', { title: 'Editar Servicio', servicio, vehiculos, errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas } = req.body;
  const items = parseItems(req.body);
  const errors = [];
  if (!vehiculo_id) errors.push('Debe seleccionar un vehiculo');
  if (!descripcion?.trim()) errors.push('La descripcion es obligatoria');

  if (errors.length) {
    const vehiculos = db.prepare(`
      SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa
    `).all();
    return res.render('servicios/form', { title: 'Editar Servicio', servicio: { ...req.body, id: req.params.id, items }, vehiculos, errors });
  }

  const updateServ = db.prepare('UPDATE servicios SET vehiculo_id=?, descripcion=?, kilometraje=?, tecnico=?, estado=?, costo=?, notas=? WHERE id=?');
  const deleteItems = db.prepare('DELETE FROM servicio_items WHERE servicio_id=?');
  const insertItem = db.prepare('INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');

  db.transaction(() => {
    updateServ.run(vehiculo_id, descripcion.trim(), kilometraje || null, tecnico?.trim(), estado, costo || 0, notas?.trim(), req.params.id);
    deleteItems.run(req.params.id);
    for (const it of items) {
      insertItem.run(req.params.id, it.tipo, it.descripcion, it.cantidad, it.precio_unitario);
    }
  })();

  res.flash('success', 'Servicio actualizado');
  res.redirect(`/servicios/${req.params.id}`);
});

router.post('/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM servicios WHERE id = ?').run(req.params.id);
  res.flash('success', 'Servicio eliminado');
  res.redirect('/servicios');
});

module.exports = router;
