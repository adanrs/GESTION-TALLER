// Fuente unica de verdad de los estados de la app (ordenes de servicio y cotizaciones)
// y de la maquina de transiciones. Evita los nombres desincronizados entre modulos.

const ESTADOS_ORDEN = ['Pendiente', 'Asignada', 'En proceso', 'Completada', 'Por cobrar', 'Cobrada', 'Cancelada'];
// Estados que cuentan como "orden activa / abierta" (para el dashboard)
const ESTADOS_ORDEN_ACTIVOS = ['Pendiente', 'Asignada', 'En proceso'];
const ESTADOS_COTIZACION = ['Borrador', 'Enviada', 'Aprobada', 'Rechazada'];

// Transiciones permitidas de una orden de servicio
const TRANSICIONES = {
  'Pendiente': ['Asignada', 'En proceso', 'Cancelada'],
  'Asignada': ['En proceso', 'Pendiente', 'Cancelada'],
  'En proceso': ['Completada', 'Cancelada'],
  'Completada': ['Por cobrar', 'Cobrada', 'En proceso', 'Cancelada'],
  'Por cobrar': ['Cobrada', 'Completada'],
  'Cobrada': ['Por cobrar'], // terminal salvo correccion del admin
  'Cancelada': ['Pendiente'], // reabrir una cancelada
};

function puedeTransicionar(actual, nuevo) {
  if (!actual) return true;            // sin estado previo (creacion)
  if (actual === nuevo) return true;   // mismo estado: no-op permitido
  return (TRANSICIONES[actual] || []).includes(nuevo);
}

// Devuelve las clases de color Bootstrap para el badge de un estado.
// Uso en vistas: <span class="badge bg-<%= badgeEstado(e) %>">...
function badgeEstado(estado) {
  switch (estado) {
    case 'Completada': case 'Aprobada': return 'success';
    case 'En proceso': return 'warning text-dark';
    case 'Asignada': case 'Enviada': return 'info';
    case 'Por cobrar': return 'primary';
    case 'Cobrada': return 'dark';
    case 'Cancelada': case 'Rechazada': return 'danger';
    case 'Pendiente': case 'Borrador': return 'secondary';
    default: return 'secondary';
  }
}

module.exports = {
  ESTADOS_ORDEN, ESTADOS_ORDEN_ACTIVOS, ESTADOS_COTIZACION,
  TRANSICIONES, puedeTransicionar, badgeEstado,
};
