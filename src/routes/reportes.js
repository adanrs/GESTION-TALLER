const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const fs = require('fs');
const db = require('../db/database');
const { rutaSegura } = require('../lib/uploads');

// ── Helpers de configuracion ────────────────────────────────────────────────
function getAllConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const c = {};
  rows.forEach(r => (c[r.clave] = r.valor));
  return c;
}

function simboloPDF(moneda) {
  return moneda === 'CRC' ? '₡' : '$';
}

function fmtFecha(str) {
  if (!str) return '-';
  return String(str).substring(0, 10);
}

// ── Helper: dibujar encabezado de pagina (taller + titulo) ──────────────────
function drawPageHeader(doc, cfg, titulo, L, R, W) {
  doc.fontSize(16).font('Helvetica-Bold').text(cfg.nombre_taller || 'Taller Mecanico', L, 50, { width: W / 2 });

  doc.fontSize(8).font('Helvetica');
  let hy = 70;
  if (cfg.direccion_taller) { doc.text(cfg.direccion_taller, L, hy); hy += 11; }
  if (cfg.telefono_taller)  { doc.text(`Tel: ${cfg.telefono_taller}`, L, hy); hy += 11; }
  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366').text(`WhatsApp: ${cfg.whatsapp_taller}`, L, hy, {
      link: `https://wa.me/${cfg.whatsapp_taller}`, underline: true
    });
    doc.fillColor('#000000');
    hy += 11;
  }
  if (cfg.email_taller) {
    doc.fillColor('#0066cc').text(cfg.email_taller, L, hy, {
      link: `mailto:${cfg.email_taller}`, underline: true
    });
    doc.fillColor('#000000');
    hy += 11;
  }

  // Titulo a la derecha
  const rx = L + W / 2 + 20;
  doc.fontSize(18).font('Helvetica-Bold').text(titulo, rx, 50, { width: W / 2 - 20, align: 'right' });
  doc.fontSize(8).font('Helvetica').fillColor('#666666')
    .text(`Generado: ${new Date().toLocaleDateString('es-CR')}`, rx, 72, { width: W / 2 - 20, align: 'right' });
  doc.fillColor('#000000');

  const divY = Math.max(hy, 100) + 8;
  doc.moveTo(L, divY).lineTo(R, divY).lineWidth(2).strokeColor('#333333').stroke();
  doc.lineWidth(1).strokeColor('#000000');
  return divY + 12;
}

// ── Helper: footer de pagina ────────────────────────────────────────────────
function drawFooter(doc, cfg, L, R, W, y) {
  let fy = Math.max(y + 20, 690);
  if (fy > 730) { doc.addPage(); fy = 50; }
  doc.moveTo(L, fy).lineTo(R, fy).strokeColor('#cccccc').stroke();
  fy += 6;
  doc.fontSize(7).font('Helvetica');
  if (cfg.whatsapp_taller) {
    doc.fillColor('#25D366').text(`Contactenos: wa.me/${cfg.whatsapp_taller}`, L, fy, {
      link: `https://wa.me/${cfg.whatsapp_taller}`, underline: true, continued: false
    });
    fy += 10;
  }
  doc.fillColor('#999999').text('Historial de vehiculo generado por el sistema de gestion de taller.', L, fy, { width: W, align: 'center' });
}

// ── Helper: encabezado de seccion ───────────────────────────────────────────
function sectionTitle(doc, text, y, L, R) {
  doc.rect(L, y, R - L, 16).fill('#1a1a2e');
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold').text(text, L + 4, y + 3);
  doc.fillColor('#000000');
  return y + 20;
}

// ── Helper: verificar salto de pagina ───────────────────────────────────────
function checkPage(doc, y, threshold) {
  if (y > threshold) {
    doc.addPage();
    return 50;
  }
  return y;
}

