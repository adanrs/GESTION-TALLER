const express = require('express');
const router = express.Router();
const db = require('../db/database');
const audit = require('../lib/auditoria');

// ---------------------------------------------------------------------------
// Marcas ya registradas (para autocompletar en el formulario)
// ---------------------------------------------------------------------------
function getMarcas() {
  return db.prepare("SELECT DISTINCT marca FROM vehiculos WHERE marca IS NOT NULL AND TRIM(marca) != '' ORDER BY marca")
    .all().map(r => r.marca);
}

// ---------------------------------------------------------------------------
// Listar vehiculos
// ?archivados=1  -> muestra solo activo=0
// por defecto    -> muestra solo activo=1
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const buscar     = req.query.buscar    || '';
  const archivados = req.query.archivados === '1';
  const filtroActivo = archivados ? 0 : 1;

  let vehiculos;
  if (buscar) {
    vehiculos = db.prepare(`
      SELECT v.*, c.nombre AS cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id
      WHERE v.activo = ?
        AND (v.placa LIKE ? OR v.marca LIKE ? OR v.modelo LIKE ? OR c.nombre LIKE ?)
      ORDER BY v.marca, v.modelo
    `).all(filtroActivo, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  } else {
    vehiculos = db.prepare(`
      SELECT v.*, c.nombre AS cliente_nombre
      FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id
      WHERE v.activo = ?
      ORDER BY v.marca, v.modelo
    `).all(filtroActivo);
  }

  res.render('vehiculos/index', { title: 'Vehiculos', vehiculos, buscar, archivados });
});

// ---------------------------------------------------------------------------
// Formulario nuevo vehiculo
// Solo clientes activos en el dropdown
// ---------------------------------------------------------------------------
router.get('/crear', (req, res) => {
  const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes WHERE activo = 1 ORDER BY nombre').all();
  res.render('vehiculos/form', {
    title    : 'Nuevo Vehiculo',
    vehiculo : { cliente_id: req.query.cliente_id || '' },
    clientes,
    marcas   : getMarcas(),
    errors   : []
  });
});

// Guardar nuevo vehiculo
router.post('/crear', (req, res) => {
  const { cliente_id, placa, marca, modelo, ano, color, vin, notas } = req.body;
  const errors = [];
  if (!cliente_id)       errors.push('Debe seleccionar un cliente');
  if (!placa?.trim())    errors.push('La placa es obligatoria');
  if (!marca?.trim())    errors.push('La marca es obligatoria');
  if (!modelo?.trim())   errors.push('El modelo es obligatorio');

  if (errors.length) {
    const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes WHERE activo = 1 ORDER BY nombre').all();
    return res.render('vehiculos/form', { title: 'Nuevo Vehiculo', vehiculo: req.body, clientes, marcas: getMarcas(), errors });
  }

  db.prepare('INSERT INTO vehiculos (cliente_id, placa, marca, modelo, ano, color, vin, notas) VALUES (?,?,?,?,?,?,?,?)')
    .run(cliente_id, placa.trim().toUpperCase(), marca.trim(), modelo.trim(), ano || null, color?.trim(), vin?.trim(), notas?.trim());
  res.flash('success', 'Vehiculo registrado');
  res.redirect('/vehiculos');
});

// ---------------------------------------------------------------------------
// Detalle vehiculo
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const vehiculo = db.prepare(`
    SELECT v.*, c.nombre AS cliente_nombre, c.id AS cliente_id
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
    SELECT c.*, COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS total
    FROM cotizaciones c
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = c.id
    WHERE c.vehiculo_id = ?
    GROUP BY c.id
    ORDER BY c.fecha DESC
  `).all(vehiculo.id);

  const fotos = db.prepare(
    'SELECT * FROM fotos WHERE vehiculo_id = ? ORDER BY fecha DESC, id DESC'
  ).all(vehiculo.id);

  res.render('vehiculos/detalle', {
    title      : `${vehiculo.placa} - ${vehiculo.marca} ${vehiculo.modelo}`,
    vehiculo,
    servicios,
    cotizaciones,
    fotos
  });
});

