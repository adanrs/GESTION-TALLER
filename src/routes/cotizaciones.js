const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const db = require('../db/database');

function getConfig(clave) {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
  return row ? row.valor : '';
}
function getAllConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const c = {}; rows.forEach(r => c[r.clave] = r.valor); return c;
}
function simboloHTML(moneda) { return moneda === 'CRC' ? '&#8353;' : '$'; }
function simboloPDF(moneda) { return moneda === 'CRC' ? '\u20A1' : '$'; }
function getTipoCambio() { return parseFloat(getConfig('tipo_cambio_crc')) || 515; }
function getIvaDefault() { return parseFloat(getConfig('iva_porcentaje')) || 13; }
function getAplicaIvaDefault() { return getConfig('aplica_iva') !== '0'; }

function generarNumero() {
  const year = new Date().getFullYear();
  const last = db.prepare("SELECT numero FROM cotizaciones WHERE numero LIKE ? ORDER BY id DESC LIMIT 1").get(`COT-${year}%`);
  let seq = 1;
  if (last) { seq = parseInt(last.numero.split('-')[1].slice(4)) + 1; }
  return `COT-${year}${String(seq).padStart(4, '0')}`;
}

function calcTotales(detalles, aplicaIva, ivaPct) {
  const subtotal = detalles.reduce((s, d) => s + d.cantidad * d.precio_unitario, 0);
  const iva = aplicaIva ? subtotal * (ivaPct / 100) : 0;
  return { subtotal, iva, total: subtotal + iva };
}

// Listar
router.get('/', (req, res) => {
  const estado = req.query.estado || '';
  const buscar = req.query.buscar || '';
  let query = `
    SELECT cot.*, v.placa, v.marca, v.modelo, cl.nombre as cliente_nombre,
    COALESCE(SUM(d.cantidad * d.precio_unitario), 0) as subtotal_items
    FROM cotizaciones cot
    JOIN vehiculos v ON cot.vehiculo_id = v.id
    JOIN clientes cl ON v.cliente_id = cl.id
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
  `;
  const conditions = [], params = [];
  if (estado) { conditions.push('cot.estado = ?'); params.push(estado); }
  if (buscar) { conditions.push('(cot.numero LIKE ? OR v.placa LIKE ? OR cl.nombre LIKE ?)'); params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' GROUP BY cot.id ORDER BY cot.fecha DESC';

  const cotizaciones = db.prepare(query).all(...params).map(c => {
    const sub = c.subtotal_items || 0;
    const iva = c.aplica_iva ? sub * ((c.iva_porcentaje || 0) / 100) : 0;
    c.total = sub + iva;
    return c;
  });
  res.render('cotizaciones/index', { title: 'Cotizaciones', cotizaciones, estado, buscar, simboloMoneda: simboloHTML });
});

// Crear
router.get('/crear', (req, res) => {
  const vehiculos = db.prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`).all();
  res.render('cotizaciones/form', {
    title: 'Nueva Cotizacion',
    cotizacion: {
      vehiculo_id: req.query.vehiculo_id || '', moneda: getConfig('moneda') || 'USD',
      tipo_cambio: getTipoCambio(), aplica_iva: getAplicaIvaDefault() ? 1 : 0, iva_porcentaje: getIvaDefault(),
      detalles: [{ tipo: 'Repuesto', descripcion: '', cantidad: 1, precio_unitario: 0 }]
    },
    vehiculos, errors: []
  });
});

router.post('/crear', (req, res) => {
  const { vehiculo_id, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas } = req.body;
  const detalles = parseDetalles(req.body);
  const errors = [];
  if (!vehiculo_id) errors.push('Debe seleccionar un vehiculo');
  if (!detalles.length) errors.push('Debe agregar al menos un item');
  if (errors.length) {
    const vehiculos = db.prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`).all();
    return res.render('cotizaciones/form', { title: 'Nueva Cotizacion', cotizacion: { ...req.body, aplica_iva: aplica_iva ? 1 : 0, detalles }, vehiculos, errors });
  }

  const numero = generarNumero();
  const tc = parseFloat(tipo_cambio) || getTipoCambio();
  const ivaOn = aplica_iva === 'on' ? 1 : 0;
  const ivaPct = parseFloat(iva_porcentaje) || 13;

  const cotId = db.transaction(() => {
    const r = db.prepare('INSERT INTO cotizaciones (vehiculo_id, numero, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas) VALUES (?,?,?,?,?,?,?)')
      .run(vehiculo_id, numero, moneda || 'USD', tc, ivaOn, ivaPct, notas?.trim());
    const id = r.lastInsertRowid;
    const ins = db.prepare('INSERT INTO cotizacion_detalles (cotizacion_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
    for (const d of detalles) ins.run(id, d.tipo, d.descripcion, d.cantidad, d.precio_unitario);
    return id;
  })();

  res.flash('success', `Cotizacion ${numero} creada`);
  res.redirect(`/cotizaciones/${cotId}`);
});