// ── GET /reportes/vehiculo/:id ──────────────────────────────────────────────
router.get('/vehiculo/:id', (req, res) => {
  const id = req.params.id;

  // Vehiculo + cliente
  const vehiculo = db.prepare(`
    SELECT v.*, c.nombre as cliente_nombre, c.cedula, c.telefono, c.email
    FROM vehiculos v
    JOIN clientes c ON v.cliente_id = c.id
    WHERE v.id = ?
  `).get(id);

  if (!vehiculo) {
    return res.status(404).send('Vehiculo no encontrado');
  }

  // Servicios ordenados por fecha desc; mecanico via JOIN, repuestos como suma
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
  `).all(id);

  // Items por servicio (repuestos/materiales)
  const itemsStmt = db.prepare(`
    SELECT * FROM servicio_items WHERE servicio_id = ? ORDER BY id
  `);

  // Tareas por servicio
  const tareasStmt = db.prepare(`
    SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY id
  `);

  // Cotizaciones con total calculado (incluye IVA si aplica)
  const cotizaciones = db.prepare(`
    SELECT cot.*,
           COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS subtotal_items
    FROM cotizaciones cot
    LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
    WHERE cot.vehiculo_id = ?
    GROUP BY cot.id
    ORDER BY cot.fecha DESC
  `).all(id);

  // Calcular total de cotizaciones (con IVA donde aplica)
  cotizaciones.forEach(c => {
    const sub = c.subtotal_items || 0;
    const iva = c.aplica_iva ? sub * ((c.iva_porcentaje || 0) / 100) : 0;
    c.total_calculado = sub + iva;
  });

  const cfg = getAllConfig();

  // ── Construir PDF ─────────────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const placa = (vehiculo.placa || String(id)).replace(/\s+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=reporte-vehiculo-${placa}.pdf`);
  doc.pipe(res);

  const L = 50, R = 562, W = R - L;

  // ── Encabezado pagina ─────────────────────────────────────────────────────
  let y = drawPageHeader(doc, cfg, 'REPORTE DE VEHICULO', L, R, W);

  // ── Bloque: datos del vehiculo ────────────────────────────────────────────
  // Izquierda: vehiculo
  const colMid = L + W / 2 + 10;

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('VEHICULO', L, y);
  doc.fillColor('#000000').font('Helvetica');
  let vyL = y + 13;
  doc.fontSize(9).text(`Placa: ${vehiculo.placa || '-'}`, L, vyL); vyL += 11;
  doc.text(`Marca / Modelo: ${vehiculo.marca || ''} ${vehiculo.modelo || ''}`, L, vyL); vyL += 11;
  if (vehiculo.ano)   { doc.text(`Ano: ${vehiculo.ano}`, L, vyL); vyL += 11; }
  if (vehiculo.color) { doc.text(`Color: ${vehiculo.color}`, L, vyL); vyL += 11; }
  if (vehiculo.vin)   { doc.text(`VIN: ${vehiculo.vin}`, L, vyL); vyL += 11; }

  // Derecha: cliente
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('CLIENTE', colMid, y);
  doc.fillColor('#000000').font('Helvetica');
  let vyR = y + 13;
  doc.fontSize(9).text(vehiculo.cliente_nombre || '-', colMid, vyR); vyR += 11;
  if (vehiculo.cedula)   { doc.text(`Cedula/ID: ${vehiculo.cedula}`, colMid, vyR); vyR += 11; }
  if (vehiculo.telefono) { doc.text(`Tel: ${vehiculo.telefono}`, colMid, vyR); vyR += 11; }
  if (vehiculo.email) {
    doc.fillColor('#0066cc').text(vehiculo.email, colMid, vyR, { link: `mailto:${vehiculo.email}`, underline: true });
    doc.fillColor('#000000'); vyR += 11;
  }

  y = Math.max(vyL, vyR) + 14;

  // ── SECCION: SERVICIOS REALIZADOS ─────────────────────────────────────────
  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'SERVICIOS REALIZADOS', y, L, R);

  if (servicios.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('No hay servicios registrados para este vehiculo.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    let totalGeneral = 0;

    servicios.forEach((s, idx) => {
      const items = itemsStmt.all(s.id);
      const tareas = tareasStmt.all(s.id);

      // Altura estimada minima para este servicio
      const estimado = 50 + items.length * 13 + (tareas.length > 0 ? tareas.length * 11 + 10 : 0);
      y = checkPage(doc, y, 720 - Math.min(estimado, 80));

      // Encabezado de servicio: fondo gris claro
      doc.rect(L, y, W, 14).fill('#eeeeee');
      doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold');
      doc.text(`#${idx + 1}  ${fmtFecha(s.fecha)}  |  ${s.descripcion || '-'}`, L + 4, y + 2, { width: W * 0.65 });
      const estadoBadge = s.estado || '';
      doc.text(estadoBadge, L + W * 0.65, y + 2, { width: W * 0.35 - 4, align: 'right' });
      doc.fillColor('#000000');
      y += 17;

      // Datos del servicio: 3 columnas
      doc.fontSize(8).font('Helvetica');
      const col1 = L, col2 = L + W / 3, col3 = L + (2 * W) / 3;
      doc.text(`Mecanico: ${s.mecanico_nombre || '-'}`, col1, y, { width: W / 3 - 4 });
      doc.text(`Km: ${s.kilometraje || '-'}`, col2, y, { width: W / 3 - 4 });
      const costoServicio = parseFloat(s.costo) || 0;
      doc.text(`Costo mano de obra: ${simboloPDF('USD')}${costoServicio.toFixed(2)}`, col3, y, { width: W / 3 });
      y += 12;

      // Items / repuestos
      if (items.length > 0) {
        y = checkPage(doc, y, 720);
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#555555');
        doc.text('REPUESTO / MATERIAL', L + 8, y, { width: 220 });
        doc.text('CANT', L + 230, y, { width: 40, align: 'right' });
        doc.text('P.UNIT', L + 275, y, { width: 65, align: 'right' });
        doc.text('SUBTOTAL', L + 345, y, { width: 70, align: 'right' });
        doc.fillColor('#000000');
        y += 10;
        doc.moveTo(L + 4, y).lineTo(R, y).strokeColor('#dddddd').stroke();
        y += 3;

        items.forEach((it, ii) => {
          y = checkPage(doc, y, 720);
          const sub = (parseFloat(it.cantidad) || 0) * (parseFloat(it.precio_unitario) || 0);
          if (ii % 2 === 0) {
            doc.rect(L + 4, y - 1, W - 4, 12).fill('#f9f9f9');
            doc.fillColor('#000000');
          }
          doc.fontSize(7).font('Helvetica');
          doc.text(it.descripcion || '-', L + 8, y, { width: 220 });
          doc.text(String(it.cantidad || 0), L + 230, y, { width: 40, align: 'right' });
          doc.text(`${simboloPDF('USD')}${(parseFloat(it.precio_unitario) || 0).toFixed(2)}`, L + 275, y, { width: 65, align: 'right' });
          doc.text(`${simboloPDF('USD')}${sub.toFixed(2)}`, L + 345, y, { width: 70, align: 'right' });
          y += 12;
        });
      }

      // Tareas (si existen)
      if (tareas.length > 0) {
        y = checkPage(doc, y, 720);
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#555555').text('Tareas:', L + 8, y);
        doc.fillColor('#000000');
        y += 10;
        tareas.forEach(t => {
          y = checkPage(doc, y, 720);
          const check = t.completado ? '[x]' : '[ ]';
          doc.fontSize(7).font('Helvetica').text(`${check} ${t.descripcion || ''}`, L + 12, y, { width: W - 12 });
          y += 10;
        });
      }

      // Subtotal del servicio
      const subtotalServicio = costoServicio + (parseFloat(s.total_repuestos) || 0);
      totalGeneral += subtotalServicio;

      doc.fontSize(8).font('Helvetica-Bold');
      doc.text(`Subtotal servicio:`, R - 200, y, { width: 130, align: 'right' });
      doc.text(`${simboloPDF('USD')}${subtotalServicio.toFixed(2)}`, R - 70, y, { width: 70, align: 'right' });
      doc.font('Helvetica');
      y += 12;

      // Separador entre servicios
      doc.moveTo(L, y).lineTo(R, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.lineWidth(1);
      y += 6;
    });

    // Total general de servicios
    y = checkPage(doc, y, 720);
    doc.rect(R - 210, y - 2, 210, 20).fill('#1a1a2e');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    doc.text('TOTAL SERVICIOS:', R - 210, y + 2, { width: 135, align: 'right' });
    doc.text(`${simboloPDF('USD')}${totalGeneral.toFixed(2)}`, R - 75, y + 2, { width: 75, align: 'right' });
    doc.fillColor('#000000');
    y += 28;
  }

  // ── SECCION: COTIZACIONES ─────────────────────────────────────────────────
  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'COTIZACIONES', y, L, R);

  if (cotizaciones.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('No hay cotizaciones para este vehiculo.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    // Encabezado tabla
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
    doc.text('NUMERO', L, y, { width: 110 });
    doc.text('FECHA', L + 115, y, { width: 80 });
    doc.text('MONEDA', L + 200, y, { width: 70 });
    doc.text('ESTADO', L + 275, y, { width: 90 });
    doc.text('TOTAL', L + 370, y, { width: 80, align: 'right' });
    doc.fillColor('#000000');
    y += 11;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#cccccc').stroke();
    y += 3;

    let totalCotizaciones = 0;

    cotizaciones.forEach((c, i) => {
      y = checkPage(doc, y, 720);
      if (i % 2 === 0) {
        doc.rect(L, y - 1, W, 13).fill('#f8f8f8');
        doc.fillColor('#000000');
      }
      const monSim = simboloPDF(c.moneda || 'USD');
      const total = parseFloat(c.total_calculado) || 0;
      totalCotizaciones += total;

      doc.fontSize(8).font('Helvetica');
      doc.text(c.numero || '-', L, y, { width: 110 });
      doc.text(fmtFecha(c.fecha), L + 115, y, { width: 80 });
      doc.text(c.moneda || 'USD', L + 200, y, { width: 70 });
      doc.text(c.estado || '-', L + 275, y, { width: 90 });
      doc.text(`${monSim}${total.toFixed(2)}`, L + 370, y, { width: 80, align: 'right' });
      y += 13;
    });

    // Nota: totales en monedas mixtas; mostramos suma nominal
    y += 4;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#333333').lineWidth(1.5).stroke();
    doc.lineWidth(1);
    y += 6;
    doc.fontSize(7).font('Helvetica').fillColor('#888888')
      .text('* El total de cotizaciones es la suma nominal; las monedas pueden variar entre cotizaciones.', L, y, { width: W });
    doc.fillColor('#000000');
    y += 14;
  }

  // ── SECCION: FOTOS DEL VEHICULO ──────────────────────────────────────────
  const MAX_FOTOS = 12;
  const THUMB_W   = 160;
  const THUMB_H   = 120;
  const COLS      = 3;
  const CELL_W    = Math.floor(W / COLS);   // ~170px para 3 columnas en W=512
  const CAPTION_H = 14;                     // altura reservada para descripcion
  const ROW_H     = THUMB_H + CAPTION_H + 12; // margen inferior entre filas

  const fotosRaw = db.prepare(`
    SELECT * FROM fotos
    WHERE vehiculo_id = ?
       OR servicio_id IN (SELECT id FROM servicios WHERE vehiculo_id = ?)
    ORDER BY fecha DESC, id DESC
  `).all(vehiculo.id, vehiculo.id);

  const fotosMostrar = fotosRaw.slice(0, MAX_FOTOS);
  const fotosOmitidas = fotosRaw.length - fotosMostrar.length;

  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'FOTOS DEL VEHICULO', y, L, R);

  if (fotosMostrar.length === 0) {
    doc.fontSize(8).font('Helvetica').fillColor('#888888')
      .text('Sin fotos registradas.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    // Dibujar grilla de miniaturas
    fotosMostrar.forEach((foto, idx) => {
      const col = idx % COLS;

      // Al inicio de cada fila: verificar espacio
      if (col === 0) {
        y = checkPage(doc, y, 750 - ROW_H);
        if (y === 50 && idx > 0) {
          // nueva pagina: no hacer nada extra, y ya se reseteo a 50
        }
      }

      const xImg = L + col * CELL_W + 4; // sangria de 4px dentro de la celda
      const yImg = y;

      // Obtener ruta absoluta y segura
      const rutaAbsoluta = rutaSegura(foto.archivo);

      // Intentar incrustar imagen; omitir silenciosamente si falla
      if (rutaAbsoluta && fs.existsSync(rutaAbsoluta)) {
        try {
          doc.image(rutaAbsoluta, xImg, yImg, { fit: [THUMB_W, THUMB_H] });
        } catch (_) {
          // Formato no soportado (ej. WEBP) o archivo corrupto: omitir sin romper el PDF
          doc.rect(xImg, yImg, THUMB_W, THUMB_H).strokeColor('#cccccc').lineWidth(0.5).stroke();
          doc.lineWidth(1);
          doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa')
            .text('Formato no soportado', xImg + 4, yImg + THUMB_H / 2 - 4, { width: THUMB_W - 8, align: 'center' });
          doc.fillColor('#000000');
        }
      } else {
        // Archivo ausente: dibujar placeholder
        doc.rect(xImg, yImg, THUMB_W, THUMB_H).strokeColor('#cccccc').lineWidth(0.5).stroke();
        doc.lineWidth(1);
        doc.fontSize(7).font('Helvetica').fillColor('#aaaaaa')
          .text('Archivo no disponible', xImg + 4, yImg + THUMB_H / 2 - 4, { width: THUMB_W - 8, align: 'center' });
        doc.fillColor('#000000');
      }

      // Descripcion debajo de la miniatura (recortada a 1 linea)
      if (foto.descripcion) {
        const desc = String(foto.descripcion).slice(0, 60);
        doc.fontSize(6).font('Helvetica').fillColor('#444444')
          .text(desc, xImg, yImg + THUMB_H + 2, { width: THUMB_W, ellipsis: true, lineBreak: false });
        doc.fillColor('#000000');
      }

      // Al terminar la ultima columna de la fila, avanzar y
      if (col === COLS - 1 || idx === fotosMostrar.length - 1) {
        y += ROW_H;
      }
    });

    // Nota de fotos omitidas
    if (fotosOmitidas > 0) {
      y = checkPage(doc, y, 720);
      doc.fontSize(7).font('Helvetica').fillColor('#888888')
        .text(`(+${fotosOmitidas} foto${fotosOmitidas > 1 ? 's' : ''} no mostrada${fotosOmitidas > 1 ? 's' : ''} por limite de ${MAX_FOTOS})`, L, y, { width: W });
      doc.fillColor('#000000');
      y += 14;
    }
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────
  drawFooter(doc, cfg, L, R, W, y);

  doc.end();
});

// ── GET /reportes/cliente/:id ───────────────────────────────────────────────
router.get('/cliente/:id', (req, res) => {
  const id = req.params.id;

  // ── Cargar cliente ──────────────────────────────────────────────────────────
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  if (!cliente) {
    return res.status(404).send('Cliente no encontrado');
  }

  // ── Vehiculos del cliente ───────────────────────────────────────────────────
  const vehiculos = db.prepare(`
    SELECT id, placa, marca, modelo, ano, color
    FROM vehiculos
    WHERE cliente_id = ?
    ORDER BY placa ASC
  `).all(id);

  const vehiculoIds = vehiculos.map(v => v.id);

  // ── Servicios de todos los vehiculos del cliente ────────────────────────────
  // Necesita lista de IDs dinamica; usamos placeholders
  let servicios = [];
  if (vehiculoIds.length > 0) {
    const placeholders = vehiculoIds.map(() => '?').join(',');
    servicios = db.prepare(`
      SELECT s.*,
             v.placa AS placa_vehiculo,
             COALESCE(u.nombre, s.tecnico) AS mecanico_nombre,
             COALESCE((
               SELECT SUM(si.cantidad * si.precio_unitario)
               FROM servicio_items si WHERE si.servicio_id = s.id
             ), 0) AS total_repuestos
      FROM servicios s
      JOIN vehiculos v ON s.vehiculo_id = v.id
      LEFT JOIN usuarios u ON s.mecanico_id = u.id
      WHERE s.vehiculo_id IN (${placeholders})
      ORDER BY s.fecha DESC
    `).all(vehiculoIds);
  }

  // ── Cotizaciones de todos los vehiculos del cliente ─────────────────────────
  let cotizaciones = [];
  if (vehiculoIds.length > 0) {
    const placeholders = vehiculoIds.map(() => '?').join(',');
    cotizaciones = db.prepare(`
      SELECT cot.*,
             v.placa AS placa_vehiculo,
             COALESCE(SUM(d.cantidad * d.precio_unitario), 0) AS subtotal_items
      FROM cotizaciones cot
      JOIN vehiculos v ON cot.vehiculo_id = v.id
      LEFT JOIN cotizacion_detalles d ON d.cotizacion_id = cot.id
      WHERE cot.vehiculo_id IN (${placeholders})
      GROUP BY cot.id
      ORDER BY cot.fecha DESC
    `).all(vehiculoIds);
  }

  // Calcular total de cotizaciones (con IVA donde aplica)
  cotizaciones.forEach(c => {
    const sub = c.subtotal_items || 0;
    const iva = c.aplica_iva ? sub * ((c.iva_porcentaje || 0) / 100) : 0;
    c.total_calculado = sub + iva;
  });

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const totalOrdenes = servicios.length;
  const serviciosCobrados = servicios.filter(s => s.estado === 'Cobrado' || s.cobrado === 1);
  const totalGastado = serviciosCobrados.reduce((acc, s) => {
    return acc + (parseFloat(s.costo) || 0) + (parseFloat(s.total_repuestos) || 0);
  }, 0);

  // Detectar monedas mixtas en cotizaciones (todas estan en USD en servicios)
  const monedasEnCot = [...new Set(cotizaciones.map(c => c.moneda || 'USD'))];
  const hayMonedasMixtas = monedasEnCot.length > 1;

  const cfg = getAllConfig();

  // ── Construir PDF ───────────────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const safeId = String(id).replace(/\s+/g, '-');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=reporte-cliente-${safeId}.pdf`);
  doc.pipe(res);

  const L = 50, R = 562, W = R - L;

  // ── Encabezado pagina ───────────────────────────────────────────────────────
  let y = drawPageHeader(doc, cfg, 'HISTORIAL DEL CLIENTE', L, R, W);

  // ── Bloque: datos del cliente ───────────────────────────────────────────────
  const colMid = L + W / 2 + 10;

  doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('CLIENTE', L, y);
  doc.fillColor('#000000').font('Helvetica');
  let vyL = y + 13;
  doc.fontSize(9).text(cliente.nombre || '-', L, vyL); vyL += 11;
  if (cliente.cedula)   { doc.text(`Cedula/ID: ${cliente.cedula}`, L, vyL); vyL += 11; }
  if (cliente.telefono) { doc.text(`Tel: ${cliente.telefono}`, L, vyL); vyL += 11; }
  if (cliente.email) {
    doc.fillColor('#0066cc').text(cliente.email, L, vyL, { link: `mailto:${cliente.email}`, underline: true });
    doc.fillColor('#000000'); vyL += 11;
  }
  if (cliente.direccion) { doc.text(`Dir: ${cliente.direccion}`, L, vyL); vyL += 11; }

  // KPIs a la derecha del encabezado del cliente
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('RESUMEN', colMid, y);
  doc.fillColor('#000000').font('Helvetica');
  let vyR = y + 13;
  doc.fontSize(9).text(`Vehiculos: ${vehiculos.length}`, colMid, vyR); vyR += 11;
  doc.text(`Total ordenes: ${totalOrdenes}`, colMid, vyR); vyR += 11;
  doc.text(`Ordenes cobradas: ${serviciosCobrados.length}`, colMid, vyR); vyR += 11;
  doc.font('Helvetica-Bold').text(`Total gastado: ${simboloPDF('USD')}${totalGastado.toFixed(2)}`, colMid, vyR);
  doc.font('Helvetica'); vyR += 11;

  y = Math.max(vyL, vyR) + 14;

  // ── SECCION: VEHICULOS DEL CLIENTE ──────────────────────────────────────────
  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'VEHICULOS DEL CLIENTE', y, L, R);

  if (vehiculos.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('No hay vehiculos registrados para este cliente.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    // Encabezado tabla
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
    doc.text('PLACA', L, y, { width: 90 });
    doc.text('MARCA', L + 95, y, { width: 110 });
    doc.text('MODELO', L + 210, y, { width: 120 });
    doc.text('ANO', L + 335, y, { width: 60 });
    doc.text('COLOR', L + 400, y, { width: W - 400 });
    doc.fillColor('#000000');
    y += 11;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#cccccc').stroke();
    y += 3;

    vehiculos.forEach((v, i) => {
      y = checkPage(doc, y, 720);
      if (i % 2 === 0) {
        doc.rect(L, y - 1, W, 13).fill('#f8f8f8');
        doc.fillColor('#000000');
      }
      doc.fontSize(8).font('Helvetica');
      doc.text(v.placa || '-', L, y, { width: 90 });
      doc.text(v.marca || '-', L + 95, y, { width: 110 });
      doc.text(v.modelo || '-', L + 210, y, { width: 120 });
      doc.text(v.ano ? String(v.ano) : '-', L + 335, y, { width: 60 });
      doc.text(v.color || '-', L + 400, y, { width: W - 400 });
      y += 13;
    });
    y += 6;
  }

  // ── SECCION: SERVICIOS ──────────────────────────────────────────────────────
  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'SERVICIOS REALIZADOS', y, L, R);

  if (servicios.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('No hay servicios registrados para este cliente.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    // Statements para items y tareas de cada servicio
    const itemsStmt = db.prepare('SELECT * FROM servicio_items WHERE servicio_id = ? ORDER BY id');
    const tareasStmt = db.prepare('SELECT * FROM servicio_tareas WHERE servicio_id = ? ORDER BY orden, id');

    let totalGeneral = 0;

    servicios.forEach((s, idx) => {
      const items = itemsStmt.all(s.id);
      const tareas = tareasStmt.all(s.id);

      const estimado = 50 + items.length * 13 + (tareas.length > 0 ? tareas.length * 11 + 10 : 0);
      y = checkPage(doc, y, 720 - Math.min(estimado, 80));

      // Encabezado de servicio: fondo gris claro
      doc.rect(L, y, W, 14).fill('#eeeeee');
      doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold');
      // Incluye placa para distinguir vehiculo
      doc.text(
        `#${idx + 1}  ${fmtFecha(s.fecha)}  |  [${s.placa_vehiculo || '-'}]  ${s.descripcion || '-'}`,
        L + 4, y + 2, { width: W * 0.65 }
      );
      doc.text(s.estado || '', L + W * 0.65, y + 2, { width: W * 0.35 - 4, align: 'right' });
      doc.fillColor('#000000');
      y += 17;

      // Datos del servicio: 3 columnas
      doc.fontSize(8).font('Helvetica');
      const col1 = L, col2 = L + W / 3, col3 = L + (2 * W) / 3;
      doc.text(`Mecanico: ${s.mecanico_nombre || '-'}`, col1, y, { width: W / 3 - 4 });
      doc.text(`Km: ${s.kilometraje || '-'}`, col2, y, { width: W / 3 - 4 });
      const costoServicio = parseFloat(s.costo) || 0;
      doc.text(`Costo mano de obra: ${simboloPDF('USD')}${costoServicio.toFixed(2)}`, col3, y, { width: W / 3 });
      y += 12;

      // Items / repuestos
      if (items.length > 0) {
        y = checkPage(doc, y, 720);
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#555555');
        doc.text('REPUESTO / MATERIAL', L + 8, y, { width: 220 });
        doc.text('CANT', L + 230, y, { width: 40, align: 'right' });
        doc.text('P.UNIT', L + 275, y, { width: 65, align: 'right' });
        doc.text('SUBTOTAL', L + 345, y, { width: 70, align: 'right' });
        doc.fillColor('#000000');
        y += 10;
        doc.moveTo(L + 4, y).lineTo(R, y).strokeColor('#dddddd').stroke();
        y += 3;

        items.forEach((it, ii) => {
          y = checkPage(doc, y, 720);
          const sub = (parseFloat(it.cantidad) || 0) * (parseFloat(it.precio_unitario) || 0);
          if (ii % 2 === 0) {
            doc.rect(L + 4, y - 1, W - 4, 12).fill('#f9f9f9');
            doc.fillColor('#000000');
          }
          doc.fontSize(7).font('Helvetica');
          doc.text(it.descripcion || '-', L + 8, y, { width: 220 });
          doc.text(String(it.cantidad || 0), L + 230, y, { width: 40, align: 'right' });
          doc.text(`${simboloPDF('USD')}${(parseFloat(it.precio_unitario) || 0).toFixed(2)}`, L + 275, y, { width: 65, align: 'right' });
          doc.text(`${simboloPDF('USD')}${sub.toFixed(2)}`, L + 345, y, { width: 70, align: 'right' });
          y += 12;
        });
      }

      // Tareas (si existen)
      if (tareas.length > 0) {
        y = checkPage(doc, y, 720);
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#555555').text('Tareas:', L + 8, y);
        doc.fillColor('#000000');
        y += 10;
        tareas.forEach(t => {
          y = checkPage(doc, y, 720);
          const check = t.completado ? '[x]' : '[ ]';
          doc.fontSize(7).font('Helvetica').text(`${check} ${t.descripcion || ''}`, L + 12, y, { width: W - 12 });
          y += 10;
        });
      }

      // Subtotal del servicio
      const subtotalServicio = costoServicio + (parseFloat(s.total_repuestos) || 0);
      totalGeneral += subtotalServicio;

      doc.fontSize(8).font('Helvetica-Bold');
      doc.text('Subtotal servicio:', R - 200, y, { width: 130, align: 'right' });
      doc.text(`${simboloPDF('USD')}${subtotalServicio.toFixed(2)}`, R - 70, y, { width: 70, align: 'right' });
      doc.font('Helvetica');
      y += 12;

      // Separador entre servicios
      doc.moveTo(L, y).lineTo(R, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
      doc.lineWidth(1);
      y += 6;
    });

    // Subtotal de servicios cobrados
    y = checkPage(doc, y, 720);
    doc.fontSize(8).font('Helvetica').fillColor('#555555');
    doc.text(
      `Subtotal cobrado (${serviciosCobrados.length} orden${serviciosCobrados.length !== 1 ? 'es' : ''} Cobrada${serviciosCobrados.length !== 1 ? 's' : ''}):`,
      R - 280, y, { width: 210, align: 'right' }
    );
    doc.text(`${simboloPDF('USD')}${totalGastado.toFixed(2)}`, R - 70, y, { width: 70, align: 'right' });
    doc.fillColor('#000000');
    y += 14;

    // Total general de todos los servicios
    doc.rect(R - 210, y - 2, 210, 20).fill('#1a1a2e');
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    doc.text('TOTAL SERVICIOS:', R - 210, y + 2, { width: 135, align: 'right' });
    doc.text(`${simboloPDF('USD')}${totalGeneral.toFixed(2)}`, R - 75, y + 2, { width: 75, align: 'right' });
    doc.fillColor('#000000');
    y += 28;
  }

  // ── SECCION: COTIZACIONES ───────────────────────────────────────────────────
  y = checkPage(doc, y, 680);
  y = sectionTitle(doc, 'COTIZACIONES', y, L, R);

  if (cotizaciones.length === 0) {
    doc.fontSize(9).font('Helvetica').fillColor('#666666').text('No hay cotizaciones para este cliente.', L, y);
    doc.fillColor('#000000');
    y += 16;
  } else {
    // Encabezado tabla
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#555555');
    doc.text('NUMERO', L, y, { width: 100 });
    doc.text('FECHA', L + 105, y, { width: 75 });
    doc.text('PLACA', L + 185, y, { width: 75 });
    doc.text('MONEDA', L + 265, y, { width: 60 });
    doc.text('ESTADO', L + 330, y, { width: 80 });
    doc.text('TOTAL', L + 415, y, { width: W - 415, align: 'right' });
    doc.fillColor('#000000');
    y += 11;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#cccccc').stroke();
    y += 3;

    cotizaciones.forEach((c, i) => {
      y = checkPage(doc, y, 720);
      if (i % 2 === 0) {
        doc.rect(L, y - 1, W, 13).fill('#f8f8f8');
        doc.fillColor('#000000');
      }
      const monSim = simboloPDF(c.moneda || 'USD');
      const total = parseFloat(c.total_calculado) || 0;

      doc.fontSize(8).font('Helvetica');
      doc.text(c.numero || '-', L, y, { width: 100 });
      doc.text(fmtFecha(c.fecha), L + 105, y, { width: 75 });
      doc.text(c.placa_vehiculo || '-', L + 185, y, { width: 75 });
      doc.text(c.moneda || 'USD', L + 265, y, { width: 60 });
      doc.text(c.estado || '-', L + 330, y, { width: 80 });
      doc.text(`${monSim}${total.toFixed(2)}`, L + 415, y, { width: W - 415, align: 'right' });
      y += 13;
    });

    y += 4;
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#333333').lineWidth(1.5).stroke();
    doc.lineWidth(1);
    y += 6;

    if (hayMonedasMixtas) {
      doc.fontSize(7).font('Helvetica').fillColor('#888888')
        .text('* El total de cotizaciones es la suma nominal; las monedas pueden variar entre cotizaciones.', L, y, { width: W });
      doc.fillColor('#000000');
      y += 14;
    }
  }

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  drawFooter(doc, cfg, L, R, W, y);

  doc.end();
});

module.exports = router;
