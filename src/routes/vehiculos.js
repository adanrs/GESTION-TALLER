const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Marcas ya registradas (para autocompletar en el formulario)
function getMarcas() {
  return db.prepare("SELECT DISTINCT marca FROM vehiculos WHERE marca IS NOT NULL AND TRIM(marca) != '' ORDER BY marca")
    .all().map(r => r.marca);
}

// Listar vehiculos
router.get('/', (req, res) => {
  const buscar = req.query.buscar || '';
  let vehiculos;
  if (buscar) {
    vehiculos = db.prepare(`
      SELECT v.*, c.nombre as cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id
      WHERE v.placa LIKE ? OR v.marca LIKE ? OR v.modelo LIKE ? OR c.nombre LIKE ?
      ORDER BY v.marca, v.modelo
    `).all(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  } else {
    vehiculos = db.prepare(`
      SELECT v.*, c.nombre as cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id
      ORDER BY v.marca, v.modelo
    `).all();
  }
  res.render('vehiculos/index', { title: 'Vehiculos', vehiculos, buscar });
});

// Formulario nuevo vehiculo
router.get('/crear', (req, res) => {
  const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes ORDER BY nombre').all();
  res.render('vehiculos/form', {
    title: 'Nuevo Vehiculo',
    vehiculo: { cliente_id: req.query.cliente_id || '' },
    clientes,
    marcas: getMarcas(),
    errors: []
  });
});

// Guardar nuevo
router.post('/crear', (req, res) => {
  const { cliente_id, placa, marca, modelo, ano, color, vin, notas } = req.body;
  const errors = [];
  if (!cliente_id) errors.push('Debe seleccionar un cliente');
  if (!placa?.trim()) errors.push('La placa es obligatoria');
  if (!marca?.trim()) errors.push('La marca es obligatoria');
  if (!modelo?.trim()) errors.push('El modelo es obligatorio');

  if (errors.length) {
    const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes ORDER BY nombre').all();
    return res.render('vehiculos/form', { title: 'Nuevo Vehiculo', vehiculo: req.body, clientes, marcas: getMarcas(), errors });
  }

  db.prepare('INSERT INTO vehiculos (cliente_id, placa, marca, modelo, ano, color, vin, notas) VALUES (?,?,?,?,?,?,?,?)')
    .run(cliente_id, placa.trim().toUpperCase(), marca.trim(), modelo.trim(), ano || null, color?.trim(), vin?.trim(), notas?.trim());
  res.flash('success', 'Vehiculo registrado');
  res.redirect('/vehiculos');
});

// Detalle vehiculo
router.get('/:id', (req, res) => {
  const vehiculo = db.prepare(`
    SELECT v.*, c.nombre as cliente_nombre, c.id as cliente_id
    FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id
    WHERE v.id = ?
  `).get(req.params.id);
  if (!vehiculo) return res.status(404).render('partials/error', { title: 'Error', message: 'Vehiculo no encontrado' });

  const servicios = db.prepare(`
    SELECT s.*,
           COALESCE(u.nombre, s.tecnico) AS mecanico_nombre,
           COALESCE((
             SELECT SUM(si.cantidad * si.precio_unitario)
             FROM servicio_items si WHERE si.servicio_id = s.id
           ), 0) AS total_repuestos
    FROM servicios s
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
    WHERE s.vehiculo_id = ?
    ORDER BY s.fecha DESC
  `).all(vehiculo.id);
  const cotizaciones = db.prepare(`
    SELECT c.*, COALESCE(SUM(d.cantidad * d.precio_unitario), 0) as total
    FROM cotizaciones c
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = c.id
    WHERE c.vehiculo_id = ?
    GROUP BY c.id
    ORDER BY c.fecha DESC
  `).all(vehiculo.id);

  res.render('vehiculos/detalle', { title: `${vehiculo.placa} - ${vehiculo.marca} ${vehiculo.modelo}`, vehiculo, servicios, cotizaciones });
});

// Editar
router.get('/:id/editar', (req, res) => {
  const vehiculo = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(req.params.id);
  if (!vehiculo) return res.status(404).render('partials/error', { title: 'Error', message: 'Vehiculo no encontrado' });
  const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes ORDER BY nombre').all();
  res.render('vehiculos/form', { title: 'Editar Vehiculo', vehiculo, clientes, marcas: getMarcas(), errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { cliente_id, placa, marca, modelo, ano, color, vin, notas } = req.body;
  const errors = [];
  if (!cliente_id) errors.push('Debe seleccionar un cliente');
  if (!placa?.trim()) errors.push('La placa es obligatoria');
  if (!marca?.trim()) errors.push('La marca es obligatoria');
  if (!modelo?.trim()) errors.push('El modelo es obligatorio');

  if (errors.length) {
    const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes ORDER BY nombre').all();
    return res.render('vehiculos/form', { title: 'Editar Vehiculo', vehiculo: { ...req.body, id: req.params.id }, clientes, marcas: getMarcas(), errors });
  }

  db.prepare('UPDATE vehiculos SET cliente_id=?, placa=?, marca=?, modelo=?, ano=?, color=?, vin=?, notas=? WHERE id=?')
    .run(cliente_id, placa.trim().toUpperCase(), marca.trim(), modelo.trim(), ano || null, color?.trim(), vin?.trim(), notas?.trim(), req.params.id);
  res.flash('success', 'Vehiculo actualizado');
  res.redirect(`/vehiculos/${req.params.id}`);
});

router.post('/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM vehiculos WHERE id = ?').run(req.params.id);
  res.flash('success', 'Vehiculo eliminado');
  res.redirect('/vehiculos');
});

module.exports = router;
