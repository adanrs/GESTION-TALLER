const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const db = require('../db/database');
const estados = require('../lib/estados');
const audit   = require('../lib/auditoria');

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

// Estados validos de una orden: delegamos a la fuente de verdad centralizada
const ESTADOS_VALIDOS = estados.ESTADOS_ORDEN;

// ---------------------------------------------------------------------------
// HELPERS DE NEGOCIO
// ---------------------------------------------------------------------------

/**
 * Genera el numero de folio para una nueva orden de taller.
 * Formato: OT-YYYYNNNN  (ej. OT-20260001)
 * La secuencia reinicia por anio y se basa en el ultimo id registrado ese anio.
 */
function generarNumeroOrden() {
  const year = new Date().getFullYear();
  const last = db
    .prepare('SELECT numero FROM servicios WHERE numero LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`OT-${year}%`);
  let seq = 1;
  if (last) {
    // numero tiene forma OT-YYYYNNNN -> los 4 ultimos chars de la parte tras el guion son la secuencia
    const parte = last.numero.slice(3); // "YYYYNNNN"
    seq = parseInt(parte.slice(4), 10) + 1;
  }
  return `OT-${year}${String(seq).padStart(4, '0')}`;
}

/**
 * Calcula el total de una orden: costo (mano de obra) + suma de items.
 * Devuelve un numero >= 0.
 */
function calcularTotalOrden(servId, costoServicio) {
  const row = db
    .prepare('SELECT COALESCE(SUM(cantidad * precio_unitario), 0) AS total_items FROM servicio_items WHERE servicio_id = ?')
    .get(servId);
  return (parseFloat(costoServicio) || 0) + (row ? row.total_items : 0);
}

/**
 * Devuelve true si el usuario puede operar sobre la orden:
 *   - Es admin (encargado), O
 *   - Es tecnico Y la orden le esta asignada.
 *
 * @param {object} servicio  - Fila de la tabla servicios (debe tener mecanico_id).
 * @param {object} usuario   - req.session.usuario ({id, rol, ...}).
 */
function puedeOperarOrden(servicio, usuario) {
  if (!usuario) return false;
  if (usuario.rol === 'admin') return true;
  return usuario.rol === 'tecnico' && servicio.mecanico_id === usuario.id;
}

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
 * Obtiene la lista de vehiculos ACTIVOS con cliente para pasar a los formularios.
 * Los vehiculos con activo=0 (archivados) no aparecen en el dropdown.
 */
function getVehiculos() {
  return db.prepare(`
    SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
    FROM vehiculos v
    JOIN clientes c ON v.cliente_id = c.id
    WHERE v.activo = 1
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

  const numero = generarNumeroOrden();

  const insertServ = db.prepare(
    'INSERT INTO servicios (numero, vehiculo_id, descripcion, kilometraje, tecnico, estado, costo, notas, mecanico_id) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insertItem  = db.prepare('INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
  const insertTarea = db.prepare('INSERT INTO servicio_tareas (servicio_id, descripcion, completado, orden) VALUES (?,?,0,?)');

  let servId;
  db.transaction(() => {
    const result = insertServ.run(
      numero, vehiculo_id, descripcion.trim(), kilometraje || null,
      tecnico?.trim(), estadoFinal, costo || 0, notas?.trim(), mecanico_id
    );
    servId = result.lastInsertRowid;
    for (const it of items) {
      insertItem.run(servId, it.tipo, it.descripcion, it.cantidad, it.precio_unitario);
    }
    for (let i = 0; i < tareas.length; i++) {
      insertTarea.run(servId, tareas[i], i);
    }
  })();

  audit.registrar({
    usuario:         req.session.usuario,
    accion:          'crear',
    entidad:         'servicio',
    entidad_id:      servId,
    estado_anterior: null,
    estado_nuevo:    estadoFinal,
    detalle:         `Orden ${numero} creada`
  });

  res.flash('success', `Orden ${numero} registrada`);
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

  const fotos = db.prepare(
    'SELECT * FROM fotos WHERE servicio_id = ? ORDER BY fecha DESC, id DESC'
  ).all(servicio.id);

  res.render('servicios/detalle', {
    title: 'Servicio',
    servicio,
    items,
    totalItems,
    tareas,
    totalTareas,
    tareasCompletadas,
    comentarios,
    fotos
  });
});

// ---------------------------------------------------------------------------
// PDF GET /:id/pdf  (admin siempre; tecnico solo si es su orden)
// ---------------------------------------------------------------------------
router.get('/:id/pdf', (req, res) => {
  const usuario = req.session.usuario;

  // Cargar orden con vehiculo y cliente completos
  const servicio = db.prepare(`
    SELECT s.*,
           v.placa, v.marca, v.modelo, v.ano, v.color, v.vin,
           c.nombre  AS cliente_nombre, c.cedula, c.telefono AS cliente_telefono, c.email AS cliente_email,
           u.nombre  AS mecanico_nombre
    FROM servicios s
    JOIN vehiculos  v ON s.vehiculo_id = v.id
    JOIN clientes   c ON v.cliente_id  = c.id
    LEFT JOIN usuarios u ON s.mecanico_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  if (!puedeOperarOrden(servicio, usuario)) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para imprimir esta orden.'
    });
  }

  const items  = db.prepare('SELECT * FROM servicio_items  WHERE servicio_id = ? ORDER BY id').all(servicio.id);
  const tareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY orden, id').all(servicio.id);

  // Config del taller
  const cfgRows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const cfg = {};
  cfgRows.forEach(r => (cfg[r.clave] = r.valor));

  const esAdmin = usuario?.rol === 'admin';
  const folio   = servicio.numero || ('#' + servicio.id);

  // ── Construccion del PDF ──────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  const L = 50, R = 562, W = R - L;

  // Helper: linea separadora horizontal
  function hline(y, color, weight) {
    doc.moveTo(L, y).lineTo(R, y).lineWidth(weight || 1).strokeColor(color || '#cccccc').stroke();
    doc.lineWidth(1).strokeColor('#000000');
  }

  // ── ENCABEZADO: taller (izq) + titulo orden (der) ────────────────────────
  doc.fontSize(17).font('Helvetica-Bold').fillColor('#000000')
     .text(cfg.nombre_taller || 'Taller Mecanico', L, 50, { width: W / 2 });

  doc.fontSize(9).font('Helvetica').fillColor('#000000');
  let hy = 72;
  if (cfg.direccion_taller) { doc.text(cfg.direccion_taller, L, hy); hy += 12; }
  if (cfg.telefono_taller)  { doc.text('Tel: ' + cfg.telefono_taller, L, hy); hy += 12; }
  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366')
       .text('WhatsApp: ' + cfg.whatsapp_taller, L, hy, {
         link: 'https://wa.me/' + cfg.whatsapp_taller, underline: true
       });
    doc.fillColor('#000000');
    hy += 12;
  }
  if (cfg.email_taller) {
    doc.fillColor('#0066cc')
       .text(cfg.email_taller, L, hy, { link: 'mailto:' + cfg.email_taller, underline: true });
    doc.fillColor('#000000');
    hy += 12;
  }

  // Columna derecha: identificacion de la orden
  const rx = L + W / 2 + 20;
  const rw = W / 2 - 20;
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#000000')
     .text('ORDEN DE SERVICIO', rx, 50, { width: rw, align: 'right' });
  doc.fontSize(10).font('Helvetica').fillColor('#000000');
  doc.text('Folio: ' + folio,                                              rx, 76,  { width: rw, align: 'right' });
  doc.text('Fecha: ' + (servicio.fecha ? servicio.fecha.substring(0, 10) : ''), rx, 89,  { width: rw, align: 'right' });
  doc.text('Estado: ' + (servicio.estado || ''),                           rx, 102, { width: rw, align: 'right' });
  if (servicio.kilometraje) {
    doc.text('Kilometraje: ' + servicio.kilometraje + ' km',               rx, 115, { width: rw, align: 'right' });
  }

  // Divisor
  const divY = Math.max(hy, 128) + 10;
  hline(divY, '#333333', 2);

  // ── CLIENTE + VEHICULO: 2 columnas ────────────────────────────────────────
  let infoY = divY + 12;

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#444444').text('CLIENTE', L, infoY);
  doc.fillColor('#000000');
  infoY += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text(servicio.cliente_nombre || '', L, infoY); infoY += 12;
  if (servicio.cedula)           { doc.text('Cedula: ' + servicio.cedula,                   L, infoY); infoY += 12; }
  if (servicio.cliente_telefono) { doc.text('Tel: '   + servicio.cliente_telefono,           L, infoY); infoY += 12; }
  if (servicio.cliente_email)    { doc.text('Email: ' + servicio.cliente_email,              L, infoY); infoY += 12; }

  let vy = divY + 12;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#444444').text('VEHICULO', rx, vy, { width: rw });
  doc.fillColor('#000000');
  vy += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text('Placa: ' + (servicio.placa || ''), rx, vy, { width: rw }); vy += 12;
  doc.text((servicio.marca || '') + ' ' + (servicio.modelo || '') + (servicio.ano ? ' (' + servicio.ano + ')' : ''), rx, vy, { width: rw }); vy += 12;
  if (servicio.color) { doc.text('Color: ' + servicio.color, rx, vy, { width: rw }); vy += 12; }
  if (servicio.vin)   { doc.text('VIN: '   + servicio.vin,   rx, vy, { width: rw }); vy += 12; }

  // Fila de mecanico y descripcion debajo de las columnas
  let bodyY = Math.max(infoY, vy) + 10;
  hline(bodyY, '#cccccc');
  bodyY += 8;

  const mecNombre = servicio.mecanico_nombre || servicio.tecnico || 'Sin asignar';
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#444444').text('Mecanico asignado: ', L, bodyY, { continued: true });
  doc.font('Helvetica').fillColor('#000000').text(mecNombre);
  bodyY += 14;

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#444444').text('Descripcion del trabajo: ', L, bodyY, { continued: true });
  doc.font('Helvetica').fillColor('#000000').text(servicio.descripcion || '', { width: W });
  bodyY = doc.y + 10;

  // ── SECCION: TAREAS ────────────────────────────────────────────────────────
  hline(bodyY, '#333333', 1.5);
  bodyY += 8;
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#222222').text('TAREAS', L, bodyY);
  bodyY += 16;

  if (tareas.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#888888').text('Sin tareas registradas.', L, bodyY);
    bodyY += 14;
  } else {
    doc.fontSize(9).font('Helvetica').fillColor('#000000');
    tareas.forEach(function(t, idx) {
      if (bodyY > 680) { doc.addPage(); bodyY = 50; }
      // Checkbox visual: cuadrado relleno si completada
      if (t.completado) {
        doc.rect(L, bodyY, 9, 9).fill('#333333');
        // tilde blanca
        doc.fillColor('#ffffff').fontSize(7).text('v', L + 1, bodyY + 1);
        doc.fillColor('#000000').fontSize(9);
      } else {
        doc.rect(L, bodyY, 9, 9).stroke('#888888');
      }
      // Cebra leve
      if (idx % 2 === 0) {
        doc.rect(L + 12, bodyY - 1, W - 12, 13).fill('#f5f5f5');
        doc.fillColor('#000000');
      }
      const estado_tarea = t.completado ? 'Hecha' : 'Pendiente';
      doc.text(t.descripcion, L + 14, bodyY, { width: W - 14 - (t.completado ? 130 : 70) });
      // estado a la derecha
      doc.fillColor(t.completado ? '#2d6a4f' : '#888888')
         .text(estado_tarea, R - 120, bodyY, { width: 120, align: 'right' });
      doc.fillColor('#000000');
      bodyY += 14;
      // quien/cuando si completada
      if (t.completado && (t.tecnico || t.fecha_completado)) {
        doc.fontSize(8).fillColor('#555555')
           .text(
             'por ' + (t.tecnico || 'N/A') + (t.fecha_completado ? ' — ' + t.fecha_completado : ''),
             L + 14, bodyY, { width: W - 14 }
           );
        doc.fontSize(9).fillColor('#000000');
        bodyY += 12;
      }
    });
  }
  bodyY += 6;

  // ── SECCION: REPUESTOS / MATERIALES ────────────────────────────────────────
  hline(bodyY, '#333333', 1.5);
  bodyY += 8;
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#222222').text('REPUESTOS / MATERIALES', L, bodyY);
  bodyY += 16;

  if (items.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#888888').text('Sin repuestos ni materiales registrados.', L, bodyY);
    bodyY += 14;
  } else {
    // Encabezado de tabla
    const col = esAdmin
      ? { tipo: L, desc: L + 70, cant: 360, pUnit: 415, sub: 490 }
      : { tipo: L, desc: L + 70, cant: R - 60 };

    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
    doc.text('#',    L - 5,      bodyY, { width: 20,  align: 'right' });
    doc.text('TIPO', col.tipo,   bodyY, { width: 65 });
    doc.text('DESCRIPCION', col.desc, bodyY, { width: esAdmin ? 280 : W - 80 });
    doc.text('CANT', col.cant,   bodyY, { width: 45, align: 'right' });
    if (esAdmin) {
      doc.text('P. UNIT.', col.pUnit, bodyY, { width: 65, align: 'right' });
      doc.text('SUBTOTAL', col.sub,   bodyY, { width: 72, align: 'right' });
    }
    doc.fillColor('#000000');
    bodyY += 14;
    hline(bodyY, '#cccccc');
    bodyY += 4;

    doc.font('Helvetica').fontSize(9);
    items.forEach(function(it, idx) {
      if (bodyY > 680) { doc.addPage(); bodyY = 50; }
      if (idx % 2 === 0) {
        doc.rect(L - 5, bodyY - 2, W + 5, 16).fill('#f8f8f8');
        doc.fillColor('#000000');
      }
      doc.text(String(idx + 1), L - 5,    bodyY, { width: 20,  align: 'right' });
      doc.text(it.tipo,         col.tipo,  bodyY, { width: 65 });
      doc.text(it.descripcion,  col.desc,  bodyY, { width: esAdmin ? 280 : W - 80 });
      doc.text(String(it.cantidad), col.cant, bodyY, { width: 45, align: 'right' });
      if (esAdmin) {
        const fmt = function(n) {
          return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        };
        doc.text(fmt(it.precio_unitario),           col.pUnit, bodyY, { width: 65, align: 'right' });
        doc.text(fmt(it.cantidad * it.precio_unitario), col.sub, bodyY, { width: 72, align: 'right' });
      }
      bodyY += 16;
    });

    // Totales: solo admin
    if (esAdmin) {
      bodyY += 4;
      hline(bodyY, '#333333', 1.5);
      bodyY += 8;

      const fmt = function(n) {
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      };
      const totalItems = items.reduce(function(s, it) { return s + it.cantidad * it.precio_unitario; }, 0);
      const costoMO    = parseFloat(servicio.costo) || 0;
      const totalFinal = totalItems + costoMO;

      const totX  = 350;
      const totVX = col.sub;

      doc.fontSize(9).font('Helvetica').fillColor('#000000');
      doc.text('Total repuestos:',  totX, bodyY, { width: 130, align: 'right' });
      doc.text(fmt(totalItems),     totVX, bodyY, { width: 72, align: 'right' });
      bodyY += 14;

      doc.text('Mano de obra:',     totX, bodyY, { width: 130, align: 'right' });
      doc.text(fmt(costoMO),        totVX, bodyY, { width: 72, align: 'right' });
      bodyY += 14;

      doc.rect(totX - 5, bodyY - 2, R - totX + 5, 22).fill('#1a1a2e');
      doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
      doc.text('TOTAL:', totX, bodyY + 2, { width: 130, align: 'right' });
      doc.text(fmt(totalFinal), totVX, bodyY + 2, { width: 72, align: 'right' });
      doc.fillColor('#000000');
      bodyY += 28;
    }
  }

  // ── NOTAS ──────────────────────────────────────────────────────────────────
  if (servicio.notas) {
    bodyY += 4;
    hline(bodyY, '#cccccc');
    bodyY += 8;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#444444').text('Notas:', L, bodyY);
    bodyY += 12;
    doc.font('Helvetica').fillColor('#000000').text(servicio.notas, L, bodyY, { width: W });
    bodyY = doc.y + 10;
  }

  // ── FOOTER ─────────────────────────────────────────────────────────────────
  const footerY = Math.max(bodyY + 20, 680);
  if (footerY > 720) { doc.addPage(); }
  const fy = footerY > 720 ? 50 : footerY;
  hline(fy, '#cccccc');
  doc.fontSize(8).font('Helvetica').fillColor('#666666');
  let fLine = fy + 8;
  if (cfg.telefono_taller) {
    doc.text('Tel: ' + cfg.telefono_taller, L, fLine, { width: W / 2 });
  }
  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366')
       .text('WhatsApp: wa.me/' + cfg.whatsapp_taller, L + W / 2, fLine, {
         link: 'https://wa.me/' + cfg.whatsapp_taller, underline: true, width: W / 2, align: 'right'
       });
    doc.fillColor('#666666');
    fLine += 12;
  }
  doc.fontSize(7).fillColor('#999999')
     .text('Documento generado el ' + new Date().toLocaleString('es-CR'), L, fLine + 2, { width: W, align: 'center' });

  // ── Enviar al cliente ───────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=orden-' + folio + '.pdf');
  doc.pipe(res);
  doc.end();
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

  // Leer estado actual para validar la transicion
  const servicioActual = db.prepare('SELECT estado FROM servicios WHERE id = ?').get(req.params.id);
  if (!servicioActual) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }
  const estadoAnterior = servicioActual.estado;

  if (!estados.puedeTransicionar(estadoAnterior, estadoFinal)) {
    res.flash('danger', `No se puede pasar de "${estadoAnterior}" a "${estadoFinal}"`);
    const servRerender = db.prepare('SELECT * FROM servicios WHERE id = ?').get(req.params.id);
    servRerender.items  = db.prepare('SELECT * FROM servicio_items  WHERE servicio_id = ?').all(req.params.id);
    servRerender.tareas = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY orden, id').all(req.params.id);
    return res.render('servicios/form', {
      title:    'Editar Servicio',
      servicio: servRerender,
      vehiculos: getVehiculos(),
      mecanicos: getMecanicos(),
      errors:   []
    });
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

  // Auditar solo si el estado cambio efectivamente
  if (estadoAnterior !== estadoFinal) {
    audit.registrar({
      usuario:         req.session.usuario,
      accion:          'cambio_estado',
      entidad:         'servicio',
      entidad_id:      req.params.id,
      estado_anterior: estadoAnterior,
      estado_nuevo:    estadoFinal,
      detalle:         'Cambio de estado via edicion de orden'
    });
  }

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

  const estadoNuevoComp = 'Completada';
  if (!estados.puedeTransicionar(servicio.estado, estadoNuevoComp)) {
    res.flash('danger', `No se puede pasar de "${servicio.estado}" a "${estadoNuevoComp}"`);
    return res.redirect(`/servicios/${id}`);
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

  audit.registrar({
    usuario:         usuario,
    accion:          'cambio_estado',
    entidad:         'servicio',
    entidad_id:      id,
    estado_anterior: servicio.estado,
    estado_nuevo:    estadoNuevoComp,
    detalle:         'Orden completada'
  });

  res.flash('success', 'Orden marcada como completada');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// INICIAR ORDEN POST /:id/iniciar
// (admin o mecanico asignado) — transicion Pendiente|Asignada -> En proceso
// ---------------------------------------------------------------------------
router.post('/:id/iniciar', (req, res) => {
  const id      = req.params.id;
  const usuario = req.session.usuario;

  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  if (!puedeOperarOrden(servicio, usuario)) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para operar esta orden.'
    });
  }

  const estadoNuevo = 'En proceso';
  if (!estados.puedeTransicionar(servicio.estado, estadoNuevo)) {
    res.flash('danger', `No se puede pasar de "${servicio.estado}" a "${estadoNuevo}"`);
    return res.redirect(`/servicios/${id}`);
  }

  db.prepare("UPDATE servicios SET estado='En proceso' WHERE id=?").run(id);
  audit.registrar({
    usuario:         usuario,
    accion:          'cambio_estado',
    entidad:         'servicio',
    entidad_id:      id,
    estado_anterior: servicio.estado,
    estado_nuevo:    estadoNuevo,
    detalle:         'Orden iniciada'
  });
  res.flash('success', 'Orden marcada en proceso');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// AGREGAR ITEM POST /:id/items
// (admin o mecanico asignado) — repuesto o material para la orden
// ---------------------------------------------------------------------------
router.post('/:id/items', (req, res) => {
  const id      = req.params.id;
  const usuario = req.session.usuario;

  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  if (!puedeOperarOrden(servicio, usuario)) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para operar esta orden.'
    });
  }

  const tipo        = (req.body.tipo || 'Repuesto').trim();
  const descripcion = (req.body.descripcion || '').trim();
  const cantidad    = parseFloat(req.body.cantidad) || 1;

  if (!descripcion) {
    res.flash('danger', 'La descripcion del repuesto es obligatoria');
    return res.redirect(`/servicios/${id}`);
  }

  // Regla de precio: el mecanico no maneja precios -> siempre 0
  const precio_unitario = usuario.rol === 'tecnico'
    ? 0
    : parseFloat(req.body.precio_unitario) || 0;

  db.prepare(
    'INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)'
  ).run(id, tipo, descripcion, cantidad, precio_unitario);

  res.flash('success', 'Repuesto agregado');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// ELIMINAR ITEM POST /:id/items/:itemId/eliminar
