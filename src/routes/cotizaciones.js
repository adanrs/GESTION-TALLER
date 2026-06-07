const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const db = require('../db/database');
const mailer = require('../lib/mailer');
const estados = require('../lib/estados');
const audit   = require('../lib/auditoria');

// ── Guard: solo encargado (admin) ───────────────────────────────────────────
function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Solo el encargado puede acceder a los reportes.',
    });
  }
  next();
}

router.use(soloAdmin);

// ─── Helpers de configuracion ───────────────────────────────────────────────

function getConfig(clave) {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
  return row ? row.valor : '';
}
function getAllConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const c = {};
  rows.forEach(r => (c[r.clave] = r.valor));
  return c;
}
function simboloHTML(moneda) { return moneda === 'CRC' ? '&#8353;' : '$'; }
function simboloPDF(moneda) { return moneda === 'CRC' ? '₡' : '$'; }
function getTipoCambio() { return parseFloat(getConfig('tipo_cambio_crc')) || 515; }
function getIvaDefault() { return parseFloat(getConfig('iva_porcentaje')) || 13; }
function getAplicaIvaDefault() { return getConfig('aplica_iva') !== '0'; }

function generarNumero() {
  const year = new Date().getFullYear();
  const last = db
    .prepare('SELECT numero FROM cotizaciones WHERE numero LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`COT-${year}%`);
  let seq = 1;
  if (last) { seq = parseInt(last.numero.split('-')[1].slice(4)) + 1; }
  return `COT-${year}${String(seq).padStart(4, '0')}`;
}

function calcTotales(detalles, aplicaIva, ivaPct) {
  const subtotal = detalles.reduce((s, d) => s + d.cantidad * d.precio_unitario, 0);
  const iva = aplicaIva ? subtotal * (ivaPct / 100) : 0;
  return { subtotal, iva, total: subtotal + iva };
}

// ─── Construccion del PDF (sin pipe ni end) ──────────────────────────────────
// Devuelve { doc, cot } donde doc es un PDFDocument aun abierto.
// El caller es responsable de hacer doc.pipe(...) y doc.end().

function construirPDF(cotId) {
  const cot = db
    .prepare(`
      SELECT cot.*, v.placa, v.marca, v.modelo, v.ano, v.color, v.vin,
             cl.nombre AS cliente_nombre, cl.cedula, cl.telefono, cl.email,
             cl.direccion AS cliente_dir
      FROM cotizaciones cot
      JOIN vehiculos v  ON cot.vehiculo_id = v.id
      JOIN clientes  cl ON v.cliente_id    = cl.id
      WHERE cot.id = ?
    `)
    .get(cotId);

  if (!cot) return null;

  const detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cot.id);
  const cfg = getAllConfig();
  const mon = cot.moneda || 'USD';
  const tc = cot.tipo_cambio || getTipoCambio();
  const sim = simboloPDF(mon);
  const fmt = (n) =>
    `${sim}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const t = calcTotales(detalles, cot.aplica_iva, cot.iva_porcentaje || 0);

  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });

  const L = 50, R = 562, W = R - L;

  // ─── HEADER: 2 columnas ───
  doc.fontSize(18).font('Helvetica-Bold').text(cfg.nombre_taller || 'Taller Mecanico', L, 50, { width: W / 2 });
  doc.fontSize(9).font('Helvetica');
  let hy = 72;
  if (cfg.direccion_taller) { doc.text(cfg.direccion_taller, L, hy); hy += 12; }
  if (cfg.telefono_taller)  { doc.text(`Tel: ${cfg.telefono_taller}`, L, hy); hy += 12; }
  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366').text(`WhatsApp: ${cfg.whatsapp_taller}`, L, hy, {
      link: `https://wa.me/${cfg.whatsapp_taller}`, underline: true,
    });
    doc.fillColor('#000000');
    hy += 12;
  }
  if (cfg.email_taller) {
    doc.fillColor('#0066cc').text(cfg.email_taller, L, hy, {
      link: `mailto:${cfg.email_taller}`, underline: true,
    });
    doc.fillColor('#000000');
    hy += 12;
  }

  // Right: cotizacion info
  const rx = L + W / 2 + 20;
  doc.fontSize(20).font('Helvetica-Bold').text('COTIZACION', rx, 50, { width: W / 2 - 20, align: 'right' });
  doc.fontSize(10).font('Helvetica');
  doc.text(`No: ${cot.numero}`,              rx, 74,  { width: W / 2 - 20, align: 'right' });
  doc.text(`Fecha: ${cot.fecha ? cot.fecha.substring(0, 10) : ''}`, rx, 87,  { width: W / 2 - 20, align: 'right' });
  doc.text(`Moneda: ${mon === 'CRC' ? 'Colones' : 'Dolares'} (${mon})`, rx, 100, { width: W / 2 - 20, align: 'right' });
  doc.text(`Estado: ${cot.estado || 'Borrador'}`, rx, 113, { width: W / 2 - 20, align: 'right' });

  // ─── Divider ───
  const divY = Math.max(hy, 130) + 8;
  doc.moveTo(L, divY).lineTo(R, divY).lineWidth(2).strokeColor('#333333').stroke();
  doc.lineWidth(1).strokeColor('#000000');

  // ─── CLIENTE + VEHICULO: 2 columnas ───
  let infoY = divY + 12;

  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333').text('CLIENTE', L, infoY);
  doc.fillColor('#000000');
  infoY += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text(cot.cliente_nombre, L, infoY); infoY += 12;
  if (cot.cedula)  { doc.text(`Cedula/RIF: ${cot.cedula}`,  L, infoY); infoY += 12; }
  if (cot.telefono){ doc.text(`Tel: ${cot.telefono}`,       L, infoY); infoY += 12; }
  if (cot.email) {
    doc.fillColor('#0066cc').text(cot.email, L, infoY, { link: `mailto:${cot.email}`, underline: true });
    doc.fillColor('#000000');
    infoY += 12;
  }

  let vy = divY + 12;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333').text('VEHICULO', rx, vy, { width: W / 2 - 20 });
  doc.fillColor('#000000');
  vy += 14;
  doc.fontSize(9).font('Helvetica');
  doc.text(`Placa: ${cot.placa}`, rx, vy); vy += 12;
  doc.text(`${cot.marca} ${cot.modelo}${cot.ano ? ' (' + cot.ano + ')' : ''}`, rx, vy); vy += 12;
  if (cot.color) { doc.text(`Color: ${cot.color}`, rx, vy); vy += 12; }
  if (cot.vin)   { doc.text(`VIN: ${cot.vin}`,     rx, vy); vy += 12; }

  // ─── TABLA ───
  let tableY = Math.max(infoY, vy) + 12;
  doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor('#cccccc').stroke();
  tableY += 4;

  const col = { num: L, tipo: L + 30, desc: L + 100, cant: 360, precio: 415, sub: 490 };

  doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
  doc.text('#', col.num, tableY)
     .text('TIPO', col.tipo, tableY)
     .text('DESCRIPCION', col.desc, tableY)
     .text('CANT',     col.cant,  tableY, { width: 45, align: 'right' })
     .text('P. UNIT.', col.precio, tableY, { width: 65, align: 'right' })
     .text('SUBTOTAL', col.sub,   tableY, { width: 72, align: 'right' });
  doc.fillColor('#000000');
  tableY += 14;
  doc.moveTo(L, tableY).lineTo(R, tableY).strokeColor('#cccccc').stroke();
  tableY += 4;

  doc.font('Helvetica').fontSize(9);
  detalles.forEach((d, i) => {
    if (tableY > 680) { doc.addPage(); tableY = 50; }
    const sub = d.cantidad * d.precio_unitario;
    if (i % 2 === 0) {
      doc.rect(L, tableY - 2, W, 16).fill('#f8f8f8');
      doc.fillColor('#000000');
    }
    doc.text(String(i + 1), col.num, tableY)
       .text(d.tipo, col.tipo, tableY)
       .text(d.descripcion, col.desc, tableY, { width: 250 })
       .text(String(d.cantidad), col.cant, tableY, { width: 45, align: 'right' })
       .text(fmt(d.precio_unitario), col.precio, tableY, { width: 65, align: 'right' })
       .text(fmt(sub), col.sub, tableY, { width: 72, align: 'right' });
    tableY += 16;
  });

  // ─── TOTALES ───
  tableY += 4;
  doc.moveTo(L, tableY).lineTo(R, tableY).lineWidth(1.5).strokeColor('#333333').stroke();
  doc.lineWidth(1);
  tableY += 8;

  const totX = col.precio - 30;
  const totVX = col.sub;

  doc.fontSize(9).font('Helvetica');
  doc.text('Subtotal:', totX, tableY, { width: 95, align: 'right' });
  doc.text(fmt(t.subtotal), totVX, tableY, { width: 72, align: 'right' });
  tableY += 14;

  if (cot.aplica_iva) {
    doc.text(`IVA (${cot.iva_porcentaje || 0}%):`, totX, tableY, { width: 95, align: 'right' });
    doc.text(fmt(t.iva), totVX, tableY, { width: 72, align: 'right' });
    tableY += 14;
  }

  doc.rect(totX - 5, tableY - 2, R - totX + 5, 22).fill('#1a1a2e');
  doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold');
  doc.text('TOTAL:', totX, tableY + 2, { width: 95, align: 'right' });
  doc.text(fmt(t.total), totVX, tableY + 2, { width: 72, align: 'right' });
  doc.fillColor('#000000');
  tableY += 28;

  if (tc > 0) {
    const alt = mon === 'USD' ? 'CRC' : 'USD';
    const altSim = simboloPDF(alt);
    const conv = mon === 'USD' ? t.total * tc : t.total / tc;
    doc.fontSize(8).font('Helvetica').fillColor('#666666');
    doc.text(
      `Equivalente en ${alt} (T.C. ${tc}): ${altSim}${conv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      totX - 80, tableY, { width: R - totX + 85, align: 'right' }
    );
    doc.fillColor('#000000');
    tableY += 16;
  }

  // ─── GARANTIA ───
  if (cot.garantia) {
    tableY += 8;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('Garantia:', L, tableY);
    tableY += 12;
    doc.font('Helvetica').fillColor('#000000').text(cot.garantia, L, tableY, { width: W });
    tableY += 20;
  }

  // ─── NOTAS ───
  if (cot.notas) {
    tableY += 6;
    doc.fontSize(9).font('Helvetica-Bold').text('Notas:', L, tableY);
    tableY += 12;
    doc.font('Helvetica').text(cot.notas, L, tableY, { width: W });
    tableY += 20;
  }

  // ─── FOOTER ───
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

  doc.fillColor('#999999').fontSize(7).text(
    'Este documento es una cotizacion y no constituye una factura. Precios sujetos a cambio.',
    L, tableY, { width: W, align: 'center' }
  );

  // NO se llama doc.end() aqui — responsabilidad del caller
  return { doc, cot };
}

// ─── Helper: obtener PDF como Buffer ─────────────────────────────────────────

async function cotizacionPDFBuffer(cotId) {
  const resultado = construirPDF(cotId);
  if (!resultado) return null;
  const { doc, cot } = resultado;
  return await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), cot }));
    doc.on('error', reject);
    doc.end();
  });
}

// ─── RUTA: tipo de cambio (debe ir ANTES de /:id) ────────────────────────────

router.get('/api/tipo-cambio', async (req, res) => {
  try {
    const r = await fetch('https://api.hacienda.go.cr/indicadores/tc/dolar', {
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const venta = j?.venta?.valor;
    const compra = j?.compra?.valor;
    if (!venta) throw new Error('Sin dato');
    res.json({ ok: true, venta, compra, fecha: j?.venta?.fecha });
  } catch (e) {
    res.json({ ok: false, error: 'No se pudo obtener el tipo de cambio' });
  }
});

// ─── Listar ───────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const estado = req.query.estado || '';
  const buscar = req.query.buscar || '';
  let query = `
    SELECT cot.*, v.placa, v.marca, v.modelo, cl.nombre AS cliente_nombre,
           COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS subtotal_items
    FROM cotizaciones cot
    JOIN vehiculos v  ON cot.vehiculo_id = v.id
    JOIN clientes  cl ON v.cliente_id    = cl.id
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
  `;
  const conditions = [], params = [];
  if (estado) { conditions.push('cot.estado = ?');    params.push(estado); }
  if (buscar) {
    conditions.push('(cot.numero LIKE ? OR v.placa LIKE ? OR cl.nombre LIKE ?)');
    params.push(`%${buscar}%`, `%${buscar}%`, `%${buscar}%`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' GROUP BY cot.id ORDER BY cot.fecha DESC';

  const cotizaciones = db.prepare(query).all(...params).map((c) => {
    const sub = c.subtotal_items || 0;
    const iva = c.aplica_iva ? sub * ((c.iva_porcentaje || 0) / 100) : 0;
    c.total = sub + iva;
    return c;
  });
  res.render('cotizaciones/index', {
    title: 'Cotizaciones', cotizaciones, estado, buscar, simboloMoneda: simboloHTML,
  });
});

// ─── Crear ────────────────────────────────────────────────────────────────────

router.get('/crear', (req, res) => {
  const vehiculos = db
    .prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre AS cliente_nombre
              FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`)
    .all();
  res.render('cotizaciones/form', {
    title: 'Nueva Cotizacion',
    cotizacion: {
      vehiculo_id:    req.query.vehiculo_id || '',
      moneda:         getConfig('moneda') || 'USD',
      tipo_cambio:    getTipoCambio(),
      aplica_iva:     getAplicaIvaDefault() ? 1 : 0,
      iva_porcentaje: getIvaDefault(),
      garantia:       '',
      detalles: [{ tipo: 'Repuesto', descripcion: '', cantidad: 1, precio_unitario: 0 }],
    },
    vehiculos, errors: [],
  });
});

