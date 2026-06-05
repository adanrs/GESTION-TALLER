const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

// GET /perfil
router.get('/', (req, res) => {
  const user = db.prepare('SELECT id, nombre, usuario, email, rol FROM usuarios WHERE id = ?').get(req.session.usuario.id);
  res.render('perfil/index', { title: 'Mi Perfil', user, errors: [] });
});

// POST /perfil/email
router.post('/email', (req, res) => {
  const email = (req.body.email || '').trim();
  const errors = [];

  if (email && !email.includes('@')) {
    errors.push('El correo no tiene un formato valido');
  }

  if (errors.length) {
    const user = db.prepare('SELECT id, nombre, usuario, email, rol FROM usuarios WHERE id = ?').get(req.session.usuario.id);
    return res.render('perfil/index', { title: 'Mi Perfil', user: { ...user, email }, errors });
  }

  db.prepare('UPDATE usuarios SET email = ? WHERE id = ?').run(email || null, req.session.usuario.id);
  res.flash('success', 'Correo actualizado');
  res.redirect('/perfil');
});

// POST /perfil/password
router.post('/password', (req, res) => {
  const { actual, password, password2 } = req.body;
  const errors = [];

  const userConHash = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.session.usuario.id);

  if (!bcrypt.compareSync(actual || '', userConHash.password)) {
    errors.push('La contrasena actual es incorrecta');
  }

  if (!password || password.length < 4) {
    errors.push('La nueva clave debe tener al menos 4 caracteres');
  }

  if (password && password !== password2) {
    errors.push('Las claves no coinciden');
  }

  if (errors.length) {
    const user = db.prepare('SELECT id, nombre, usuario, email, rol FROM usuarios WHERE id = ?').get(req.session.usuario.id);
    return res.render('perfil/index', { title: 'Mi Perfil', user, errors });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, req.session.usuario.id);
  res.flash('success', 'Contrasena cambiada');
  res.redirect('/perfil');
});

module.exports = router;