// Detalle
router.get('/:id', (req, res) => {
  const cotizacion = db.prepare(`
    SELECT cot.*, v.placa, v.marca, v.modelo, v.ano, v.color, v.vin,
    cl.nombre as cliente_nombre, cl.cedula, cl.telefono, cl.email
    FROM cotizaciones cot JOIN vehiculos v ON cot.vehiculo_id = v.id JOIN clientes cl ON v.cliente_id = cl.id WHERE cot.id = ?
  `).get(req.params.id);
  if (!cotizacion) return res.status(404).render('partials/error', { title: 'Error', message: 'Cotizacion no encontrada' });

  const detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cotizacion.id);
  const mon = cotizacion.moneda || 'USD';
  const tc = cotizacion.tipo_cambio || getTipoCambio();
  const t = calcTotales(detalles, cotizacion.aplica_iva, cotizacion.iva_porcentaje || 0);
  const monAlt = mon === 'USD' ? 'CRC' : 'USD';
  const totalConvertido = mon === 'USD' ? t.total * tc : t.total / tc;

  res.render('cotizaciones/detalle', {
    title: `Cotizacion ${cotizacion.numero}`, cotizacion, detalles,
    subtotal: t.subtotal, iva: t.iva, total: t.total,
    simbolo: simboloHTML(mon), tc, totalConvertido,
    simboloAlt: simboloHTML(monAlt), monedaAlterna: monAlt,
    whatsapp: getConfig('whatsapp_taller')
  });
});

// Editar
router.get('/:id/editar', (req, res) => {
  const cotizacion = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(req.params.id);
  if (!cotizacion) return res.status(404).render('partials/error', { title: 'Error', message: 'Cotizacion no encontrada' });
  cotizacion.detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cotizacion.id);
  if (!cotizacion.detalles.length) cotizacion.detalles = [{ tipo: 'Repuesto', descripcion: '', cantidad: 1, precio_unitario: 0 }];
  if (!cotizacion.tipo_cambio) cotizacion.tipo_cambio = getTipoCambio();
  const vehiculos = db.prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`).all();
  res.render('cotizaciones/form', { title: 'Editar Cotizacion', cotizacion, vehiculos, errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { vehiculo_id, estado, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas } = req.body;
  const detalles = parseDetalles(req.body);
  const errors = [];
  if (!vehiculo_id) errors.push('Debe seleccionar un vehiculo');
  if (!detalles.length) errors.push('Debe agregar al menos un item');
  if (errors.length) {
    const vehiculos = db.prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`).all();
    return res.render('cotizaciones/form', { title: 'Editar Cotizacion', cotizacion: { ...req.body, id: req.params.id, aplica_iva: aplica_iva ? 1 : 0, detalles }, vehiculos, errors });
  }

  const tc = parseFloat(tipo_cambio) || getTipoCambio();
  const ivaOn = aplica_iva === 'on' ? 1 : 0;
  const ivaPct = parseFloat(iva_porcentaje) || 13;

  db.transaction(() => {
    db.prepare('UPDATE cotizaciones SET vehiculo_id=?, estado=?, moneda=?, tipo_cambio=?, aplica_iva=?, iva_porcentaje=?, notas=? WHERE id=?')
      .run(vehiculo_id, estado || 'Borrador', moneda || 'USD', tc, ivaOn, ivaPct, notas?.trim(), req.params.id);
    db.prepare('DELETE FROM cotizacion_detalles WHERE cotizacion_id=?').run(req.params.id);
    const ins = db.prepare('INSERT INTO cotizacion_detalles (cotizacion_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)');
    for (const d of detalles) ins.run(req.params.id, d.tipo, d.descripcion, d.cantidad, d.precio_unitario);
  })();

  res.flash('success', 'Cotizacion actualizada');
  res.redirect(`/cotizaciones/${req.params.id}`);
});