router.post('/crear', (req, res) => {
  const { vehiculo_id, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas, garantia } = req.body;
  const detalles = parseDetalles(req.body);
  const errors = [];
  if (!vehiculo_id)    errors.push('Debe seleccionar un vehiculo');
  if (!detalles.length) errors.push('Debe agregar al menos un item');
  if (errors.length) {
    const vehiculos = db
      .prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre AS cliente_nombre
                FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`)
      .all();
    return res.render('cotizaciones/form', {
      title: 'Nueva Cotizacion',
      cotizacion: { ...req.body, aplica_iva: aplica_iva ? 1 : 0, detalles },
      vehiculos, errors,
    });
  }

  const numero = generarNumero();
  const tc     = parseFloat(tipo_cambio) || getTipoCambio();
  const ivaOn  = aplica_iva === 'on' ? 1 : 0;
  const ivaPct = parseFloat(iva_porcentaje) || 13;

  const cotId = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO cotizaciones (vehiculo_id, numero, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas, garantia) VALUES (?,?,?,?,?,?,?,?)'
    ).run(vehiculo_id, numero, moneda || 'USD', tc, ivaOn, ivaPct, notas?.trim(), garantia?.trim() || null);
    const id = r.lastInsertRowid;
    const ins = db.prepare(
      'INSERT INTO cotizacion_detalles (cotizacion_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)'
    );
    for (const d of detalles) ins.run(id, d.tipo, d.descripcion, d.cantidad, d.precio_unitario);
    return id;
  })();

  res.flash('success', `Cotizacion ${numero} creada`);
  res.redirect(`/cotizaciones/${cotId}`);
});

// ─── Detalle (debe ir DESPUES de rutas literales como /crear y /api/*) ────────

router.get('/:id', (req, res) => {
  const cotizacion = db
    .prepare(`
      SELECT cot.*, v.placa, v.marca, v.modelo, v.ano, v.color, v.vin,
             cl.nombre AS cliente_nombre, cl.cedula, cl.telefono, cl.email
      FROM cotizaciones cot
      JOIN vehiculos v  ON cot.vehiculo_id = v.id
      JOIN clientes  cl ON v.cliente_id    = cl.id
      WHERE cot.id = ?
    `)
    .get(req.params.id);
  if (!cotizacion)
    return res.status(404).render('partials/error', { title: 'Error', message: 'Cotizacion no encontrada' });

  const detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cotizacion.id);
  const mon = cotizacion.moneda || 'USD';
  const tc  = cotizacion.tipo_cambio || getTipoCambio();
  const t   = calcTotales(detalles, cotizacion.aplica_iva, cotizacion.iva_porcentaje || 0);
  const monAlt = mon === 'USD' ? 'CRC' : 'USD';
  const totalConvertido = mon === 'USD' ? t.total * tc : t.total / tc;

  res.render('cotizaciones/detalle', {
    title: `Cotizacion ${cotizacion.numero}`,
    cotizacion, detalles,
    subtotal: t.subtotal, iva: t.iva, total: t.total,
    simbolo: simboloHTML(mon), tc, totalConvertido,
    simboloAlt: simboloHTML(monAlt), monedaAlterna: monAlt,
    whatsapp: getConfig('whatsapp_taller'),
  });
});

// ─── Editar ───────────────────────────────────────────────────────────────────

router.get('/:id/editar', (req, res) => {
  const cotizacion = db.prepare('SELECT * FROM cotizaciones WHERE id = ?').get(req.params.id);
  if (!cotizacion)
    return res.status(404).render('partials/error', { title: 'Error', message: 'Cotizacion no encontrada' });

  cotizacion.detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cotizacion.id);
  if (!cotizacion.detalles.length)
    cotizacion.detalles = [{ tipo: 'Repuesto', descripcion: '', cantidad: 1, precio_unitario: 0 }];
  if (!cotizacion.tipo_cambio) cotizacion.tipo_cambio = getTipoCambio();

  const vehiculos = db
    .prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre AS cliente_nombre
              FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`)
    .all();
  res.render('cotizaciones/form', { title: 'Editar Cotizacion', cotizacion, vehiculos, errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { vehiculo_id, estado, moneda, tipo_cambio, aplica_iva, iva_porcentaje, notas, garantia } = req.body;
  const detalles = parseDetalles(req.body);
  const errors = [];
  if (!vehiculo_id)    errors.push('Debe seleccionar un vehiculo');
  if (!detalles.length) errors.push('Debe agregar al menos un item');
  if (errors.length) {
    const vehiculos = db
      .prepare(`SELECT v.id, v.placa, v.marca, v.modelo, c.nombre AS cliente_nombre
                FROM vehiculos v JOIN clientes c ON v.cliente_id = c.id ORDER BY c.nombre, v.placa`)
      .all();
    return res.render('cotizaciones/form', {
      title: 'Editar Cotizacion',
      cotizacion: { ...req.body, id: req.params.id, aplica_iva: aplica_iva ? 1 : 0, detalles },
      vehiculos, errors,
    });
  }

  const tc     = parseFloat(tipo_cambio) || getTipoCambio();
  const ivaOn  = aplica_iva === 'on' ? 1 : 0;
  const ivaPct = parseFloat(iva_porcentaje) || 13;

  db.transaction(() => {
    db.prepare(
      'UPDATE cotizaciones SET vehiculo_id=?, estado=?, moneda=?, tipo_cambio=?, aplica_iva=?, iva_porcentaje=?, notas=?, garantia=? WHERE id=?'
    ).run(vehiculo_id, estado || 'Borrador', moneda || 'USD', tc, ivaOn, ivaPct, notas?.trim(), garantia?.trim() || null, req.params.id);
    db.prepare('DELETE FROM cotizacion_detalles WHERE cotizacion_id=?').run(req.params.id);
    const ins = db.prepare(
      'INSERT INTO cotizacion_detalles (cotizacion_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?,?,?,?,?)'
    );
    for (const d of detalles) ins.run(req.params.id, d.tipo, d.descripcion, d.cantidad, d.precio_unitario);
  })();

  res.flash('success', 'Cotizacion actualizada');
  res.redirect(`/cotizaciones/${req.params.id}`);
});

// ─── PDF (descarga/inline) ───────────────────────────────────────────────────

router.get('/:id/pdf', (req, res) => {
  const resultado = construirPDF(req.params.id);
  if (!resultado) return res.status(404).send('No encontrada');
  const { doc, cot } = resultado;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=cotizacion-${cot.numero}.pdf`);
  doc.pipe(res);
  doc.end();
});

// ─── CSV (exportar para facturacion) ─────────────────────────────────────────

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[,"\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

router.get('/:id/csv', (req, res) => {
  const cot = db
    .prepare(`
      SELECT cot.*, v.placa, v.marca, v.modelo,
             cl.nombre AS cliente_nombre, cl.cedula, cl.telefono, cl.email
      FROM cotizaciones cot
      JOIN vehiculos v  ON cot.vehiculo_id = v.id
      JOIN clientes  cl ON v.cliente_id    = cl.id
      WHERE cot.id = ?
    `)
    .get(req.params.id);

  if (!cot) return res.status(404).send('Cotizacion no encontrada');

  const detalles = db.prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?').all(cot.id);
  const t = calcTotales(detalles, cot.aplica_iva, cot.iva_porcentaje || 0);
  const mon = cot.moneda || 'USD';
  const tc  = cot.tipo_cambio || getTipoCambio();
  const fmtNum = (n) => n.toFixed(2);

  const rows = [];

  // Cabecera informativa
  rows.push([csvCell('Numero'),      csvCell(cot.numero)].join(','));
  rows.push([csvCell('Fecha'),       csvCell(cot.fecha ? cot.fecha.substring(0, 10) : '')].join(','));
  rows.push([csvCell('Estado'),      csvCell(cot.estado || 'Borrador')].join(','));
  rows.push([csvCell('Cliente'),     csvCell(cot.cliente_nombre)].join(','));
  rows.push([csvCell('Cedula'),      csvCell(cot.cedula || '')].join(','));
  rows.push([csvCell('Telefono'),    csvCell(cot.telefono || '')].join(','));
  rows.push([csvCell('Email'),       csvCell(cot.email || '')].join(','));
  rows.push([csvCell('Vehiculo'),    csvCell(`${cot.marca} ${cot.modelo}`)].join(','));
  rows.push([csvCell('Placa'),       csvCell(cot.placa)].join(','));
  rows.push([csvCell('Moneda'),      csvCell(mon)].join(','));
  rows.push([csvCell('Tipo Cambio'), csvCell(fmtNum(tc))].join(','));
  rows.push([csvCell('Garantia'),    csvCell(cot.garantia || '')].join(','));

  // Linea separadora + encabezado de tabla
  rows.push('');
  rows.push([
    csvCell('Tipo'),
    csvCell('Descripcion'),
    csvCell('Cantidad'),
    csvCell('Precio Unitario'),
    csvCell('Subtotal'),
  ].join(','));

  // Filas de detalle
  for (const d of detalles) {
    const sub = d.cantidad * d.precio_unitario;
    rows.push([
      csvCell(d.tipo),
      csvCell(d.descripcion),
      csvCell(fmtNum(d.cantidad)),
      csvCell(fmtNum(d.precio_unitario)),
      csvCell(fmtNum(sub)),
    ].join(','));
  }

  // Totales
  rows.push('');
  rows.push([csvCell(''), csvCell(''), csvCell(''), csvCell('Subtotal'), csvCell(fmtNum(t.subtotal))].join(','));
  if (cot.aplica_iva) {
    rows.push([csvCell(''), csvCell(''), csvCell(''), csvCell(`IVA (${cot.iva_porcentaje || 0}%)`), csvCell(fmtNum(t.iva))].join(','));
  }
  rows.push([csvCell(''), csvCell(''), csvCell(''), csvCell('Total'), csvCell(fmtNum(t.total))].join(','));

  // BOM UTF-8 + contenido
  const csv = '﻿' + rows.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=cotizacion-${cot.numero}.csv`);
  res.send(csv);
});

// ─── Enviar por correo ────────────────────────────────────────────────────────

router.post('/:id/enviar-correo', async (req, res) => {
  const id = req.params.id;
  try {
    // Cargar cotizacion con email del cliente
    const row = db
      .prepare(`
        SELECT cot.numero, cl.email AS cliente_email, cl.nombre AS cliente_nombre
        FROM cotizaciones cot
        JOIN vehiculos v  ON cot.vehiculo_id = v.id
        JOIN clientes  cl ON v.cliente_id    = cl.id
        WHERE cot.id = ?
      `)
      .get(id);

    if (!row) {
      res.flash('danger', 'Cotizacion no encontrada');
      return res.redirect('/cotizaciones');
    }

    // Destinatario: override de req.body.email o el del cliente
    const to = req.body.email?.trim() || row.cliente_email?.trim();
    if (!to) {
      res.flash('danger', 'El cliente no tiene correo registrado');
      return res.redirect(`/cotizaciones/${id}`);
    }

    // Generar PDF a Buffer
    const pdfResult = await cotizacionPDFBuffer(id);
    if (!pdfResult) {
      res.flash('danger', 'No se pudo generar el PDF de la cotizacion');
      return res.redirect(`/cotizaciones/${id}`);
    }
    const { buffer, cot } = pdfResult;

    const nombreTaller = getConfig('nombre_taller') || 'Taller Mecanico';
    const subject = `Cotizacion ${cot.numero} - ${nombreTaller}`;
    const textBody =
      `Estimado/a ${row.cliente_nombre},\n\n` +
      `Adjunto encontrara la cotizacion ${cot.numero} emitida por ${nombreTaller}.\n\n` +
      `Si tiene alguna consulta, no dude en contactarnos.\n\n` +
      `Atentamente,\n${nombreTaller}`;
    const htmlBody =
      `<p>Estimado/a <strong>${row.cliente_nombre}</strong>,</p>` +
      `<p>Adjunto encontrara la cotizacion <strong>${cot.numero}</strong> emitida por <strong>${nombreTaller}</strong>.</p>` +
      `<p>Si tiene alguna consulta, no dude en contactarnos.</p>` +
      `<p>Atentamente,<br><strong>${nombreTaller}</strong></p>`;

    const resultado = await mailer.enviarCorreo({
      to,
      subject,
      text: textBody,
      html: htmlBody,
      attachments: [
        { filename: `cotizacion-${cot.numero}.pdf`, content: buffer, contentType: 'application/pdf' },
      ],
    });

    if (resultado.simulado) {
      res.flash('danger', 'El correo no esta configurado (SMTP). Configura SMTP_* para enviar.');
    } else if (resultado.enviado) {
      res.flash('success', `Cotizacion enviada a ${to}`);
    }
  } catch (err) {
    console.error('[enviar-correo] Error al enviar cotizacion:', err);
    res.flash('danger', 'No se pudo enviar el correo: ' + err.message);
  }
  return res.redirect(`/cotizaciones/${id}`);
});

// ─── Cambio rapido de estado ──────────────────────────────────────────────────
// POST /:id/estado  body: { estado }
// Usado por los botones Enviar / Aprobar / Rechazar de la vista.

router.post('/:id/estado', (req, res) => {
  const id     = req.params.id;
  const estado = (req.body.estado || '').trim();

  if (!estados.ESTADOS_COTIZACION.includes(estado)) {
    res.flash('danger', `Estado invalido: ${estado}`);
    return res.redirect(`/cotizaciones/${id}`);
  }

  const fila = db.prepare('SELECT estado FROM cotizaciones WHERE id = ?').get(id);
  if (!fila) {
    res.flash('danger', 'Cotizacion no encontrada');
    return res.redirect('/cotizaciones');
  }

  const estadoAnterior = fila.estado || 'Borrador';
  db.prepare('UPDATE cotizaciones SET estado = ? WHERE id = ?').run(estado, id);

  audit.registrar({
    usuario:        req.session.usuario,
    accion:         'cambio_estado',
    entidad:        'cotizacion',
    entidad_id:     id,
    estado_anterior: estadoAnterior,
    estado_nuevo:   estado,
  });

  res.flash('success', `Cotizacion marcada como ${estado}`);
  return res.redirect(`/cotizaciones/${id}`);
});

// ─── Marcar pagada ────────────────────────────────────────────────────────────
// POST /:id/marcar-pagada

router.post('/:id/marcar-pagada', (req, res) => {
  const id       = req.params.id;
  const fila     = db.prepare('SELECT estado FROM cotizaciones WHERE id = ?').get(id);

  if (!fila) {
    res.flash('danger', 'Cotizacion no encontrada');
    return res.redirect('/cotizaciones');
  }

  const estadoAnterior = fila.estado || 'Borrador';
  const fechaPago      = new Date().toLocaleString('es-CR');

  db.prepare('UPDATE cotizaciones SET estado = ?, fecha_pago = ? WHERE id = ?')
    .run('Pagada', fechaPago, id);

  audit.registrar({
    usuario:         req.session.usuario,
    accion:          'pago',
    entidad:         'cotizacion',
    entidad_id:      id,
    estado_anterior: estadoAnterior,
    estado_nuevo:    'Pagada',
    detalle:         `Fecha de pago: ${fechaPago}`,
  });

  res.flash('success', 'Cotizacion marcada como pagada');
  return res.redirect(`/cotizaciones/${id}`);
});

// ─── Convertir a Orden de Servicio ────────────────────────────────────────────
// POST /:id/convertir

router.post('/:id/convertir', (req, res) => {
  const cotId = req.params.id;

  const cot = db.prepare(`
    SELECT cot.*, v.id AS v_id
    FROM cotizaciones cot
    JOIN vehiculos v ON cot.vehiculo_id = v.id
    WHERE cot.id = ?
  `).get(cotId);

  if (!cot) {
    return res.status(404).render('partials/error', {
      title:   'Error',
      message: 'Cotizacion no encontrada',
    });
  }

  const detallesCot = db
    .prepare('SELECT * FROM cotizacion_detalles WHERE cotizacion_id = ?')
    .all(cotId);

  // Generar folio OT-YYYYNNNN replicando el patron de servicios.js
  const year   = new Date().getFullYear();
  const ultimo = db
    .prepare('SELECT numero FROM servicios WHERE numero LIKE ? ORDER BY id DESC LIMIT 1')
    .get(`OT-${year}%`);
  let seq = 1;
  if (ultimo) {
    const parte = ultimo.numero.slice(3); // "YYYYNNNN"
    seq = parseInt(parte.slice(4), 10) + 1;
  }
  const folio = `OT-${year}${String(seq).padStart(4, '0')}`;

  let nuevoServicioId;
  db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO servicios (vehiculo_id, numero, descripcion, estado, costo) VALUES (?, ?, ?, ?, ?)'
    ).run(
      cot.vehiculo_id,
      folio,
      `Generada desde cotizacion ${cot.numero}`,
      'Pendiente',
      0
    );
    nuevoServicioId = r.lastInsertRowid;

    const insItem = db.prepare(
      'INSERT INTO servicio_items (servicio_id, tipo, descripcion, cantidad, precio_unitario) VALUES (?, ?, ?, ?, ?)'
    );
    for (const d of detallesCot) {
      insItem.run(nuevoServicioId, d.tipo, d.descripcion, d.cantidad, d.precio_unitario);
    }
  })();

  audit.registrar({
    usuario:    req.session.usuario,
    accion:     'convertir',
    entidad:    'cotizacion',
    entidad_id: cotId,
    detalle:    `Orden ${folio} creada`,
  });

  res.flash('success', `Orden ${folio} creada desde la cotizacion`);
  return res.redirect(`/servicios/${nuevoServicioId}`);
});

