const db = require('../db/database');

// Registra un evento de auditoria. Nunca lanza: un fallo de auditoria no debe romper la operacion.
// usuario: objeto de sesion { id, nombre, usuario } (o null).
function registrar({ usuario, accion, entidad, entidad_id, estado_anterior, estado_nuevo, detalle }) {
  try {
    db.prepare(`INSERT INTO auditoria
      (usuario_id, usuario, accion, entidad, entidad_id, estado_anterior, estado_nuevo, detalle)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        usuario?.id ?? null,
        usuario?.nombre || usuario?.usuario || null,
        accion,
        entidad || null,
        entidad_id ?? null,
        estado_anterior ?? null,
        estado_nuevo ?? null,
        detalle ?? null
      );
  } catch (e) {
    console.error('[auditoria] no se pudo registrar:', e.message);
  }
}

module.exports = { registrar };