// ===================== PDF PROFESIONAL =====================
router.get('/:id/pdf', (req, res) => {
  const cot = db.prepare(`
    SELECT cot.*, v.placa, v.marca, v.modelo, v.ano, v.color, v.vin,
    cl.nombre as cliente_nombre, cl.cedula, cl.telefono, cl.email, cl.direccion as cliente_dir
    FROM cotizaciones cot JOIN vehiculos v ON cot.vehiculo_id = v.id JOIN clientes cl ON v.cliente_id = cl.id WHERE cot.id = ?
  `).get(req.params.id);
  if (!cot) return res.status(404).send('No encontrada');

  const detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cot.id);
  const cfg = getAllConfig();
  const mon = cot.moneda || 'USD';
  const tc = cot.tipo_cambio || getTipoCambio();
  const sim = simboloPDF(mon);
  const fmt = (n) => `${sim}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const t = calcTotales(detalles, cot.aplica_iva, cot.iva_porcentaje || 0);

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=cotizacion-${cot.numero}.pdf`);
  doc.pipe(res);

  const L = 50, R = 562, W = R - L;

  // ─── HEADER: 2 columnas ───
  doc.fontSize(18).font('Helvetica-Bold').text(cfg.nombre_taller || 'Taller Mecanico', L, 50, { width: W / 2 });
  doc.fontSize(9).font('Helvetica');
  let hy = 72;
  if (cfg.direccion_taller) { doc.text(cfg.direccion_taller, L, hy); hy += 12; }
  if (cfg.telefono_taller) { doc.text(`Tel: ${cfg.telefono_taller}`, L, hy); hy += 12; }
  if (cfg.whatsapp_taller) {
    const waText = `WhatsApp: ${cfg.whatsapp_taller}`;
    doc.fillColor('#25D366').text(waText, L, hy, { link: `https://wa.me/${cfg.whatsapp_taller}`, underline: true });
    doc.fillColor('#000000');
    hy += 12;
  }
  if (cfg.email_taller) {
    doc.fillColor('#0066cc').text(cfg.email_taller, L, hy, { link: `mailto:${cfg.email_taller}`, underline: true });
    doc.fillColor('#000000');
    hy += 12;
  }

  // Right: cotizacion info
  const rx = L + W / 2 + 20;
  doc.fontSize(20).font('Helvetica-Bold').text('COTIZACION', rx, 50, { width: W / 2 - 20, align: 'right' });
  doc.fontSize(10).font('Helvetica');
  doc.text(`No: ${cot.numero}`, rx, 74, { width: W / 2 - 20, align: 'right' });
  doc.text(`Fecha: ${cot.fecha ? cot.fecha.substring(0, 10) : ''}`, rx, 87, { width: W / 2 - 20, align: 'right' });
  doc.text(`Moneda: ${mon === 'CRC' ? 'Colones' : 'Dolares'} (${mon})`, rx, 100, { width: W / 2 - 20, align: 'right' });
  const estadoText = cot.estado || 'Borrador';
  doc.text(`Estado: ${estadoText}`, rx, 113, { width: W / 2 - 20, align: 'right' });

  // ─── Divider ───
  const divY = Math.max(hy, 130) + 8;
  doc.moveTo(L, divY).lineTo(R, divY).lineWidth(2).strokeColor('#333333').stroke();
  doc.lineWidth(1).strokeColor('#000000');

  // ─── CLIENT + VEHICLE: 2 columnas ───
  let infoY = divY + 12;

  // Left: Client
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333').text('CLIENTE', L, infoY);
  doc.fillColor('#000000');
  infoY += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text(cot.cliente_nombre, L, infoY); infoY += 12;
  if (cot.cedula) { doc.text(`Cedula/RIF: ${cot.cedula}`, L, infoY); infoY += 12; }
  if (cot.telefono) { doc.text(`Tel: ${cot.telefono}`, L, infoY); infoY += 12; }
  if (cot.email) {
    doc.fillColor('#0066cc').text(cot.email, L, infoY, { link: `mailto:${cot.email}`, underline: true });
    doc.fillColor('#000000'); infoY += 12;
  }

  // Right: Vehicle
  let vy = divY + 12;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333').text('VEHICULO', rx, vy, { width: W / 2 - 20 });
  doc.fillColor('#000000');
  vy += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text(`Placa: ${cot.placa}`, rx, vy); vy += 12;
  doc.text(`${cot.marca} ${cot.modelo}${cot.ano ? ' (' + cot.ano + ')' : ''}`, rx, vy); vy += 12;
  if (cot.color) { doc.text(`Color: ${cot.color}`, rx, vy); vy += 12; }
  if (cot.vin) { doc.text(`VIN: ${cot.vin}`, rx, vy); vy += 12; }

  // ─── TABLE ───
  let tableY = Math.max(infoY, vy) + 12;
  doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor('#cccccc').stroke();
  tableY += 4;

  // Columns
  const c = { num: L, tipo: L + 30, desc: L + 100, cant: 360, precio: 415, sub: 490 };

  // Header
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
  doc.text('#', c.num, tableY).text('TIPO', c.tipo, tableY).text('DESCRIPCION', c.desc, tableY)
    .text('CANT', c.cant, tableY, { width: 45, align: 'right' })
    .text('P. UNIT.', c.precio, tableY, { width: 65, align: 'right' })
    .text('SUBTOTAL', c.sub, tableY, { width: 72, align: 'right' });
  doc.fillColor('#000000');

  tableY += 14;
  doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor('#cccccc').stroke();
  tableY += 4;

  // Rows
  doc.font('Helvetica').fontSize(9);
  detalles.forEach((d, i) => {
    if (tableY > 680) { doc.addPage(); tableY = 50; }
    const sub = d.cantidad * d.precio_unitario;

    // Zebra
    if (i % 2 === 0) {
      doc.rect(L, tableY - 2, W, 16).fill('#f8f8f8');
      doc.fillColor('#000000');
    }

    doc.text(String(i + 1), c.num, tableY)
      .text(d.tipo, c.tipo, tableY)
      .text(d.descripcion, c.desc, tableY, { width: 250 })
      .text(String(d.cantidad), c.cant, tableY, { width: 45, align: 'right' })
      .text(fmt(d.precio_unitario), c.precio, tableY, { width: 65, align: 'right' })
      .text(fmt(sub), c.sub, tableY, { width: 72, align: 'right' });
    tableY += 16;
  });

  // ─── TOTALS ───
  tableY += 4;
  doc.moveTo(L, tableY).lineTo(R, tableY).lineWidth(1.5).strokeColor('#333333').stroke();
  doc.lineWidth(1);
  tableY += 8;

  const totX = c.precio - 30;
  const totVX = c.sub;

  doc.fontSize(9).font('Helvetica');
  doc.text('Subtotal:', totX, tableY, { width: 95, align: 'right' });
  doc.text(fmt(t.subtotal), totVX, tableY, { width: 72, align: 'right' });
  tableY += 14;

  if (cot.aplica_iva) {
    doc.text(`IVA (${cot.iva_porcentaje || 0}%):`, totX, tableY, { width: 95, align: 'right' });
    doc.text(fmt(t.iva), totVX, tableY, { width: 72, align: 'right' });
    tableY += 14;
  }

  // Total box
  doc.rect(totX - 5, tableY - 2, R - totX + 5, 22).fill('#1a1a2e');
  doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
  doc.text('TOTAL:', totX, tableY + 2, { width: 95, align: 'right' });
  doc.text(fmt(t.total), totVX, tableY + 2, { width: 72, align: 'right' });
  doc.fillColor('#000000');
  tableY += 28;

  // Equivalent
  if (tc > 0) {
    const alt = mon === 'USD' ? 'CRC' : 'USD';
    const altSim = simboloPDF(alt);
    const conv = mon === 'USD' ? t.total * tc : t.total / tc;
    doc.fontSize(8).font('Helvetica').fillColor('#666666');
    doc.text(`Equivalente en ${alt} (T.C. ${tc}): ${altSim}${conv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, totX - 80, tableY, { width: R - totX + 85, align: 'right' });
    doc.fillColor('#000000');
    tableY += 16;
  }

  // ─── NOTAS ───
  if (cot.notas) {
    tableY += 10;
    doc.fontSize(9).font('Helvetica-Bold').text('Notas:', L, tableY);
    tableY += 12;
    doc.font('Helvetica').text(cot.notas, L, tableY, { width: W });
    tableY += 20;
  }

  // ─── FOOTER: WhatsApp link ───
  tableY = Math.max(tableY + 20, 650);
  if (tableY > 700) { doc.addPage(); tableY = 50; }

  doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor('#cccccc').stroke();
  tableY += 8;
  doc.fontSize(8).font('Helvetica').fillColor('#666666');

  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366').text(
      `Contactenos por WhatsApp: wa.me/${cfg.whatsapp_taller}`,
      L, tableY,
      { link: `https://wa.me/${cfg.whatsapp_taller}`, underline: true, continued: false }
    );
    tableY += 12;
  }

  doc.fillColor('#999999').fontSize(7)
    .text('Este documento es una cotizacion y no constituye una factura. Precios sujetos a cambio.', L, tableY, { width: W, align: 'center' });

  doc.end();
});

router.post('/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM cotizaciones WHERE id = ?').run(req.params.id);
  res.flash('success', 'Cotizacion eliminada');
  res.redirect('/cotizaciones');
});

function parseDetalles(body) {
  const detalles = [];
  if (!body.det_tipo) return detalles;
  const tipos = Array.isArray(body.det_tipo) ? body.det_tipo : [body.det_tipo];
  const descs = Array.isArray(body.det_descripcion) ? body.det_descripcion : [body.det_descripcion];
  const cants = Array.isArray(body.det_cantidad) ? body.det_cantidad : [body.det_cantidad];
  const precios = Array.isArray(body.det_precio) ? body.det_precio : [body.det_precio];
  for (let i = 0; i < tipos.length; i++) {
    if (descs[i]?.trim()) {
      detalles.push({ tipo: tipos[i] || 'Repuesto', descripcion: descs[i].trim(), cantidad: parseFloat(cants[i]) || 1, precio_unitario: parseFloat(precios[i]) || 0 });
    }
  }
  return detalles;
}

module.exports = router;
