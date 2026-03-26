const express = require('express');
const router = express.Router();
const db = require('../db/database');

function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', { title: 'Acceso denegado', message: 'Solo administradores pueden acceder a esta seccion.' });
  }
  next();
}

router.use(soloAdmin);

function getConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const config = {};
  rows.forEach(r => config[r.clave] = r.valor);
  return config;
}

function setConfig(clave, valor) {
  db.prepare('INSERT INTO configuracion (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = ?')
    .run(clave, valor, valor);
}

router.get('/', (req, res) => {
  const config = getConfig();
  res.render('configuracion/index', { title: 'Configuracion del Taller', config, errors: [] });
});

router.post('/', (req, res) => {
  const { nombre_taller, telefono_taller, whatsapp_taller, email_taller, direccion_taller, moneda, tipo_cambio_crc, iva_porcentaje, aplica_iva } = req.body;

  setConfig('nombre_taller', nombre_taller?.trim() || '');
  setConfig('telefono_taller', telefono_taller?.trim() || '');
  setConfig('whatsapp_taller', whatsapp_taller?.trim() || '');
  setConfig('email_taller', email_taller?.trim() || '');
  setConfig('direccion_taller', direccion_taller?.trim() || '');
  setConfig('moneda', moneda || 'USD');
  setConfig('tipo_cambio_crc', tipo_cambio_crc || '515');
  setConfig('iva_porcentaje', iva_porcentaje || '13');
  setConfig('aplica_iva', aplica_iva === 'on' ? '1' : '0');

  res.flash('success', 'Configuracion guardada');
  res.redirect('/configuracion');
});

module.exports = router;
