document.addEventListener('DOMContentLoaded', () => {

  function getMoneda() { const s = document.getElementById('select-moneda'); return s ? s.value : 'USD'; }
  function getSimbolo(m) { return m === 'CRC' ? '\u20A1' : '$'; }
  function getTC() { const e = document.getElementById('input-tc'); return e ? (parseFloat(e.value) || 0) : 0; }
  function getIvaPct() { const e = document.getElementById('input-iva-pct'); return e ? (parseFloat(e.value) || 0) : 0; }
  function isIvaOn() { const e = document.getElementById('chk-iva'); return e ? e.checked : false; }

  // Generic dynamic table
  function setupDynamicTable(config) {
    const btn = document.getElementById(config.btnId);
    const tbody = document.getElementById(config.tbodyId);
    const tmpl = document.getElementById(config.tmplId);
    if (!btn || !tbody || !tmpl) return null;

    btn.addEventListener('click', () => { tbody.appendChild(tmpl.content.cloneNode(true)); recalc(); });
    tbody.addEventListener('click', (e) => { const rm = e.target.closest(config.removeBtn); if (rm) { rm.closest('tr').remove(); recalc(); } });
    tbody.addEventListener('input', (e) => { if (e.target.classList.contains(config.calcClass)) recalc(); });
    recalc();
    return recalc;

    function recalc() {
      const sim = getSimbolo(getMoneda());
      let subtotal = 0;
      tbody.querySelectorAll(config.rowClass).forEach(row => {
        const cant = parseFloat(row.querySelector(config.cantName).value) || 0;
        const precio = parseFloat(row.querySelector(config.precioName).value) || 0;
        const sub = cant * precio;
        row.querySelector(config.subCell).textContent = sim + sub.toFixed(2);
        subtotal += sub;
      });

      if (config.useCurrency) {
        // Subtotal
        const elSub = document.getElementById('total-subtotal');
        if (elSub) elSub.textContent = sim + subtotal.toFixed(2);

        // IVA
        const rowIva = document.getElementById('row-iva');
        const elIva = document.getElementById('total-iva');
        const lblIva = document.getElementById('label-iva');
        const ivaOn = isIvaOn();
        const ivaPct = getIvaPct();
        const ivaAmt = ivaOn ? subtotal * (ivaPct / 100) : 0;

        if (rowIva) rowIva.style.display = ivaOn ? '' : 'none';
        if (elIva) elIva.textContent = sim + ivaAmt.toFixed(2);
        if (lblIva) lblIva.innerHTML = `<strong>IVA (${ivaPct}%):</strong>`;

        // Total
        const total = subtotal + ivaAmt;
        const elTotal = document.getElementById('total-general');
        if (elTotal) elTotal.textContent = sim + total.toFixed(2);

        // Converted
        const tc = getTC();
        const elConv = document.getElementById('total-convertido');
        const lblConv = document.getElementById('label-convertido');
        if (elConv && lblConv && tc > 0) {
          const mon = getMoneda();
          const altMon = mon === 'USD' ? 'CRC' : 'USD';
          const conv = mon === 'USD' ? total * tc : total / tc;
          const altSim = mon === 'USD' ? '\u20A1' : '$';
          lblConv.textContent = `Equivalente en ${altMon} (T.C. ${tc}):`;
          elConv.textContent = altSim + conv.toFixed(2);
        }
      } else {
        const totalEl = document.getElementById(config.totalId);
        if (totalEl) totalEl.textContent = sim + subtotal.toFixed(2);
      }
    }
  }

  // Cotizaciones
  const recalcCot = setupDynamicTable({
    btnId: 'btn-agregar', tbodyId: 'detalles-body', tmplId: 'tmpl-fila',
    totalId: 'total-general', removeBtn: '.btn-quitar', calcClass: 'calc-trigger',
    rowClass: '.fila-detalle', cantName: '[name="det_cantidad"]',
    precioName: '[name="det_precio"]', subCell: '.subtotal-cell', useCurrency: true
  });

  // Servicios - items
  const recalcItems = setupDynamicTable({
    btnId: 'btn-agregar-item', tbodyId: 'items-body', tmplId: 'tmpl-item',
    totalId: 'total-items', removeBtn: '.btn-quitar-item', calcClass: 'item-calc',
    rowClass: '.fila-item', cantName: '[name="item_cantidad"]',
    precioName: '[name="item_precio"]', subCell: '.item-subtotal', useCurrency: false
  });

  // Re-calc on currency/TC/IVA change (cotizaciones y servicios)
  ['select-moneda', 'input-tc', 'input-iva-pct', 'chk-iva'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
      if (recalcCot) recalcCot();
      if (recalcItems) recalcItems();
      const simCosto = document.getElementById('simbolo-costo');
      if (simCosto) simCosto.textContent = getSimbolo(getMoneda());
    });
  });

  // Toggle IVA % visibility
  const chkIva = document.getElementById('chk-iva');
  const ivaWrap = document.getElementById('iva-pct-wrap');
  if (chkIva && ivaWrap) {
    const toggle = () => { ivaWrap.style.opacity = chkIva.checked ? '1' : '0.4'; };
    chkIva.addEventListener('change', toggle);
    toggle();
  }

  // Conversion de montos al cambiar la moneda (cotizaciones y servicios).
  // La moneda indica en que estan expresados los precios; si ya hay montos
  // digitados se ofrece convertirlos con el T.C. y si no, se avisa que los
  // numeros quedan igual.
  const selMonedaConv = document.getElementById('select-moneda');
  if (selMonedaConv) {
    let monedaPrev = selMonedaConv.value;

    const mostrarAviso = (tipo, msg) => {
      const aviso = document.getElementById('aviso-moneda');
      if (!aviso) return;
      aviso.classList.remove('d-none', 'alert-warning', 'alert-success');
      aviso.classList.add(tipo === 'ok' ? 'alert-success' : 'alert-warning');
      aviso.textContent = msg;
    };

    selMonedaConv.addEventListener('change', () => {
      const nueva = selMonedaConv.value;
      if (nueva === monedaPrev) return;
      const anterior = monedaPrev;
      monedaPrev = nueva;

      // Campos con precios: items de servicios, detalles de cotizacion y mano de obra
      const campos = Array.prototype.slice.call(
        document.querySelectorAll('[name="item_precio"], [name="det_precio"]')
      );
      const costoMO = document.getElementById('srv-costo');
      if (costoMO) campos.push(costoMO);

      const hayMontos = campos.some(c => (parseFloat(c.value) || 0) > 0);
      if (!hayMontos) return;

      const tc = getTC();
      if (!(tc > 0)) {
        mostrarAviso('warn', 'Sin tipo de cambio valido: los montos NO se convirtieron, quedan con los mismos numeros pero expresados en ' + nueva + '.');
        return;
      }

      const aCRC = nueva === 'CRC';
      if (confirm('Convertir los montos de ' + anterior + ' a ' + nueva + ' usando el T.C. ' + tc + '?')) {
        campos.forEach(c => {
          const v = parseFloat(c.value) || 0;
          if (v > 0) c.value = (aCRC ? v * tc : v / tc).toFixed(2);
        });
        mostrarAviso('ok', 'Montos convertidos de ' + anterior + ' a ' + nueva + ' con T.C. ' + tc + '. Revisa los valores y guarda para aplicar.');
      } else {
        mostrarAviso('warn', 'Los montos NO se convirtieron: los numeros quedan igual pero ahora expresados en ' + nueva + '.');
      }
      if (recalcCot) recalcCot();
      if (recalcItems) recalcItems();
    });
  }
});
