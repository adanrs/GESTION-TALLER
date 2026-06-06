const express = require('express');
const router = express.Router();
const fs = require('fs');
const db = require('../db/database');
const { upload, rutaSegura } = require('../lib/uploads');

// ---------------------------------------------------------------------------
// HELPERS DE ACCESO
// ---------------------------------------------------------------------------

/**
 * Determina si un usuario puede acceder a (ver/eliminar) una foto.
 *
 * Reglas:
 *   - admin: acceso total.
 *   - tecnico: SOLO si la foto tiene servicio_id y esa orden esta asignada a el.
 *              NO puede tocar fotos de nivel vehiculo (servicio_id NULL).
 *
 * @param {object} foto   - Fila de la tabla fotos.
 * @param {object} usuario - req.session.usuario
 * @returns {boolean}
 */
function puedeAccederFoto(foto, usuario) {
  if (!usuario) return false;
  if (usuario.rol === 'admin') return true;

  if (usuario.rol === 'tecnico') {
    // Fotos de vehiculo (sin orden): prohibidas para el mecanico
    if (!foto.servicio_id) return false;
    // Solo si la orden esta asignada a el
    const servicio = db.prepare('SELECT mecanico_id FROM servicios WHERE id = ?').get(foto.servicio_id);
    return !!(servicio && servicio.mecanico_id === usuario.id);
  }

  return false;
}

/**
 * Determina si el usuario que hace la peticion puede subir fotos
 * dado el body recibido (vehiculo_id / servicio_id).
 *
 * Para el mecanico (tecnico):
 *   - Debe enviar servicio_id (no puede subir a nivel vehiculo).
 *   - Esa orden debe estarle asignada.
 *
 * @param {object} req - Express request (body ya parseado por multer).
 * @returns {{ ok: boolean, motivo?: string }}
 */
function puedeSubir(req) {
  const usuario = req.session.usuario;
  if (!usuario) return { ok: false, motivo: 'No autenticado' };
  if (usuario.rol === 'admin') return { ok: true };

  if (usuario.rol === 'tecnico') {
    const servicioId = req.body.servicio_id ? parseInt(req.body.servicio_id, 10) : null;
    if (!servicioId) {
      return { ok: false, motivo: 'Los mecanicos solo pueden subir fotos a una orden de servicio asignada.' };
    }
    const servicio = db.prepare('SELECT mecanico_id FROM servicios WHERE id = ?').get(servicioId);
    if (!servicio || servicio.mecanico_id !== usuario.id) {
      return { ok: false, motivo: 'Esta orden no esta asignada a ti.' };
    }
    return { ok: true };
  }

  return { ok: false, motivo: 'No autorizado' };
}

// ---------------------------------------------------------------------------
// POST /fotos/subir  — subida multipart
// ---------------------------------------------------------------------------
router.post('/subir', (req, res) => {
  upload.array('fotos', 10)(req, res, (err) => {
    const volver = req.get('Referer') || '/';

    // Error de multer (tipo/tamano de archivo)
    if (err) {
      res.flash('danger', err.message || 'Error al subir el archivo');
      return res.redirect(volver);
    }

    // RBAC
    const acceso = puedeSubir(req);
    if (!acceso.ok) {
      // Limpiar archivos que multer ya escribio en disco
      if (req.files && req.files.length) {
        for (const f of req.files) {
          const abs = rutaSegura(f.filename);
          if (abs) fs.unlink(abs, () => {});
        }
      }
      return res.status(403).render('partials/error', {
        title: 'Acceso denegado',
        message: acceso.motivo
      });
    }

    // Debe venir al menos un archivo
    if (!req.files || req.files.length === 0) {
      res.flash('danger', 'Debes seleccionar al menos una foto');
      return res.redirect(volver);
    }

    // Normalizar ids: cadena vacia -> NULL
    const vehiculoId  = req.body.vehiculo_id  ? parseInt(req.body.vehiculo_id,  10) : null;
    const servicioId  = req.body.servicio_id  ? parseInt(req.body.servicio_id,  10) : null;
    const descripcion = (req.body.descripcion || '').trim() || null;

    // Al menos uno de los dos ids es necesario
    if (!vehiculoId && !servicioId) {
      // Limpiar archivos subidos
      for (const f of req.files) {
        const abs = rutaSegura(f.filename);
        if (abs) fs.unlink(abs, () => {});
      }
      res.flash('danger', 'Debe indicar el vehiculo o la orden de servicio al que pertenecen las fotos');
      return res.redirect(volver);
    }

    const stmt = db.prepare(
      'INSERT INTO fotos (vehiculo_id, servicio_id, archivo, nombre_original, descripcion) VALUES (?,?,?,?,?)'
    );

    for (const file of req.files) {
      stmt.run(vehiculoId, servicioId, file.filename, file.originalname, descripcion);
    }

    res.flash('success', `${req.files.length} foto(s) agregada(s)`);

    if (servicioId)  return res.redirect(`/servicios/${servicioId}`);
    if (vehiculoId)  return res.redirect(`/vehiculos/${vehiculoId}`);
    return res.redirect(volver);
  });
});

// ---------------------------------------------------------------------------
// GET /fotos/:id/ver  — sirve la imagen al navegador
// ---------------------------------------------------------------------------
router.get('/:id/ver', (req, res) => {
  const foto = db.prepare('SELECT * FROM fotos WHERE id = ?').get(req.params.id);
  if (!foto) return res.status(404).send('Foto no encontrada');

  const usuario = req.session.usuario;
  if (!puedeAccederFoto(foto, usuario)) {
    return res.status(403).send('No autorizado');
  }

  const abs = rutaSegura(foto.archivo);
  if (!abs || !fs.existsSync(abs)) {
    return res.status(404).send('Archivo no disponible');
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(abs);
});

// ---------------------------------------------------------------------------
// POST /fotos/:id/eliminar  — eliminar foto del disco y BD
// ---------------------------------------------------------------------------
router.post('/:id/eliminar', (req, res) => {
  const foto = db.prepare('SELECT * FROM fotos WHERE id = ?').get(req.params.id);
  if (!foto) {
    res.flash('danger', 'Foto no encontrada');
    return res.redirect(req.get('Referer') || '/');
  }

  const usuario = req.session.usuario;
  if (!puedeAccederFoto(foto, usuario)) {
    return res.status(403).render('partials/error', {
      title: 'Acceso denegado',
      message: 'No tienes permiso para eliminar esta foto.'
    });
  }

  // Borrar archivo del disco (ignorar error si ya no existe)
  const abs = rutaSegura(foto.archivo);
  if (abs) fs.unlink(abs, () => {});

  db.prepare('DELETE FROM fotos WHERE id = ?').run(foto.id);

  res.flash('success', 'Foto eliminada');

  const referer = req.get('Referer') || null;
  if (referer) return res.redirect(referer);
  if (foto.servicio_id) return res.redirect(`/servicios/${foto.servicio_id}`);
  if (foto.vehiculo_id) return res.redirect(`/vehiculos/${foto.vehiculo_id}`);
  return res.redirect('/');
});

module.exports = router;
