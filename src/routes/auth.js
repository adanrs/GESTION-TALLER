const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  res.render('auth/login', { title: 'Iniciar Sesion', error: null });
});

router.post('/login', (req, res) => {
  const { usuario, password } = req.body;
  const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('auth/login', { title: 'Iniciar Sesion', error: 'Usuario o clave incorrectos' });
  }

  req.session.usuario = { id: user.id, nombre: user.nombre, usuario: user.usuario, rol: user.rol };
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

module.exports = router;
