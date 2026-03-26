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
    rol TEXT DEFAULT 'tecnico',
    activo INTEGER DEFAULT 1,
    fecha_registro TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_vehiculos_cliente ON vehiculos(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_servicios_vehiculo ON servicios(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_cotizaciones_vehiculo ON cotizaciones(vehiculo_id);
  CREATE INDEX IF NOT EXISTS idx_cotizacion_detalles_cotizacion ON cotizacion_detalles(cotizacion_id);
  CREATE INDEX IF NOT EXISTS idx_servicio_items_servicio ON servicio_items(servicio_id);
`);

// Create default admin user if no users exist
const bcrypt = require('bcryptjs');
const userCount = db.prepare('SELECT COUNT(*) as count FROM usuarios').get().count;
if (userCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO usuarios (nombre, usuario, password, rol) VALUES (?, ?, ?, ?)')
    .run('Administrador', 'admin', hash, 'admin');
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
