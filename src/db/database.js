const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'taller.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    cedula TEXT,
    telefono TEXT,
    email TEXT,
    direccion TEXT,
    fecha_registro TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS vehiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    placa TEXT NOT NULL,
    marca TEXT NOT NULL,
    modelo TEXT NOT NULL,
    ano INTEGER,
    color TEXT,
    vin TEXT,
    notas TEXT,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS servicios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehiculo_id INTEGER NOT NULL,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    descripcion TEXT NOT NULL,
    kilometraje INTEGER,
    tecnico TEXT,
    estado TEXT DEFAULT 'Pendiente',
    costo REAL DEFAULT 0,
    notas TEXT,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cotizaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehiculo_id INTEGER NOT NULL,
    numero TEXT UNIQUE,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    estado TEXT DEFAULT 'Borrador',
    moneda TEXT DEFAULT 'USD',
    tipo_cambio REAL DEFAULT 0,
    aplica_iva INTEGER DEFAULT 1,
    iva_porcentaje REAL DEFAULT 13,
    notas TEXT,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cotizacion_detalles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cotizacion_id INTEGER NOT NULL,
    tipo TEXT DEFAULT 'Repuesto',
    descripcion TEXT NOT NULL,
    cantidad REAL DEFAULT 1,
    precio_unitario REAL DEFAULT 0,
    FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS servicio_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    servicio_id INTEGER NOT NULL,
    tipo TEXT DEFAULT 'Repuesto',
    descripcion TEXT NOT NULL,
    cantidad REAL DEFAULT 1,
    precio_unitario REAL DEFAULT 0,
    FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS configuracion (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    usuario TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    email TEXT,
    rol TEXT DEFAULT 'tecnico',
    activo INTEGER DEFAULT 1,
    fecha_registro TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expira TEXT NOT NULL,
    usado INTEGER DEFAULT 0,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
  );

  -- Hoja de servicio: tareas solicitadas por el cliente que el mecanico realiza
  CREATE TABLE IF NOT EXISTS servicio_tareas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    servicio_id INTEGER NOT NULL,
    descripcion TEXT NOT NULL,
    completado INTEGER DEFAULT 0,
    tecnico TEXT,
    fecha_completado TEXT,
    orden INTEGER DEFAULT 0,
    FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE CASCADE
  );

  -- Auditoria: traza de cambios de estado, ediciones de precio, archivados, etc.
  CREATE TABLE IF NOT EXISTS auditoria (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    usuario TEXT,
    accion TEXT NOT NULL,
    entidad TEXT,
    entidad_id INTEGER,
    estado_anterior TEXT,
    estado_nuevo TEXT,
    detalle TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Fotos adjuntas a un vehiculo y/o a una orden de servicio (archivo en disco)
  CREATE TABLE IF NOT EXISTS fotos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehiculo_id INTEGER,
    servicio_id INTEGER,
    archivo TEXT NOT NULL,
    nombre_original TEXT,
    descripcion TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
    FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE CASCADE
  );

  -- Solicitudes de servicio creadas por el cliente desde el portal (el admin las aprueba/convierte)
  CREATE TABLE IF NOT EXISTS solicitudes_servicio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL,
    vehiculo_id INTEGER NOT NULL,
    descripcion TEXT NOT NULL,
    estado TEXT DEFAULT 'Solicitada',
    servicio_id INTEGER,
    nota_taller TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    fecha_resuelta TEXT,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
    FOREIGN KEY (vehiculo_id) REFERENCES vehiculos(id) ON DELETE CASCADE,
    FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE SET NULL
  );

  -- Log de accesos: quien y cuando inicio sesion (exitoso o fallido)
  CREATE TABLE IF NOT EXISTS accesos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER,
    usuario TEXT,
    nombre TEXT,
    rol TEXT,
    exito INTEGER DEFAULT 1,
    ip TEXT,
    user_agent TEXT,
    fecha TEXT DEFAULT (datetime('now','localtime'))
  );

  -- Comentarios de la orden de trabajo (mecanico/encargado)
  CREATE TABLE IF NOT EXISTS servicio_comentarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    servicio_id INTEGER NOT NULL,
    usuario_id INTEGER,
    autor TEXT,
    comentario TEXT NOT NULL,
    fecha TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (servicio_id) REFERENCES servicios(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_vehiculos_cliente ON vehiculos(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_servicios_vehiculo ON servicios(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_cotizaciones_vehiculo ON cotizaciones(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_cotizacion_detalles_cotizacion ON cotizacion_detalles(cotizacion_id);
  CREATE INDEX IF NOT EXISTS idx_servicio_items_servicio ON servicio_items(servicio_id);
  CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
  CREATE INDEX IF NOT EXISTS idx_servicio_tareas_servicio ON servicio_tareas(servicio_id);
  CREATE INDEX IF NOT EXISTS idx_servicio_comentarios_servicio ON servicio_comentarios(servicio_id);
  CREATE INDEX IF NOT EXISTS idx_accesos_fecha ON accesos(fecha);
  CREATE INDEX IF NOT EXISTS idx_fotos_vehiculo ON fotos(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_fotos_servicio ON fotos(servicio_id);
  CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad, entidad_id);
  CREATE INDEX IF NOT EXISTS idx_solicitudes_cliente ON solicitudes_servicio(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_solicitudes_estado ON solicitudes_servicio(estado);
`);

// Migraciones para bases de datos existentes (agregar columnas nuevas si faltan)
function ensureColumn(tabla, columna, definicion) {
  const cols = db.prepare(`PRAGMA table_info(${tabla})`).all();
  if (!cols.some(c => c.name === columna)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
  }
}
ensureColumn('usuarios', 'email', 'TEXT');
// Asignacion de mecanico y flujo de cobro en la orden de servicio
ensureColumn('servicios', 'mecanico_id', 'INTEGER');
ensureColumn('servicios', 'fecha_completado', 'TEXT');
ensureColumn('servicios', 'cobrado', 'INTEGER DEFAULT 0');
ensureColumn('servicios', 'fecha_cobro', 'TEXT');
// Garantia que se ofrece al cliente en la cotizacion
ensureColumn('cotizaciones', 'garantia', 'TEXT');
// Fecha en que se marco la cotizacion como pagada
ensureColumn('cotizaciones', 'fecha_pago', 'TEXT');
// Soft-delete: archivar en vez de borrar (preserva historial)
ensureColumn('clientes', 'activo', 'INTEGER DEFAULT 1');
ensureColumn('vehiculos', 'activo', 'INTEGER DEFAULT 1');
// Folio legible de la orden de servicio (OT-YYYYNNNN)
ensureColumn('servicios', 'numero', 'TEXT');
// Multimoneda en ordenes de servicio (USD/CRC) con tipo de cambio congelado al crear/editar
ensureColumn('servicios', 'moneda', "TEXT DEFAULT 'USD'");
ensureColumn('servicios', 'tipo_cambio', 'REAL DEFAULT 0');
// Vincula una cuenta de usuario al registro de cliente (portal del cliente)
ensureColumn('usuarios', 'cliente_id', 'INTEGER');
db.exec('CREATE INDEX IF NOT EXISTS idx_usuarios_cliente ON usuarios(cliente_id)');

// Create default admin user if no users exist
const bcrypt = require('bcryptjs');
const userCount = db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO usuarios (nombre, usuario, password, email, rol) VALUES (?, ?, ?, ?, ?)')
    .run('Administrador', 'admin', hash, process.env.ADMIN_EMAIL || null, 'admin');
  console.log('Usuario admin creado (usuario: admin, clave: admin123)');
}

// Default config
const configCount = db.prepare('SELECT COUNT(*) as count FROM configuracion').get().count;
if (configCount === 0) {
  const configs = [
    ['moneda', 'USD'],
    ['tipo_cambio_crc', '515'],
    ['nombre_taller', 'Mi Taller Mecanico'],
    ['telefono_taller', ''],
    ['whatsapp_taller', ''],
    ['email_taller', ''],
    ['direccion_taller', ''],
    ['iva_porcentaje', '13'],
    ['aplica_iva', '1'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor) VALUES (?, ?)');
  configs.forEach(c => ins.run(c[0], c[1]));
}

module.exports = db;
