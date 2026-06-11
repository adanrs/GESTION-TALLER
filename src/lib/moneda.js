// Helpers de moneda (USD/CRC) compartidos por rutas y vistas.
// La moneda se guarda por documento (cotizacion u orden) junto con el tipo de
// cambio vigente al momento de crearlo, para que el historial no cambie si el
// tipo de cambio se actualiza despues.

function simbolo(moneda) {
  return moneda === 'CRC' ? '₡' : '$';
}

// Normaliza la moneda recibida de un form: solo USD o CRC
function normalizar(moneda) {
  return moneda === 'CRC' ? 'CRC' : 'USD';
}

// Formatea totales acumulados por moneda: "$10.00", "₡5000.00" o "$10.00 + ₡5000.00"
function fmtTotales(usd, crc) {
  const u = parseFloat(usd) || 0;
  const c = parseFloat(crc) || 0;
  if (u > 0 && c > 0) return `$${u.toFixed(2)} + ₡${c.toFixed(2)}`;
  if (c > 0) return `₡${c.toFixed(2)}`;
  return `$${u.toFixed(2)}`;
}

module.exports = { simbolo, normalizar, fmtTotales };
