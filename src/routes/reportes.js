const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const db = require('../db/database');

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

  // ── FOOTER ────────────────────────────────────────────────────────────────
  drawFooter(doc, cfg, L, R, W, y);

  doc.end();
});

module.exports = router;