// ---------------------------------------------------------------------------
// Editar vehiculo
// Solo clientes activos en el dropdown
// ---------------------------------------------------------------------------
router.get('/:id/editar', (req, res) => {
  const vehiculo = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(req.params.id);
  if (!vehiculo) return res.status(404).render('partials/error', { title: 'Error', message: 'Vehiculo no encontrado' });
  const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes WHERE activo = 1 ORDER BY nombre').all();
  res.render('vehiculos/form', { title: 'Editar Vehiculo', vehiculo, clientes, marcas: getMarcas(), errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { cliente_id, placa, marca, modelo, ano, color, vin, notas } = req.body;
  const errors = [];
  if (!cliente_id)       errors.push('Debe seleccionar un cliente');
  if (!placa?.trim())    errors.push('La placa es obligatoria');
  if (!marca?.trim())    errors.push('La marca es obligatoria');
  if (!modelo?.trim())   errors.push('El modelo es obligatorio');

  if (errors.length) {
    const clientes = db.prepare('SELECT id, nombre, cedula FROM clientes WHERE activo = 1 ORDER BY nombre').all();
    return res.render('vehiculos/form', { title: 'Editar Vehiculo', vehiculo: { ...req.body, id: req.params.id }, clientes, marcas: getMarcas(), errors });
  }

  db.prepare('UPDATE vehiculos SET cliente_id=?, placa=?, marca=?, modelo=?, ano=?, color=?, vin=?, notas=? WHERE id=?')
    .run(cliente_id, placa.trim().toUpperCase(), marca.trim(), modelo.trim(), ano || null, color?.trim(), vin?.trim(), notas?.trim(), req.params.id);
  res.flash('success', 'Vehiculo actualizado');
  res.redirect(`/vehiculos/${req.params.id}`);
});

// ---------------------------------------------------------------------------
// SOFT-DELETE: archivar vehiculo (activo = 0)
// ---------------------------------------------------------------------------
router.post('/:id/eliminar', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE vehiculos SET activo = 0 WHERE id = ?').run(id);
  res.flash('success', 'Vehiculo archivado');
  audit.registrar({
    usuario   : req.session.usuario,
    accion    : 'archivar',
    entidad   : 'vehiculo',
    entidad_id: Number(id)
  });
  res.redirect('/vehiculos');
});

// ---------------------------------------------------------------------------
// RESTAURAR vehiculo (activo = 1)
// ---------------------------------------------------------------------------
router.post('/:id/restaurar', (req, res) => {
  const id = req.params.id;
  db.prepare('UPDATE vehiculos SET activo = 1 WHERE id = ?').run(id);
  res.flash('success', 'Vehiculo restaurado');
  audit.registrar({
    usuario   : req.session.usuario,
    accion    : 'restaurar',
    entidad   : 'vehiculo',
    entidad_id: Number(id)
  });
  res.redirect(`/vehiculos/${id}`);
});

// ---------------------------------------------------------------------------
// HISTORIAL DEL VEHICULO (accesible a admin y mecanico)
// El middleware global ya restringe /vehiculos a admin EXCEPTO esta ruta.
// ---------------------------------------------------------------------------
router.get('/:id/historial', (req, res) => {
  const id = req.params.id;
  const esMecanico = req.session.usuario && req.session.usuario.rol === 'tecnico';

  const vehiculo = db.prepare(`
    SELECT v.*, c.nombre AS cliente_nombre, c.id AS cliente_id,
           c.telefono AS cliente_telefono, c.email AS cliente_email
    FROM vehiculos v
    JOIN clientes c ON v.cliente_id = c.id
    WHERE v.id = ?
  `).get(id);
  if (!vehiculo) return res.status(404).render('partials/error', { title: 'Error', message: 'Vehiculo no encontrado' });

  // Servicios con mecanico, repuestos, tareas y fotos
  const servicios = db.prepare(`
    SELECT s.*,
           COALESCE(u.nombre, s.tecnico) AS mecanico_nombre,
           COALESCE((
             SELECT SUM(si.cantidad * si.precio_unitario)
             FROM servicio_items si WHERE si.servicio_id = s.id
           ), 0) AS total_repuestos,
           (SELECT COUNT(*) FROM servicio_tareas st WHERE st.servicio_id = s.id)            AS total_tareas,
           (SELECT COUNT(*) FROM servicio_tareas st WHERE st.servicio_id = s.id AND st.completado = 1) AS tareas_completadas,
           (SELECT COUNT(*) FROM fotos f WHERE f.servicio_id = s.id)                         AS total_fotos
    FROM servicios s
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
    WHERE s.vehiculo_id = ?
    ORDER BY s.fecha DESC
  `).all(id);

  // Cotizaciones con total
  const cotizaciones = db.prepare(`
    SELECT cot.*,
           COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS total
    FROM cotizaciones cot
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
    WHERE cot.vehiculo_id = ?
    GROUP BY cot.id
    ORDER BY cot.fecha DESC
  `).all(id);

  // KPIs del vehiculo
  const kpiRow = db.prepare(`
    SELECT
      COUNT(*)                  AS total_ordenes,
      SUM(cobrado)              AS ordenes_cobradas,
      MAX(fecha)                AS ultima_visita,
      MAX(kilometraje)          AS ultimo_km,
      COALESCE(SUM(CASE WHEN cobrado = 1
        THEN costo + COALESCE((
          SELECT SUM(si2.cantidad * si2.precio_unitario)
          FROM servicio_items si2 WHERE si2.servicio_id = servicios.id
        ), 0)
        ELSE 0 END), 0)         AS total_facturado
    FROM servicios
    WHERE vehiculo_id = ?
  `).get(id);

  const kpis = {
    total_ordenes   : kpiRow.total_ordenes    || 0,
    ordenes_cobradas: kpiRow.ordenes_cobradas || 0,
    ultima_visita   : kpiRow.ultima_visita    || null,
    ultimo_km       : kpiRow.ultimo_km        || null,
    // Ocultar montos al mecanico
    total_facturado : esMecanico ? null : (kpiRow.total_facturado || 0)
  };

  // Construir array de eventos unificados
  const eventos = [];

  for (const s of servicios) {
    eventos.push({
      tipo            : 'orden',
      fecha           : s.fecha,
      id              : s.id,
      numero          : s.numero          || null,
      estado          : s.estado,
      mecanico_nombre : s.mecanico_nombre || null,
      // Ocultar montos al mecanico
      total           : esMecanico ? null : (s.costo + s.total_repuestos),
      placa           : vehiculo.placa,
      resumen         : s.descripcion
    });
  }

  for (const cot of cotizaciones) {
    eventos.push({
      tipo            : 'cotizacion',
      fecha           : cot.fecha,
      id              : cot.id,
      numero          : cot.numero        || null,
      estado          : cot.estado,
      mecanico_nombre : null,
      // Ocultar montos al mecanico
      total           : esMecanico ? null : cot.total,
      placa           : vehiculo.placa,
      resumen         : cot.notas         || null
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

  res.render('vehiculos/historial', {
    title  : `Historial - ${vehiculo.placa} ${vehiculo.marca} ${vehiculo.modelo}`,
    vehiculo,
    kpis,
    eventos
  });
});

module.exports = router;
