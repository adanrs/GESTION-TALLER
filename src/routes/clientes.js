const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const audit = require('../lib/auditoria');
const mailer = require('../lib/mailer');

// ---------------------------------------------------------------------------
// Guard: solo encargado (admin)
// ---------------------------------------------------------------------------
function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Solo el encargado puede realizar esta accion.'
    });
  }
  next();
}

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

  // Cuenta de portal del cliente (puede ser undefined si no existe)
  const portalCuenta = db.prepare(
    "SELECT id, usuario, activo FROM usuarios WHERE cliente_id = ? AND rol = 'cliente'"
  ).get(cliente.id);

  res.render('clientes/detalle', { title: cliente.nombre, cliente, vehiculos, portalCuenta });
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

// ---------------------------------------------------------------------------
// PORTAL DEL CLIENTE
// ---------------------------------------------------------------------------

// POST /:id/portal/habilitar — crea o reactiva la cuenta y envia invitacion
router.post('/:id/portal/habilitar', soloAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const base = process.env.APP_URL || ('http://localhost:' + (process.env.PORT || 3000));

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!cliente) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });
  }

  if (!cliente.activo) {
    res.flash('danger', 'El cliente debe estar activo para habilitar el portal');
    return res.redirect('/clientes/' + id);
  }

  const email = (cliente.email || '').trim();
  if (!email) {
    res.flash('danger', 'El cliente debe tener correo para habilitar el portal');
    return res.redirect('/clientes/' + id);
  }

  // Verificar colision de correo con otra cuenta
  const cuentaExistente = db.prepare("SELECT * FROM usuarios WHERE usuario = ?").get(email);

  if (cuentaExistente) {
    if (cuentaExistente.rol === 'cliente' && cuentaExistente.cliente_id === id) {
      // Reactivar la misma cuenta y reenviar invitacion (cae al bloque de generacion de token)
      db.prepare('UPDATE usuarios SET activo = 1 WHERE id = ?').run(cuentaExistente.id);
    } else {
      res.flash('danger', 'Ese correo ya esta en uso por otra cuenta');
      return res.redirect('/clientes/' + id);
    }
  } else {
    // Crear nueva cuenta con clave inutilizable (el cliente la define por token)
    const passHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
    db.prepare(
      "INSERT INTO usuarios (nombre, usuario, password, email, rol, cliente_id, activo) VALUES (?, ?, ?, ?, 'cliente', ?, 1)"
    ).run(cliente.nombre, email, passHash, email, id);
  }

  // Obtener el id del usuario (recien creado o ya existente)
  const usuario = db.prepare("SELECT id FROM usuarios WHERE usuario = ? AND rol = 'cliente' AND cliente_id = ?").get(email, id);

  // Invalidar tokens previos
  db.prepare('UPDATE password_resets SET usado = 1 WHERE usuario_id = ? AND usado = 0').run(usuario.id);

  // Generar nuevo token (72 h)
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO password_resets (usuario_id, token, expira, usado) VALUES (?, ?, ?, 0)')
    .run(usuario.id, token, expira);

  // Enviar correo con enlace para definir contrasena
  const enlace = base + '/auth/reset/' + token;
  try {
    await mailer.enviarCorreo({
      to: email,
      subject: 'Acceso al portal - Gestion Taller',
      text:
        'Hola ' + cliente.nombre + ',\n\n' +
        'Se ha habilitado su acceso al portal del taller. Para definir su contrasena haga clic en el siguiente enlace:\n\n' +
        enlace + '\n\n' +
        'Este enlace vence en 72 horas.\n\n' +
        'Si no solicitó este acceso, puede ignorar este mensaje.',
      html:
        '<p>Hola <strong>' + cliente.nombre + '</strong>,</p>' +
        '<p>Se ha habilitado su acceso al portal del taller. Para definir su contrasena haga clic aqui:</p>' +
        '<p><a href="' + enlace + '">' + enlace + '</a></p>' +
        '<p>Este enlace vence en <strong>72 horas</strong>.</p>' +
        '<p>Si no solicito este acceso puede ignorar este mensaje.</p>'
    });
    res.flash('success', 'Portal habilitado. Se envio el correo de invitacion a ' + email);
  } catch (err) {
    res.flash('warning', 'Portal habilitado pero no se pudo enviar el correo: ' + err.message);
  }

  audit.registrar({
    usuario: req.session.usuario,
    accion: 'habilitar_portal',
    entidad: 'cliente',
    entidad_id: id
  });

  return res.redirect('/clientes/' + id);
});

// POST /:id/portal/deshabilitar — desactiva la cuenta del portal
router.post('/:id/portal/deshabilitar', soloAdmin, (req, res) => {
  const id = Number(req.params.id);

  db.prepare("UPDATE usuarios SET activo = 0 WHERE cliente_id = ? AND rol = 'cliente'").run(id);

  audit.registrar({
    usuario: req.session.usuario,
    accion: 'deshabilitar_portal',
    entidad: 'cliente',
    entidad_id: id
  });

  res.flash('success', 'Acceso al portal deshabilitado');
  return res.redirect('/clientes/' + id);
});

// POST /:id/portal/reenviar — invalida tokens previos y reenvia correo de invitacion
router.post('/:id/portal/reenviar', soloAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const base = process.env.APP_URL || ('http://localhost:' + (process.env.PORT || 3000));

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!cliente) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Cliente no encontrado' });
  }

  const cuenta = db.prepare("SELECT id FROM usuarios WHERE cliente_id = ? AND rol = 'cliente'").get(id);
  if (!cuenta) {
    res.flash('danger', 'Este cliente no tiene portal habilitado');
    return res.redirect('/clientes/' + id);
  }

  const email = (cliente.email || '').trim();

  // Invalidar tokens previos
  db.prepare('UPDATE password_resets SET usado = 1 WHERE usuario_id = ? AND usado = 0').run(cuenta.id);

  // Generar nuevo token (72 h)
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO password_resets (usuario_id, token, expira, usado) VALUES (?, ?, ?, 0)')
    .run(cuenta.id, token, expira);

  const enlace = base + '/auth/reset/' + token;
  try {
    await mailer.enviarCorreo({
      to: email,
      subject: 'Acceso al portal - Gestion Taller (reenvio)',
      text:
        'Hola ' + cliente.nombre + ',\n\n' +
        'Se ha generado un nuevo enlace para acceder al portal del taller:\n\n' +
        enlace + '\n\n' +
        'Este enlace vence en 72 horas.',
      html:
        '<p>Hola <strong>' + cliente.nombre + '</strong>,</p>' +
        '<p>Se ha generado un nuevo enlace para acceder al portal:</p>' +
        '<p><a href="' + enlace + '">' + enlace + '</a></p>' +
        '<p>Este enlace vence en <strong>72 horas</strong>.</p>'
    });
    res.flash('success', 'Correo de acceso reenviado a ' + email);
  } catch (err) {
    res.flash('warning', 'Token generado pero no se pudo enviar el correo: ' + err.message);
  }

  audit.registrar({
    usuario: req.session.usuario,
    accion: 'reenviar_portal',
    entidad: 'cliente',
    entidad_id: id
  });

  return res.redirect('/clientes/' + id);
});

module.exports = router;
