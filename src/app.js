require('dotenv').config(); // carga variables de .env (local). En Docker, compose ya inyecta el entorno.
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Detras de proxy/HTTPS en produccion (VPS): confiar en X-Forwarded-* para cookie secure y req.ip
app.set('trust proxy', 1);

// Cabeceras de seguridad (HSTS, nosniff, frameguard, etc.).
// CSP se deja desactivado por ahora porque usamos CDN + scripts inline en las vistas.
app.use(helmet({ contentSecurityPolicy: false }));

// Evita el 404 ruidoso del favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Secreto de sesion: OBLIGATORIO en produccion (sin fallback inseguro).
// En desarrollo local cae a un valor de dev con aviso; en produccion aborta si falta.
const SESSION_SECRET = process.env.SESSION_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'dev-solo-local-no-usar-en-produccion');
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET no esta definido. Definilo en el entorno (.env) antes de arrancar en produccion.');
  process.exit(1);
}

// Sessions
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // requiere HTTPS en prod (trust proxy activo)
    sameSite: 'lax' // mitiga CSRF de formularios cross-site
  }
}));

// Flash messages via session
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  res.locals.usuario = req.session.usuario || null;
  res.locals.currentPath = req.path; // para marcar el item activo del navbar
  next();
});

// CSRF (synchronizer token por sesion). Protege TODOS los POST/PUT/DELETE.
// El token se expone en res.locals.csrfToken para inyectarlo como hidden _csrf en los forms.
// Para forms multipart (multer corre despues), el token se acepta tambien por query (?_csrf=) o header.
const crypto = require('crypto');
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const enviado = (req.body && req.body._csrf) || req.query._csrf || req.headers['x-csrf-token'];
  if (enviado && enviado === req.session.csrfToken) return next();

  return res.status(403).render('partials/error', {
    title: 'Sesion invalida',
    message: 'Token de seguridad invalido o expirado. Recarga la pagina e intenta de nuevo.'
  });
});

// Auth routes (public)
app.use('/auth', require('./routes/auth'));

// Auth middleware - protect all other routes
app.use((req, res, next) => {
  if (!req.session.usuario) {
    return res.redirect('/auth/login');
  }
  next();
});

// Helper de badges de estado disponible en todas las vistas
const { badgeEstado } = require('./lib/estados');
app.use((req, res, next) => { res.locals.badgeEstado = badgeEstado; next(); });

// Helper de simbolo de moneda (USD/CRC) disponible en todas las vistas
const moneda = require('./lib/moneda');
app.use((req, res, next) => { res.locals.simbolo = moneda.simbolo; next(); });

// Roles y control de acceso por rol
app.use((req, res, next) => {
  const rol = req.session.usuario?.rol;
  res.locals.esAdmin = rol === 'admin';
  res.locals.esMecanico = rol === 'tecnico';
  res.locals.esCliente = rol === 'cliente';

  // El CLIENTE (portal) solo accede a /portal, /auth y /fotos (sus propias fotos, validadas por pertenencia).
  if (rol === 'cliente') {
    const permitido = req.path === '/' ||
                      req.path.startsWith('/portal') ||
                      req.path.startsWith('/auth') ||
                      req.path.startsWith('/fotos');
    if (req.path === '/') return res.redirect('/portal');
    if (!permitido) {
      return res.status(403).render('partials/error', {
        title: 'Acceso restringido',
        message: 'No tienes acceso a esta seccion.'
      });
    }
    return next();
  }

  // El mecanico (rol tecnico) solo puede ver sus ordenes, su perfil y autenticacion.
  // Excepcion: puede ver el HISTORIAL TECNICO de un vehiculo (sin precios) en /vehiculos/:id/historial.
  // Cualquier otra seccion (clientes, vehiculos, cotizaciones, usuarios, configuracion, reportes) queda bloqueada.
  if (rol === 'tecnico') {
    const permitido = req.path.startsWith('/servicios') ||
                      req.path.startsWith('/perfil') ||
                      req.path.startsWith('/fotos') ||
                      req.path.startsWith('/auth') ||
                      /^\/vehiculos\/\d+\/historial\/?$/.test(req.path);
    if (req.path === '/') return res.redirect('/servicios');
    if (!permitido) {
      return res.status(403).render('partials/error', {
        title: 'Acceso restringido',
        message: 'No tienes acceso a esta seccion. Solo puedes ver tus ordenes de trabajo asignadas.'
      });
    }
  }
  next();
});

// Routes (protected)
app.use('/', require('./routes/home'));
app.use('/clientes', require('./routes/clientes'));
app.use('/vehiculos', require('./routes/vehiculos'));
app.use('/servicios', require('./routes/servicios'));
app.use('/cotizaciones', require('./routes/cotizaciones'));
app.use('/usuarios', require('./routes/usuarios'));
app.use('/perfil', require('./routes/perfil'));
app.use('/reportes', require('./routes/reportes'));
app.use('/fotos', require('./routes/fotos'));
app.use('/accesos', require('./routes/accesos'));
app.use('/configuracion', require('./routes/configuracion'));
app.use('/portal', require('./routes/portal'));
app.use('/solicitudes', require('./routes/solicitudes'));

// 404 handler
app.use((req, res) => {
  res.status(404).render('partials/error', {
    title: 'No encontrado',
    message: 'La pagina que buscas no existe.'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('partials/error', {
    title: 'Error',
    message: 'Ocurrio un error interno del servidor.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gestion Taller corriendo en http://localhost:${PORT}`);
});
