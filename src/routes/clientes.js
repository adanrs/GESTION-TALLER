const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Listar clientes
router.get('/', (req, res) => {
  const buscar = req.query.buscar || '';
  let clientes;
  if (buscar) {
    clientes = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM vehiculos WHERE cliente_id = c.id) as total_vehiculos
      FROM clientes c
      WHERE c.nombre LIKE ? OR c.cedula LIKE ? OR c.telefono LIKE ?
      ORDER BY c.nombre
    `).all(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  } else {
    clientes = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM vehiculos WHERE cliente_id = c.id) as total_vehiculos
      FROM clientes c ORDER BY c.nombre
    `).all();
  }
  res.render('clientes/index', { title: 'Clientes', clientes, buscar });
});

// Formulario nuevo cliente
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

// Ver detalle de cliente
router.get('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });

  const vehiculos = db.prepare('SELECT * FROM vehiculos WHERE cliente_id = ? ORDER BY marca, modelo').all(cliente.id);
  res.render('clientes/detalle', { title: cliente.nombre, cliente, vehiculos });
});

// Formulario editar
router.get('/:id/editar', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });
  res.render('clientes/form', { title: 'Editar Cliente', cliente, errors: [] });
});

// Guardar edicion
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

// Eliminar
router.post('/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM clientes WHERE id = ?').run(req.params.id);
  res.flash('success', 'Cliente eliminado');
  res.redirect('/clientes');
});

module.exports = router;