// ─── Eliminar ─────────────────────────────────────────────────────────────────

router.post('/:id/eliminar', (req, res) => {
  db.prepare('DELETE FROM cotizaciones WHERE id = ?').run(req.params.id);
  res.flash('success', 'Cotizacion eliminada');
  res.redirect('/cotizaciones');
});

// ─── Helper: parsear detalles del form ───────────────────────────────────────

function parseDetalles(body) {
  const detalles = [];
  if (!body.det_tipo) return detalles;
  const tipos   = Array.isArray(body.det_tipo)        ? body.det_tipo        : [body.det_tipo];
  const descs   = Array.isArray(body.det_descripcion) ? body.det_descripcion : [body.det_descripcion];
  const cants   = Array.isArray(body.det_cantidad)    ? body.det_cantidad    : [body.det_cantidad];
  const precios = Array.isArray(body.det_precio)      ? body.det_precio      : [body.det_precio];
  for (let i = 0; i < tipos.length; i++) {
    if (descs[i]?.trim()) {
      detalles.push({
        tipo:           tipos[i] || 'Repuesto',
        descripcion:    descs[i].trim(),
        cantidad:       parseFloat(cants[i]) || 1,
        precio_unitario: parseFloat(precios[i]) || 0,
      });
    }
  }
  return detalles;
}

module.exports = router;
module.exports.construirPDF = construirPDF;
