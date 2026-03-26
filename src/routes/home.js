const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.get('/', (req, res) => {
  const totalClientes = db.prepare('SELECT COUNT(*) as count FROM clientes').get().count;
  const totalVehiculos = db.prepare('SELECT COUNT(*) as count FROM vehiculos').get().count;
  const serviciosActivos = db.prepare("SELECT COUNT(*) as count FROM servicios WHERE estado IN ('Pendiente','En Proceso')").get().count;
  const cotizacionesPendientes = db.prepare("SELECT COUNT(*) as count FROM cotizaciones WHERE estado IN ('Borrador','Enviada')").get().count;

  const serviciosRecientes = db.prepare(`
    SELECT s.*, v.placa, v.marca, v.modelo, c.nombre as cliente_nombre
    FROM servicios s
    JOIN vehiculos v ON s.vehiculo_id = v.id
    JOIN clientes c ON v.cliente_id = c.id
    ORDER BY s.fecha DESC LIMIT 10
  `).all();

  res.render('home', {
    title: 'Dashboard',
    totalClientes,
    totalVehiculos,
    serviciosActivos,
    cotizacionesPendientes,
    serviciosRecientes
  });
});

module.exports = router;
