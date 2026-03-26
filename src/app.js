const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Admin-only middleware helper
app.use((req, res, next) => {
  res.locals.esAdmin = req.session.usuario?.rol === 'admin';
  next();
});

// Routes (protected)
app.use('/', require('./routes/home'));
app.use('/clientes', require('./routes/clientes'));
app.use('/vehiculos', require('./routes/vehiculos'));
app.use('/servicios', require('./routes/servicios'));
app.use('/cotizaciones', require('./routes/cotizaciones'));
app.use('/usuarios', require('./routes/usuarios'));
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