// (admin o mecanico asignado)
// ---------------------------------------------------------------------------
router.post('/:id/items/:itemId/eliminar', (req, res) => {
  const id     = req.params.id;
  const itemId = req.params.itemId;
  const usuario = req.session.usuario;

  const servicio = db.prepare('SELECT * FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  if (!puedeOperarOrden(servicio, usuario)) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para operar esta orden.'
    });
  }

  // Verificar que el item pertenezca a esta orden antes de eliminar
  const item = db.prepare('SELECT id FROM servicio_items WHERE id = ? AND servicio_id = ?').get(itemId, id);
  if (!item) {
    res.flash('danger', 'Repuesto no encontrado en esta orden');
    return res.redirect(`/servicios/${id}`);
  }

  db.prepare('DELETE FROM servicio_items WHERE id = ?').run(itemId);

  res.flash('success', 'Repuesto eliminado');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// POR COBRAR POST /:id/por-cobrar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/por-cobrar', soloAdmin, (req, res) => {
  const id = req.params.id;
  const servicio = db.prepare('SELECT id, estado, costo FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  const estadoNuevoPC = 'Por cobrar';
  if (!estados.puedeTransicionar(servicio.estado, estadoNuevoPC)) {
    res.flash('danger', `No se puede pasar de "${servicio.estado}" a "${estadoNuevoPC}"`);
    return res.redirect(`/servicios/${id}`);
  }

  const total = calcularTotalOrden(id, servicio.costo);
  if (total <= 0) {
    res.flash('danger', 'No se puede cobrar una orden sin monto. Asigna precios primero.');
    return res.redirect(`/servicios/${id}`);
  }

  const estadoAnteriorPC = servicio.estado;
  db.prepare("UPDATE servicios SET estado='Por cobrar' WHERE id=?").run(id);

  audit.registrar({
    usuario:         req.session.usuario,
    accion:          'cambio_estado',
    entidad:         'servicio',
    entidad_id:      id,
    estado_anterior: estadoAnteriorPC,
    estado_nuevo:    estadoNuevoPC,
    detalle:         `Marcada por cobrar (total: ${total.toFixed(2)})`
  });

  res.flash('success', 'Orden marcada como por cobrar');
  res.redirect(`/servicios/${id}`);
});

