const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// Las fotos se guardan en disco, dentro del MISMO directorio de datos que la BD
// (en Docker es el volumen persistente /app/data), NUNCA en la base de datos ni en /public.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'taller.db');
const uploadsDir = process.env.UPLOADS_PATH || path.join(path.dirname(dbPath), 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const TIPOS_PERMITIDOS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = TIPOS_PERMITIDOS[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.bin';
    const nombre = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, nombre);
  },
});

const EXT_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.webp'];
function fileFilter(req, file, cb) {
  // Aceptamos si el mimetype es una imagen permitida O si la extension lo es
  // (algunos clientes envian application/octet-stream aunque el archivo sea una imagen valida).
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (TIPOS_PERMITIDOS[file.mimetype] || EXT_PERMITIDAS.includes(ext)) return cb(null, true);
  cb(new Error('Tipo de archivo no permitido. Solo JPG, PNG o WEBP.'));
}

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_BYTES, files: 10 } });

// Resuelve la ruta absoluta y segura de un archivo guardado (evita path traversal).
function rutaSegura(archivo) {
  const resolved = path.resolve(uploadsDir, path.basename(archivo || ''));
  if (!resolved.startsWith(path.resolve(uploadsDir))) return null;
  return resolved;
}

module.exports = { upload, uploadsDir, rutaSegura, TIPOS_PERMITIDOS, MAX_BYTES };
