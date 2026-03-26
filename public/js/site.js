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
      const sim = config.useCurrency ? getSimbolo(getMoneda()) : '$';
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
        if (totalEl) totalEl.textContent = '$' + subtotal.toFixed(2);
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

  // Re-calc on currency/TC/IVA change
  ['select-moneda', 'input-tc', 'input-iva-pct', 'chk-iva'].forEach(id => {
    const el = document.getElementById(id);
    if (el && recalcCot) el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', recalcCot);
  });

  // Toggle IVA % visibility
  const chkIva = document.getElementById('chk-iva');
  const ivaWrap = document.getElementById('iva-pct-wrap');
  if (chkIva && ivaWrap) {
    const toggle = () => { ivaWrap.style.opacity = chkIva.checked ? '1' : '0.4'; };
    chkIva.addEventListener('change', toggle);
    toggle();
  }

  // Servicios - items
  setupDynamicTable({
    btnId: 'btn-agregar-item', tbodyId: 'items-body', tmplId: 'tmpl-item',
    totalId: 'total-items', removeBtn: '.btn-quitar-item', calcClass: 'item-calc',
    rowClass: '.fila-item', cantName: '[name="item_cantidad"]',
    precioName: '[name="item_precio"]', subCell: '.item-subtotal', useCurrency: false
  });
});