// ---------------------------------------------------------------------------
// COBRAR POST /:id/cobrar  (solo admin)
// ---------------------------------------------------------------------------
router.post('/:id/cobrar', soloAdmin, (req, res) => {
  const id = req.params.id;
  const servicio = db.prepare('SELECT id, estado, costo FROM servicios WHERE id = ?').get(id);
  if (!servicio) {
    return res.status(404).render('partials/error', { title: 'Error', message: 'Servicio no encontrado' });
  }

  const estadoNuevoCob = 'Cobrada';
  if (!estados.puedeTransicionar(servicio.estado, estadoNuevoCob)) {
    res.flash('danger', `No se puede pasar de "${servicio.estado}" a "${estadoNuevoCob}"`);
    return res.redirect(`/servicios/${id}`);
  }

  const total = calcularTotalOrden(id, servicio.costo);
  if (total <= 0) {
    res.flash('danger', 'No se puede cobrar una orden sin monto. Asigna precios primero.');
    return res.redirect(`/servicios/${id}`);
  }

  const estadoAnteriorCob = servicio.estado;
  const fechaAhora = new Date().toLocaleString('es-CR');
  db.prepare("UPDATE servicios SET estado='Cobrada', cobrado=1, fecha_cobro=? WHERE id=?")
    .run(fechaAhora, id);

  audit.registrar({
    usuario:         req.session.usuario,
    accion:          'cambio_estado',
    entidad:         'servicio',
    entidad_id:      id,
    estado_anterior: estadoAnteriorCob,
    estado_nuevo:    estadoNuevoCob,
    detalle:         `Orden cobrada (total: ${total.toFixed(2)})`
  });

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
