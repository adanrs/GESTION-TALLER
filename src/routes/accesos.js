const express = require('express');
const router = express.Router();
const db = require('../db/database');

const LIMITE = 200;

function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'Solo administradores pueden ver el log de accesos.'
    });
  }
  next();
}

router.get('/', soloAdmin, (req, res) => {
  const usuarioFiltro = (req.query.usuario || '').trim();
  const exitoFiltro   = req.query.exito;            // '1', '0' o undefined/''

  const params = [];
  const condiciones = [];

  if (usuarioFiltro) {
    condiciones.push("usuario LIKE ?");
    params.push(`%${usuarioFiltro}%`);
  }

  if (exitoFiltro === '1' || exitoFiltro === '0') {
    condiciones.push("exito = ?");
    params.push(Number(exitoFiltro));
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  params.push(LIMITE);

  const accesos = db
    .prepare(`SELECT * FROM accesos ${where} ORDER BY fecha DESC, id DESC LIMIT ?`)
    .all(...params);

  res.render('accesos/index', {
    title: 'Log de Accesos',
    accesos,
    filtros: { usuario: usuarioFiltro, exito: exitoFiltro ?? '' }
  });
});

module.exports = router;
