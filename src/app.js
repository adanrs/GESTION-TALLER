const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Evita el 404 ruidoso del favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET || 'taller-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Flash messages via session
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  res.locals.usuario = req.session.usuario || null;
  next();
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

// Roles y control de acceso por rol
app.use((req, res, next) => {
  const rol = req.session.usuario?.rol;
  res.locals.esAdmin = rol === 'admin';
  res.locals.esMecanico = rol === 'tecnico';

  // El mecanico (rol tecnico) solo puede ver sus ordenes, su perfil y autenticacion.
  // Cualquier otra seccion (clientes, vehiculos, cotizaciones, usuarios, configuracion, reportes) queda bloqueada.
  if (rol === 'tecnico') {
    const permitido = req.path.startsWith('/servicios') ||
                      req.path.startsWith('/perfil') ||
                      req.path.startsWith('/auth');
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
app.use('/accesos', require('./routes/accesos'));
app.use('/configuracion', require('./routes/configuracion'));

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
