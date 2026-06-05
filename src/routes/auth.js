const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db/database');
const mailer = require('../lib/mailer');

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  res.render('auth/login', { title: 'Iniciar Sesion', error: null });
});

router.post('/login', (req, res) => {
  const { usuario, password } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || req.ip;
  const ua = req.headers['user-agent'] || '';

  const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    try {
      db.prepare(
        'INSERT INTO accesos (usuario, exito, ip, user_agent) VALUES (?, 0, ?, ?)'
      ).run(usuario || '', ip, ua);
    } catch (err) {
      console.error('Error al registrar acceso fallido:', err);
    }
    return res.render('auth/login', { title: 'Iniciar Sesion', error: 'Usuario o clave incorrectos' });
  }

  try {
    db.prepare(
      'INSERT INTO accesos (usuario_id, usuario, nombre, rol, exito, ip, user_agent) VALUES (?, ?, ?, ?, 1, ?, ?)'
    ).run(user.id, user.usuario, user.nombre, user.rol, ip, ua);
  } catch (err) {
    console.error('Error al registrar acceso exitoso:', err);
  }

  req.session.usuario = { id: user.id, nombre: user.nombre, usuario: user.usuario, rol: user.rol };
  res.redirect('/');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

// Recuperacion de contrasena
router.get('/recuperar', (req, res) => {
  res.render('auth/recuperar', { title: 'Recuperar Contrasena', error: null, mensaje: null });
});

router.post('/recuperar', async (req, res) => {
  const email = (req.body.email || '').trim();

  if (!email) {
    return res.render('auth/recuperar', { title: 'Recuperar Contrasena', error: 'Ingresa tu correo', mensaje: null });
  }

  const mensajeGenerico = 'Si el correo existe, enviamos un enlace para restablecer la contrasena.';

  const user = db.prepare('SELECT id, nombre, email FROM usuarios WHERE email = ? AND activo = 1').get(email);

  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 3600 * 1000).toISOString();

    db.prepare('UPDATE password_resets SET usado = 1 WHERE usuario_id = ? AND usado = 0').run(user.id);
    db.prepare('INSERT INTO password_resets (usuario_id, token, expira, usado) VALUES (?, ?, ?, 0)').run(user.id, token, expira);

    const base = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const enlace = `${base}/auth/reset/${token}`;
    const taller = db.prepare("SELECT valor FROM configuracion WHERE clave = 'nombre_taller'").get()?.valor || 'Gestion Taller';

    try {
      await mailer.enviarRecuperacion({ to: user.email, nombre: user.nombre, enlace, taller });
    } catch (err) {
      console.error('Error al enviar correo de recuperacion:', err);
    }
  }

  res.render('auth/recuperar', { title: 'Recuperar Contrasena', error: null, mensaje: mensajeGenerico });
});

router.get('/reset/:token', (req, res) => {
  const registro = db.prepare('SELECT * FROM password_resets WHERE token = ? AND usado = 0').get(req.params.token);

  if (!registro || new Date(registro.expira) <= new Date()) {
    return res.status(400).render('partials/error', {
      title: 'Enlace invalido',
      message: 'El enlace de recuperacion no es valido o ya expiro. Solicita uno nuevo.'
    });
  }

  res.render('auth/reset', { title: 'Nueva Contrasena', token: req.params.token, error: null });
});

router.post('/reset/:token', (req, res) => {
  const { password, password2 } = req.body;
  const token = req.params.token;

  const registro = db.prepare('SELECT * FROM password_resets WHERE token = ? AND usado = 0').get(token);

  if (!registro || new Date(registro.expira) <= new Date()) {
    return res.status(400).render('partials/error', {
      title: 'Enlace invalido',
      message: 'El enlace de recuperacion no es valido o ya expiro. Solicita uno nuevo.'
    });
  }

  if (!password || password.length < 4) {
    return res.render('auth/reset', { title: 'Nueva Contrasena', token, error: 'La clave debe tener al menos 4 caracteres' });
  }
  if (password !== password2) {
    return res.render('auth/reset', { title: 'Nueva Contrasena', token, error: 'Las claves no coinciden' });
  }

  const hash = bcrypt.hashSync(password, 10);

  const actualizarContrasena = db.transaction(() => {
    db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hash, registro.usuario_id);
    db.prepare('UPDATE password_resets SET usado = 1 WHERE id = ?').run(registro.id);
  });

  actualizarContrasena();

  res.flash('success', 'Contrasena actualizada, ya puedes iniciar sesion');
  res.redirect('/auth/login');
});

module.exports = router;
