const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/database');

// Admin guard
function soloAdmin(req, res, next) {
  if (req.session.usuario?.rol !== 'admin') {
    return res.status(403).render('partials/error', { title: 'Acceso denegado', message: 'Solo administradores pueden acceder a esta seccion.' });
  }
  next();
}

router.use(soloAdmin);

// Listar usuarios
router.get('/', (req, res) => {
  const usuarios = db.prepare('SELECT id, nombre, usuario, rol, activo, fecha_registro FROM usuarios ORDER BY nombre').all();
  res.render('usuarios/index', { title: 'Usuarios', usuarios });
});

// Crear
router.get('/crear', (req, res) => {
  res.render('usuarios/form', { title: 'Nuevo Usuario', user: {}, errors: [] });
});

router.post('/crear', (req, res) => {
  const { nombre, usuario, password, password2, rol } = req.body;
  const errors = [];
  if (!nombre?.trim()) errors.push('El nombre es obligatorio');
  if (!usuario?.trim()) errors.push('El usuario es obligatorio');
  if (!password || password.length < 4) errors.push('La clave debe tener al menos 4 caracteres');
  if (password !== password2) errors.push('Las claves no coinciden');

  const exists = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario?.trim());
  if (exists) errors.push('Ese nombre de usuario ya existe');

  if (errors.length) {
    return res.render('usuarios/form', { title: 'Nuevo Usuario', user: req.body, errors });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO usuarios (nombre, usuario, password, rol) VALUES (?, ?, ?, ?)')
    .run(nombre.trim(), usuario.trim(), hash, rol || 'tecnico');
  res.flash('success', 'Usuario creado');
  res.redirect('/usuarios');
});

// Editar
router.get('/:id/editar', (req, res) => {
  const user = db.prepare('SELECT id, nombre, usuario, rol, activo FROM usuarios WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).render('partials/error', { title: 'Error', message: 'Usuario no encontrado' });
  res.render('usuarios/form', { title: 'Editar Usuario', user, errors: [] });
});

router.post('/:id/editar', (req, res) => {
  const { nombre, usuario, password, password2, rol, activo } = req.body;
  const errors = [];
  if (!nombre?.trim()) errors.push('El nombre es obligatorio');
  if (!usuario?.trim()) errors.push('El usuario es obligatorio');

  const exists = db.prepare('SELECT id FROM usuarios WHERE usuario = ? AND id != ?').get(usuario?.trim(), req.params.id);
  if (exists) errors.push('Ese nombre de usuario ya existe');

  if (password && password.length < 4) errors.push('La clave debe tener al menos 4 caracteres');
  if (password && password !== password2) errors.push('Las claves no coinciden');

  if (errors.length) {
    return res.render('usuarios/form', { title: 'Editar Usuario', user: { ...req.body, id: req.params.id }, errors });
  }

  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE usuarios SET nombre=?, usuario=?, password=?, rol=?, activo=? WHERE id=?')
      .run(nombre.trim(), usuario.trim(), hash, rol || 'tecnico', activo === 'on' ? 1 : 0, req.params.id);
  } else {
    db.prepare('UPDATE usuarios SET nombre=?, usuario=?, rol=?, activo=? WHERE id=?')
      .run(nombre.trim(), usuario.trim(), rol || 'tecnico', activo === 'on' ? 1 : 0, req.params.id);
  }
  res.flash('success', 'Usuario actualizado');
  res.redirect('/usuarios');
});

// Eliminar
router.post('/:id/eliminar', (req, res) => {
  if (String(req.params.id) === String(req.session.usuario.id)) {
    res.flash('danger', 'No puedes eliminarte a ti mismo');
    return res.redirect('/usuarios');
  }
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(req.params.id);
  res.flash('success', 'Usuario eliminado');
  res.redirect('/usuarios');
});

module.exports = router;
