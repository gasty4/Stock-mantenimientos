// ================= Datos base =================
const LS_TASKS = 'mant_tasks_v2';
const LS_DIST = 'mant_distancias_v1';

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const ESTADOS = ['Pendiente','Lista','MND','Asociar'];
const TIPOS = ['Mensual','Bimestral','Trimestral','Semestral','OTS','OTA'];
const TIPOS_PUNTUALES = ['OTS','OTA']; // trabajos puntuales: no vencen ni se renuevan solos
const INTERVALO = {Mensual:1, Bimestral:2, Trimestral:3, Semestral:6};
const ABONO_COLOR = {Mensual:'#FFC000', Bimestral:'#C2D69B', Trimestral:'#92D050', Semestral:'#B4A7D6', OTA:'#4472C4', OTS:'#9DC3E6'};
function esPuntual(t){ return TIPOS_PUNTUALES.includes(t.tipo_abono); }

let TASKS = [];
let DIST = {};

function saveTasks(t){ localStorage.setItem(LS_TASKS, JSON.stringify(t)); }
function saveDist(d){ localStorage.setItem(LS_DIST, JSON.stringify(d)); }

async function loadSeedData(){
  try{
    const resp = await fetch('./datos.html', {cache:'no-store'});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const text = await resp.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const tasksEl = doc.getElementById('DATA_TASKS');
    const distEl = doc.getElementById('DATA_DIST');
    return {
      tasks: tasksEl ? JSON.parse(tasksEl.textContent) : [],
      dist: distEl ? JSON.parse(distEl.textContent) : {}
    };
  }catch(e){
    console.warn('No se pudo cargar datos.html:', e);
    return null;
  }
}

function syncDistancias(){
  TASKS.forEach(t => { if(DIST.hasOwnProperty(t.localidad)) t.distancia_km = DIST[t.localidad]; });
}
function normalizeTasks(){
  TASKS.forEach(t=>{ if(!Array.isArray(t.registro)) t.registro = []; });
}

// ================= Utilidades de estado/distribución =================
function distTotal(t, estado){ return (t.distribucion && t.distribucion[estado]) || 0; }
function isFullyPending(t){ return distTotal(t,'Pendiente') === t.cantidad; }
function isMixed(t){
  const nonZero = ESTADOS.filter(e => distTotal(t,e) > 0);
  return nonZero.length > 1;
}
function dominantEstado(t){
  // el único estado con cantidad>0, o 'Pendiente' si está mezclado (no debería llamarse en ese caso)
  const nonZero = ESTADOS.filter(e => distTotal(t,e) > 0);
  return nonZero.length === 1 ? nonZero[0] : 'Pendiente';
}
function setAllTo(t, estado){
  t.distribucion = {Pendiente:0, Lista:0, MND:0, Asociar:0};
  t.distribucion[estado] = t.cantidad;
}
function addRegistro(t, fecha, detalle){
  if(!Array.isArray(t.registro)) t.registro = [];
  t.registro.unshift({fecha, detalle});
}
function registroHtml(t){
  if(!t.registro || t.registro.length===0){
    return `<div class="dist-sum-hint">Todavía no hay registros para esta tarea.</div>`;
  }
  return t.registro.map((r,idx)=>`
    <div class="detail-row" data-idx="${idx}">
      <div>
        <div class="k" style="color:var(--text);font-weight:600;">${fmtDate(r.fecha)}</div>
        <div class="k" style="font-size:11.5px;">${escapeHtml(r.detalle)}</div>
      </div>
      <button class="plan-remove regDelete" data-idx="${idx}" title="Borrar registro">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}
// Aplica un cambio de estado completo (todas las máquinas al mismo estado).
// Si el destino es Lista/MND/Asociar, primero pide la fecha en que se hizo.
function applyEstadoConFecha(t, estado, afterFn){
  if(estado === 'Pendiente'){
    setAllTo(t, 'Pendiente');
    saveTasks(TASKS);
    if(afterFn) afterFn();
    return;
  }
  askFechaRealizacion(`¿Qué día se marcó como ${estado}?`, (fecha)=>{
    setAllTo(t, estado);
    addRegistro(t, fecha, `${estado} (${t.cantidad}/${t.cantidad} equipos)`);
    saveTasks(TASKS);
    if(afterFn) afterFn();
  });
}
function askFechaRealizacion(titulo, onConfirm){
  document.getElementById('dateSheetTitle').textContent = titulo;
  document.getElementById('dateSheetBody').innerHTML = `
    <div class="field-label">Fecha</div>
    <input type="date" id="dateSheetInput" value="${todayStr()}">
    <button class="primary-btn" id="dateSheetConfirm">Confirmar</button>
  `;
  document.getElementById('dateSheetConfirm').onclick = ()=>{
    const val = document.getElementById('dateSheetInput').value || todayStr();
    closeSheet('dateSheet');
    onConfirm(val);
  };
  openSheet('dateSheet');
}

// ================= Vencimiento / renovación automática =================
function dueYM(t){ return t.anio_vencimiento*12 + (t.mes_vencimiento-1); }
function nowYM(){ const d = new Date(); return d.getFullYear()*12 + d.getMonth(); }

function isOverdue(t){ return !esPuntual(t) && dueYM(t) < nowYM(); }

function processRenewals(){
  let renewedCount = 0;
  TASKS.forEach(t=>{
    if(esPuntual(t)) return; // OTS/OTA son puntuales: no vencen ni se renuevan solos
    const interval = INTERVALO[t.tipo_abono] || 3;
    let guard = 0;
    while(dueYM(t) < nowYM() && guard < 60){
      guard++;
      if(isFullyPending(t)){
        // quedó sin marcar de ninguna manera: no se renueva solo, se avisa (vencido)
        break;
      }
      // se marcó (total o parcialmente): renovar ciclo, todo vuelve a Pendiente
      const total = t.mes_vencimiento - 1 + interval;
      t.anio_vencimiento = t.anio_vencimiento + Math.floor(total/12);
      t.mes_vencimiento = (total % 12) + 1;
      setAllTo(t, 'Pendiente');
      t.fecha_planificada = null;
      renewedCount++;
    }
  });
  if(renewedCount>0) saveTasks(TASKS);
}
function overdueUnresolved(){
  return TASKS.filter(t => isOverdue(t) && isFullyPending(t));
}

// ================= Frescura (solo Trimestral) =================
function daysSince(iso){
  if(!iso) return null;
  const d = new Date(iso+'T00:00:00');
  const now = new Date();
  const diffMs = now.setHours(0,0,0,0) - d.setHours(0,0,0,0);
  return Math.round(diffMs / 86400000);
}
function freshnessInfo(t){
  if(t.tipo_abono !== 'Trimestral' || !t.ultimo_mantenimiento) return null;
  const d = daysSince(t.ultimo_mantenimiento);
  if(d === null || d < 0) return null;
  if(d <= 30) return {cls:'fresh-fresco', label:'Hecho hace ≤1 mes'};
  if(d <= 60) return {cls:'fresh-medio', label:'Hecho hace 1-2 meses'};
  if(d <= 90) return {cls:'fresh-alerta', label:'Hecho hace 2-3 meses'};
  return {cls:'fresh-vencido', label:'Hace más de 3 meses'};
}

// ================= Estado de UI =================
const state = {
  view: 'meses',
  search: '',
  estadoFilter: 'Todos',
  tipoFilter: 'Todos',
  localidadFilter: [], // vacío = todas
  sortBy: 'distancia',
  selectedMonth: (new Date().getMonth()+1),
  planDate: todayStr(),
  editingId: null,
};

function todayStr(){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

// ================= Helpers =================
function distOf(t){ return (typeof t.distancia_km === 'number') ? t.distancia_km : 999; }
function fmtDate(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function fmtKm(t){
  const d = t.distancia_km;
  if(d === null || d === undefined) return 'sin dato';
  if(d === 0) return 'Local';
  return d + ' km';
}
function uniqueLocalidades(){
  return [...new Set(TASKS.map(t=>t.localidad))].sort((a,b)=>a.localeCompare(b));
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function taskEstadoLabel(t){
  if(isOverdue(t) && isFullyPending(t)) return 'Vencido';
  if(isMixed(t)) return null; // se muestra desglosado
  return dominantEstado(t);
}

function isFiltersActive(){
  return state.tipoFilter!=='Todos' || state.localidadFilter.length>0 || state.sortBy!=='distancia' || state.estadoFilter!=='Todos';
}

function matchesEstadoFilter(t){
  if(state.estadoFilter==='Todos') return true;
  if(state.estadoFilter==='Vencido') return isOverdue(t) && isFullyPending(t);
  return distTotal(t, state.estadoFilter) > 0;
}

function applyFilters(list){
  let out = list.slice();
  out = out.filter(matchesEstadoFilter);
  if(state.tipoFilter !== 'Todos') out = out.filter(t=>t.tipo_abono===state.tipoFilter);
  if(state.localidadFilter.length>0) out = out.filter(t=>state.localidadFilter.includes(t.localidad));
  if(state.search.trim()){
    const q = state.search.trim().toLowerCase();
    out = out.filter(t =>
      (t.cliente||'').toLowerCase().includes(q) ||
      (t.localidad||'').toLowerCase().includes(q) ||
      (t.direccion||'').toLowerCase().includes(q)
    );
  }
  out.sort((a,b)=>{
    switch(state.sortBy){
      case 'distancia': return distOf(a)-distOf(b);
      case 'vencimiento': return dueYM(a)-dueYM(b);
      case 'tipo_abono': return a.tipo_abono.localeCompare(b.tipo_abono);
      case 'estado': return ESTADOS.indexOf(dominantEstado(a))-ESTADOS.indexOf(dominantEstado(b));
      case 'localidad': return a.localidad.localeCompare(b.localidad);
      case 'cliente': return (a.cliente||'').localeCompare(b.cliente||'');
      default: return 0;
    }
  });
  return out;
}

// ================= Chips de estado =================
function renderStateChips(){
  const row = document.getElementById('stateChipRow');
  const counts = {Todos: TASKS.length, Vencido: overdueUnresolved().length};
  ESTADOS.forEach(e => counts[e] = TASKS.filter(t=>distTotal(t,e)>0).length);
  const items = ['Todos', ...ESTADOS, 'Vencido'];
  row.innerHTML = items.map(e => `
    <div class="chip state-${e} ${state.estadoFilter===e?'active':''}" data-estado="${e}">
      ${e} <span class="count">${counts[e]}</span>
    </div>
  `).join('');
  row.querySelectorAll('.chip').forEach(el=>{
    el.addEventListener('click', ()=>{ state.estadoFilter = el.dataset.estado; renderAll(); });
  });
}

// ================= Tarjeta de tarea =================
function estadoBadgeHtml(t){
  if(isMixed(t)){
    return `<div class="mix-badges">${ESTADOS.filter(e=>distTotal(t,e)>0).map(e=>
      `<span class="mix-chip state-${e}">${e} ×${distTotal(t,e)}</span>`).join('')}</div>`;
  }
  const label = taskEstadoLabel(t);
  return `<div class="badge state-${label}">${label}</div>`;
}

function taskCardHtml(t){
  const venceLabel = MONTHS[(t.mes_vencimiento||1)-1];
  const abonoColor = ABONO_COLOR[t.tipo_abono] || '#8F9BA3';
  const fresh = freshnessInfo(t);
  const showQuick = !isMixed(t);
  return `
  <div class="task-card" data-id="${t.id}">
    <div class="row1">
      <div style="flex:1 1 180px;min-width:0;">
        <div class="cliente">${escapeHtml(t.cliente||'(sin cliente)')}</div>
        <div class="localidad-line">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          ${escapeHtml(t.localidad||'')} · ${fmtKm(t)}
        </div>
        <div class="localidad-line" style="margin-top:1px;">${escapeHtml(t.direccion||'')}</div>
      </div>
      ${estadoBadgeHtml(t)}
    </div>
    <div class="meta-row">
      <div class="abono-badge" style="background:${abonoColor};">${t.tipo_abono}</div>
      <div class="meta-tag">Vence: <b>&nbsp;${venceLabel}${t.anio_vencimiento!==2026?' '+t.anio_vencimiento:''}</b></div>
      <div class="meta-tag">Últ.: <b>&nbsp;${fmtDate(t.ultimo_mantenimiento)}</b></div>
      <div class="meta-tag">${t.cantidad} equipo${t.cantidad>1?'s':''}</div>
      ${t.modelo ? `<div class="meta-tag">${escapeHtml(t.modelo)}</div>` : ''}
      ${fresh ? `<div class="meta-tag fresh-dot" title="${fresh.label}"><span class="dot ${fresh.cls}"></span>${fresh.label}</div>` : ''}
    </div>
    ${t.nota ? `<div class="note-preview">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        ${escapeHtml(t.nota)}
      </div>` : ''}
    ${showQuick ? `<div class="quick-actions">
      ${ESTADOS.map(e=>`<button class="qa-btn ${dominantEstado(t)===e && !isMixed(t)?'active-'+e:''}" data-id="${t.id}" data-estado="${e}">${e}</button>`).join('')}
    </div>` : `<div class="quick-actions"><button class="qa-btn" data-id="${t.id}" data-open="1" style="flex:1;">Editar reparto de máquinas</button></div>`}
  </div>`;
}

function bindTaskCards(container, onChange){
  onChange = onChange || renderAll;
  container.querySelectorAll('.qa-btn[data-estado]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const t = TASKS.find(x=>x.id===btn.dataset.id);
      applyEstadoConFecha(t, btn.dataset.estado, onChange);
    });
  });
  container.querySelectorAll('.qa-btn[data-open]').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openTaskModal(btn.dataset.id); });
  });
  container.querySelectorAll('.task-card').forEach(card=>{
    card.addEventListener('click', (ev)=>{
      if(ev.target.closest('.drag-handle') || ev.target.closest('.plan-remove')) return;
      openTaskModal(card.dataset.id);
    });
  });
}

function emptyStateHtml(msg){
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    <p>${msg}</p>
  </div>`;
}

// ================= Vista: Meses =================
function renderMonthStrip(){
  const strip = document.getElementById('monthStrip');
  const curMonth = new Date().getMonth()+1;
  strip.innerHTML = MONTHS.map((name,i)=>{
    const num = i+1;
    const count = TASKS.filter(t=>t.mes_vencimiento===num && !estaResuelta(t)).length;
    return `<div class="month-pill ${state.selectedMonth===num?'active':''} ${curMonth===num?'current':''}" data-month="${num}">
      <span class="m-name">${name.slice(0,3)}</span>
      <span class="m-count">${count}</span>
    </div>`;
  }).join('');
  strip.querySelectorAll('.month-pill').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.selectedMonth = parseInt(el.dataset.month,10);
      renderMeses(); renderMonthStrip();
    });
  });
}
function isFullyDone(t){ return distTotal(t,'Lista') === t.cantidad; }
// "Sin resolver" = todavía queda alguna máquina en Pendiente. MND y Asociar son decisiones
// ya tomadas (no son "pendientes de resolver"), aunque no estén en Lista.
function estaResuelta(t){ return distTotal(t,'Pendiente') === 0; }

function renderMeses(){
  const list = applyFilters(TASKS.filter(t=>t.mes_vencimiento===state.selectedMonth));
  document.getElementById('mesesLabel').textContent =
    `${MONTHS[state.selectedMonth-1]} · ${list.length} tarea${list.length!==1?'s':''}`;
  const container = document.getElementById('mesesList');
  if(list.length===0){
    container.innerHTML = emptyStateHtml('Nada para este filtro en '+MONTHS[state.selectedMonth-1]+'.');
    return;
  }
  container.innerHTML = list.map(t=>taskCardHtml(t)).join('');
  bindTaskCards(container);
}

// ================= Vista: Todos =================
function renderTodos(){
  const list = applyFilters(TASKS);
  document.getElementById('todosLabel').textContent = `${list.length} tarea${list.length!==1?'s':''}`;
  const container = document.getElementById('todosList');
  if(list.length===0){
    container.innerHTML = emptyStateHtml('No hay tareas que coincidan con el filtro.');
    return;
  }
  container.innerHTML = list.map(t=>taskCardHtml(t)).join('');
  bindTaskCards(container);
}

// ================= Vista: Planificar =================
let dragCtx = null;

function currentPlanTasks(){
  return TASKS.filter(t=>t.fecha_planificada===state.planDate).sort((a,b)=>(a.orden_plan||0)-(b.orden_plan||0));
}

function renderPlan(){
  document.getElementById('planDate').value = state.planDate;
  const dayTasks = currentPlanTasks();
  const pend = dayTasks.filter(t=>!estaResuelta(t)).length;
  const hechas = dayTasks.length - pend;
  document.getElementById('planSummary').innerHTML = `
    <div class="plan-stat"><div class="n">${dayTasks.length}</div><div class="l">Paradas</div></div>
    <div class="plan-stat"><div class="n">${pend}</div><div class="l">Pendientes</div></div>
    <div class="plan-stat"><div class="n">${hechas}</div><div class="l">Resueltas</div></div>
  `;
  const container = document.getElementById('planList');
  if(dayTasks.length===0){
    container.innerHTML = emptyStateHtml('Todavía no agregaste paradas para este día. Usá el botón + para sumar tareas.');
    return;
  }
  container.innerHTML = dayTasks.map((t,idx)=>`
    <div class="plan-card" data-id="${t.id}">
      <div class="plan-card-side">
        <div class="drag-handle" data-id="${t.id}" title="Arrastrar para reordenar">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
        </div>
        <div class="num">${idx+1}</div>
      </div>
      <div class="plan-card-inner">${taskCardHtml(t)}</div>
      <button class="plan-remove" data-id="${t.id}" title="Quitar del recorrido">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');

  bindTaskCards(container, ()=>{ renderPlan(); renderStateChips(); });
  container.querySelectorAll('.plan-remove').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const t = TASKS.find(x=>x.id===btn.dataset.id);
      t.fecha_planificada = null;
      saveTasks(TASKS);
      renderPlan();
    });
  });
  container.querySelectorAll('.drag-handle').forEach(handle=>{
    handle.addEventListener('pointerdown', onDragStart);
  });
}

function onDragStart(ev){
  const handle = ev.currentTarget;
  const card = handle.closest('.plan-card');
  const container = document.getElementById('planList');
  handle.setPointerCapture(ev.pointerId);
  card.classList.add('dragging');
  dragCtx = {pointerId: ev.pointerId, card, container};
  const move = (e)=>{
    if(!dragCtx || e.pointerId !== dragCtx.pointerId) return;
    const y = e.clientY;
    const siblings = [...container.querySelectorAll('.plan-card')].filter(c=>c!==card);
    for(const sib of siblings){
      const rect = sib.getBoundingClientRect();
      const mid = rect.top + rect.height/2;
      if(y < mid && sib.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING){
        container.insertBefore(card, sib);
        break;
      }
      if(y > mid && sib.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING){
        container.insertBefore(card, sib.nextSibling);
        break;
      }
    }
  };
  const up = (e)=>{
    if(!dragCtx || e.pointerId !== dragCtx.pointerId) return;
    card.classList.remove('dragging');
    handle.releasePointerCapture(e.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    // commit new order
    const ids = [...container.querySelectorAll('.plan-card')].map(c=>c.dataset.id);
    ids.forEach((id, idx)=>{
      const t = TASKS.find(x=>x.id===id);
      if(t) t.orden_plan = idx+1;
    });
    saveTasks(TASKS);
    dragCtx = null;
    renderPlan();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

function openPlanPicker(){
  const body = document.getElementById('planPickerBody');
  const candidates = TASKS.filter(t=>t.fecha_planificada!==state.planDate).sort((a,b)=>distOf(a)-distOf(b));
  if(candidates.length===0){
    body.innerHTML = emptyStateHtml('No quedan tareas para agregar.');
  } else {
    body.innerHTML = candidates.map(t=>`
      <div class="picker-item" data-id="${t.id}">
        <div>
          <div class="cliente">${escapeHtml(t.cliente||'')}</div>
          <div class="sub">${escapeHtml(t.localidad)} · ${fmtKm(t)} · ${t.tipo_abono} · <span style="color:var(--text-faint)">${isMixed(t)?'mixto':dominantEstado(t)}</span></div>
        </div>
        <button class="add-btn" data-id="${t.id}">Agregar</button>
      </div>
    `).join('');
    body.querySelectorAll('.add-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const t = TASKS.find(x=>x.id===btn.dataset.id);
        const maxOrden = Math.max(0, ...TASKS.filter(x=>x.fecha_planificada===state.planDate).map(x=>x.orden_plan||0));
        t.fecha_planificada = state.planDate;
        t.orden_plan = maxOrden+1;
        saveTasks(TASKS);
        btn.textContent = 'Agregado';
        btn.classList.add('added');
        btn.disabled = true;
      });
    });
  }
  openSheet('planPickerSheet');
}

// ================= Modal de detalle =================
function distEditorHtml(t){
  return `
    <div class="field-label">Reparto por máquina (${t.cantidad} en total)</div>
    ${ESTADOS.map(e=>`
      <div class="dist-editor-row">
        <div class="lbl">${e}</div>
        <input type="number" min="0" max="${t.cantidad}" id="dist_${e}" value="${distTotal(t,e)}">
      </div>
    `).join('')}
    <div class="dist-sum-hint" id="distSumHint">La suma debe dar ${t.cantidad}.</div>
  `;
}

function openTaskModal(id){
  const t = TASKS.find(x=>x.id===id);
  if(!t) return;
  state.editingId = id;
  document.getElementById('modalTitle').textContent = t.cliente || 'Tarea';
  const histHtml = (t.historial||[]).map(h=>`<span class="hist-dot ${h.color}">${h.mes_nombre} · ${fmtDate(h.fecha)}</span>`).join('');
  const overdueFlag = isOverdue(t) && isFullyPending(t);
  document.getElementById('modalBody').innerHTML = `
    ${overdueFlag ? `<div style="background:var(--red-dim);color:var(--red);padding:9px 12px;border-radius:10px;font-size:12.5px;font-weight:600;margin-bottom:14px;">
      Este mantenimiento venció en ${MONTHS[t.mes_vencimiento-1]} y no fue marcado. Elegí un estado o reprogramá el vencimiento.
    </div>` : ''}
    <div class="field-label">Marcar todo como</div>
    <div class="state-grid">
      ${ESTADOS.map(e=>`<button class="state-big-btn sel-${(!isMixed(t) && dominantEstado(t)===e)?e:''}" data-estado="${e}">${e}</button>`).join('')}
    </div>

    ${distEditorHtml(t)}

    <div class="field-label">Datos del local</div>
    <div class="detail-row"><div class="k">Localidad</div><div class="v">${escapeHtml(t.localidad||'')}</div></div>
    <div class="detail-row"><div class="k">Dirección</div><div class="v">${escapeHtml(t.direccion||'—')}</div></div>
    <div class="detail-row"><div class="k">Distancia</div><div class="v">${fmtKm(t)}</div></div>

    <div class="field-label">Modelo de equipo</div>
    <input type="text" id="editModelo" value="${escapeHtml(t.modelo||'')}">
    <div class="field-label">Cantidad de equipos</div>
    <input type="number" id="editCantidad" min="1" value="${t.cantidad}">
    <div class="dist-sum-hint">Si cambiás la cantidad, el reparto se reinicia a Pendiente.</div>

    <div class="field-label">Tipo de abono</div>
    <select id="editTipoAbono">
      ${TIPOS.map(ti=>`<option value="${ti}" ${t.tipo_abono===ti?'selected':''}>${ti}</option>`).join('')}
    </select>
    <div class="detail-row"><div class="k">Último mantenimiento</div><div class="v">${fmtDate(t.ultimo_mantenimiento)}</div></div>
    ${esPuntual(t) ? `<div class="dist-sum-hint">Los trabajos OTS/OTA son puntuales: no vencen ni se renuevan solos.</div>` : ''}

    ${histHtml ? `<div class="field-label">Historial 2026 (Excel)</div><div class="hist-strip">${histHtml}</div>` : ''}

    <div class="field-label">Registro de esta app</div>
    <div id="registroList">${registroHtml(t)}</div>

    <div class="field-label">Mes de vencimiento</div>
    <select id="editMes">
      ${MONTHS.map((m,i)=>`<option value="${i+1}" ${t.mes_vencimiento===i+1?'selected':''}>${m}</option>`).join('')}
    </select>

    <div class="field-label">Planificar visita</div>
    <input type="date" id="editFecha" value="${t.fecha_planificada||''}">

    <div class="field-label">Observaciones para el próximo mantenimiento</div>
    <textarea id="editNota" rows="3" placeholder="Cosas a tener en cuenta la próxima vez…">${escapeHtml(t.nota||'')}</textarea>

    <button class="primary-btn" id="modalSave">Guardar cambios</button>
    <button class="danger-link" id="modalDelete">Eliminar tarea</button>
  `;

  document.getElementById('modalBody').querySelectorAll('.regDelete').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const idx = parseInt(btn.dataset.idx,10);
      t.registro.splice(idx,1);
      saveTasks(TASKS);
      openTaskModal(id);
    });
  });
  ESTADOS.forEach(e=>{
    const inp = document.getElementById('dist_'+e);
    if(inp) inp.addEventListener('input', ()=>{
      const hint = document.getElementById('distSumHint');
      let sum = 0;
      ESTADOS.forEach(e2=>{ sum += parseInt(document.getElementById('dist_'+e2).value,10) || 0; });
      hint.textContent = `Suma actual: ${sum} de ${t.cantidad}.`;
      hint.classList.toggle('err', sum !== t.cantidad);
    });
  });
  document.getElementById('modalBody').querySelectorAll('.state-big-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      applyEstadoConFecha(t, btn.dataset.estado, ()=>{ openTaskModal(id); renderAll(); });
    });
  });
  document.getElementById('modalSave').addEventListener('click', ()=>{
    const nuevaCantidad = parseInt(document.getElementById('editCantidad').value,10) || 1;
    const otrosCambios = ()=>{
      t.modelo = document.getElementById('editModelo').value.trim();
      t.tipo_abono = document.getElementById('editTipoAbono').value;
      t.mes_vencimiento = parseInt(document.getElementById('editMes').value,10);
      const fecha = document.getElementById('editFecha').value;
      if(fecha){
        if(t.fecha_planificada !== fecha){
          const maxOrden = Math.max(0, ...TASKS.filter(x=>x.fecha_planificada===fecha).map(x=>x.orden_plan||0));
          t.orden_plan = maxOrden+1;
        }
        t.fecha_planificada = fecha;
      } else {
        t.fecha_planificada = null;
      }
      t.nota = document.getElementById('editNota').value;
    };

    if(nuevaCantidad !== t.cantidad){
      t.cantidad = nuevaCantidad;
      setAllTo(t, 'Pendiente');
      otrosCambios();
      saveTasks(TASKS);
      closeSheet('taskModal');
      renderAll();
      return;
    }

    const vals = {}; let sum = 0;
    ESTADOS.forEach(e=>{
      const v = parseInt(document.getElementById('dist_'+e).value,10) || 0;
      vals[e] = v; sum += v;
    });
    if(sum !== t.cantidad){
      alert('El reparto por máquina debe sumar '+t.cantidad+'. Corregilo para poder guardar ese cambio (el resto de los campos sí se guardó).');
      otrosCambios();
      saveTasks(TASKS);
      closeSheet('taskModal');
      renderAll();
      return;
    }

    const subieAlgo = ['Lista','MND','Asociar'].some(e => vals[e] > distTotal(t,e));
    const finalizar = (fecha)=>{
      if(fecha){
        const partes = ['Lista','MND','Asociar'].filter(e=>vals[e] > distTotal(t,e)).map(e=>`${e} +${vals[e]-distTotal(t,e)}`);
        if(partes.length) addRegistro(t, fecha, partes.join(', ')+` (reparto: ${vals.Pendiente}P/${vals.Lista}L/${vals.MND}M/${vals.Asociar}A)`);
      }
      t.distribucion = vals;
      otrosCambios();
      saveTasks(TASKS);
      closeSheet('taskModal');
      renderAll();
    };
    if(subieAlgo){
      askFechaRealizacion('¿Qué día se hizo ese trabajo?', (fecha)=> finalizar(fecha));
    } else {
      finalizar(null);
    }
  });
  document.getElementById('modalDelete').addEventListener('click', ()=>{
    if(confirm('¿Eliminar esta tarea definitivamente?')){
      TASKS = TASKS.filter(x=>x.id!==id);
      saveTasks(TASKS);
      closeSheet('taskModal');
      renderAll();
    }
  });

  openSheet('taskModal');
}

// ================= Agregar nueva tarea =================
function openAddSheet(){
  const locs = uniqueLocalidades();
  document.getElementById('addBody').innerHTML = `
    <div class="field-label">Cliente</div>
    <input type="text" id="newCliente" placeholder="Nombre del cliente / sucursal">
    <div class="field-label">Localidad</div>
    <input type="text" id="newLocalidad" list="locList" placeholder="Localidad">
    <datalist id="locList">${locs.map(l=>`<option value="${escapeHtml(l)}">`).join('')}</datalist>
    <div class="field-label">Dirección</div>
    <input type="text" id="newDireccion" placeholder="Dirección">
    <div class="field-label">Modelo</div>
    <input type="text" id="newModelo" placeholder="Modelo de equipo">
    <div class="field-label">Cantidad de equipos</div>
    <input type="number" id="newCantidad" min="1" value="1">
    <div class="field-label">Tipo de abono</div>
    <div class="option-grid" id="newTipo">
      ${TIPOS.map((t,i)=>`<div class="option-btn ${i===0?'active':''}" data-tipo="${t}">${t}</div>`).join('')}
    </div>
    <div class="field-label">Mes de vencimiento</div>
    <select id="newMes">${MONTHS.map((m,i)=>`<option value="${i+1}" ${i+1===new Date().getMonth()+1?'selected':''}>${m}</option>`).join('')}</select>
    <div class="field-label">Distancia (km desde base)</div>
    <input type="number" id="newDistancia" min="0" placeholder="0">
    <button class="primary-btn" id="saveNewTask">Crear tarea</button>
  `;
  let tipoSel = TIPOS[0];
  document.querySelectorAll('#newTipo .option-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#newTipo .option-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); tipoSel = btn.dataset.tipo;
    });
  });
  document.getElementById('newLocalidad').addEventListener('change', (e)=>{
    const km = DIST[e.target.value.trim()];
    if(km !== undefined) document.getElementById('newDistancia').value = km;
  });
  document.getElementById('saveNewTask').addEventListener('click', ()=>{
    const cliente = document.getElementById('newCliente').value.trim();
    const localidad = document.getElementById('newLocalidad').value.trim();
    if(!cliente || !localidad){ alert('Completá al menos cliente y localidad.'); return; }
    const distVal = document.getElementById('newDistancia').value;
    const dist = distVal===''? (DIST[localidad] ?? null) : parseFloat(distVal);
    if(!DIST.hasOwnProperty(localidad) && distVal!==''){ DIST[localidad] = parseFloat(distVal); saveDist(DIST); }
    const cantidad = parseInt(document.getElementById('newCantidad').value,10) || 1;
    const newTask = {
      id: 't' + Date.now(),
      tipo_abono: tipoSel, localidad, cliente,
      modelo: document.getElementById('newModelo').value.trim(),
      direccion: document.getElementById('newDireccion').value.trim(),
      cantidad, distribucion: {Pendiente:cantidad, Lista:0, MND:0, Asociar:0},
      historial: [], ultimo_mantenimiento: null,
      mes_vencimiento: parseInt(document.getElementById('newMes').value,10),
      anio_vencimiento: new Date().getFullYear(),
      distancia_km: dist, fecha_planificada: null, orden_plan: 0, nota: '', registro: []
    };
    TASKS.push(newTask);
    saveTasks(TASKS);
    closeSheet('addSheet');
    renderAll();
  });
  openSheet('addSheet');
}

// ================= Distancias =================
function openDistSheet(){
  const locs = uniqueLocalidades();
  document.getElementById('distBody').innerHTML = locs.map(l=>`
    <div class="detail-row" style="align-items:center;">
      <div class="k">${escapeHtml(l)}</div>
      <input type="number" min="0" data-loc="${escapeHtml(l)}" value="${DIST[l] ?? ''}" style="width:90px;text-align:right;">
    </div>
  `).join('') + `<button class="primary-btn" id="saveDist">Guardar distancias</button>`;
  document.getElementById('saveDist').addEventListener('click', ()=>{
    document.querySelectorAll('#distBody input').forEach(inp=>{
      const v = parseFloat(inp.value);
      if(!isNaN(v)) DIST[inp.dataset.loc] = v;
    });
    saveDist(DIST); syncDistancias(); saveTasks(TASKS);
    closeSheet('distSheet'); renderAll();
  });
  openSheet('distSheet');
}

// ================= Filter sheet =================
function renderFilterSheet(){
  const sortLabels = {distancia:'Distancia', vencimiento:'Mes de vencimiento', tipo_abono:'Tipo de abono', estado:'Estado', localidad:'Localidad', cliente:'Cliente'};
  document.getElementById('sortOptions').innerHTML = Object.entries(sortLabels).map(([k,v])=>
    `<div class="option-btn ${state.sortBy===k?'active':''}" data-sort="${k}">${v}</div>`).join('');
  document.getElementById('tipoOptions').innerHTML = ['Todos',...TIPOS].map(t=>
    `<div class="option-btn ${state.tipoFilter===t?'active':''}" data-tipo="${t}">${t}</div>`).join('');

  const locs = uniqueLocalidades();
  const locList = document.getElementById('localidadCheckList');
  locList.innerHTML = `<label class="chk"><input type="checkbox" id="locTodas" ${state.localidadFilter.length===0?'checked':''}> Todas las localidades</label>` +
    locs.map(l=>`<label class="chk"><input type="checkbox" class="locChk" value="${escapeHtml(l)}" ${state.localidadFilter.includes(l)?'checked':''}> ${escapeHtml(l)}</label>`).join('');
  document.getElementById('locFilterCount').textContent = state.localidadFilter.length>0 ? `(${state.localidadFilter.length} elegidas)` : '';

  document.getElementById('locTodas').addEventListener('change', (e)=>{
    if(e.target.checked){ state.localidadFilter = []; renderFilterSheet(); }
  });
  locList.querySelectorAll('.locChk').forEach(chk=>{
    chk.addEventListener('change', ()=>{
      if(chk.checked) state.localidadFilter = [...new Set([...state.localidadFilter, chk.value])];
      else state.localidadFilter = state.localidadFilter.filter(x=>x!==chk.value);
      renderFilterSheet();
    });
  });

  document.querySelectorAll('#sortOptions .option-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#sortOptions .option-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); state.sortBy = btn.dataset.sort;
    });
  });
  document.querySelectorAll('#tipoOptions .option-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('#tipoOptions .option-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active'); state.tipoFilter = btn.dataset.tipo;
    });
  });
}

// ================= Sheets / overlay =================
function openSheet(id){ document.getElementById('overlay').classList.add('show'); document.getElementById(id).classList.add('show'); }
function closeSheet(id){
  document.getElementById(id).classList.remove('show');
  if(document.querySelectorAll('.sheet.show').length===0) document.getElementById('overlay').classList.remove('show');
}
function closeAllSheets(){
  document.querySelectorAll('.sheet.show').forEach(s=>s.classList.remove('show'));
  document.getElementById('overlay').classList.remove('show');
}

// ================= Navegación =================
function switchView(view){
  state.view = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  document.getElementById('searchRow').style.display = (view==='plan' || view==='stock') ? 'none' : 'flex';
  document.getElementById('stateChipRow').style.display = (view==='plan' || view==='stock') ? 'none' : 'flex';
  document.getElementById('fabAdd').style.display = (view==='stock') ? 'none' : 'flex';
  renderAll();
}

// ================= Overdue banner =================
function renderOverdueBanner(){
  const banner = document.getElementById('overdueBanner');
  const list = overdueUnresolved();
  if(list.length===0){ banner.style.display='none'; return; }
  banner.style.display = 'flex';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <p>Tenés ${list.length} mantenimiento${list.length!==1?'s':''} vencido${list.length!==1?'s':''} sin marcar. Decidí qué hacer con cada uno.</p>
    <button id="bannerReview">Ver</button>
  `;
  document.getElementById('bannerReview').addEventListener('click', ()=>{
    state.estadoFilter = 'Vencido';
    switchView('todos');
  });
}

// ================= Render maestro =================
function renderAll(){
  const isStock = state.view === 'stock';
  document.getElementById('pageTitle').textContent = isStock ? 'Repuestos' : 'Mantenimientos';
  document.getElementById('btnBackup').style.display = isStock ? 'none' : 'flex';
  document.getElementById('btnSettings').style.display = isStock ? 'none' : 'flex';
  document.getElementById('btnFilter').style.display = isStock ? 'none' : 'flex';

  if(isStock){
    document.getElementById('pageSub').style.display = 'none';
    document.getElementById('overdueBanner').style.display = 'none';
  } else {
    document.getElementById('pageSub').style.display = 'block';
    renderStateChips();
    renderOverdueBanner();
    document.getElementById('filterDot').style.display = isFiltersActive() ? 'block' : 'none';
    const sucursalesPendientes = TASKS.filter(t=>!estaResuelta(t)).length;
    const maquinasPendientes = TASKS.reduce((s,t)=> s + distTotal(t,'Pendiente'), 0);
    document.getElementById('pageSub').textContent =
      `${sucursalesPendientes} sucursales · ${maquinasPendientes} máquinas sin resolver de ${TASKS.length} en total`;
  }

  if(state.view==='meses'){ renderMonthStrip(); renderMeses(); }
  else if(state.view==='todos'){ renderTodos(); }
  else if(state.view==='plan'){ renderPlan(); }
  else if(state.view==='stock'){ renderStockChips(); renderStockFilterChips(); renderStockList(); }
}

// ================= Copia de seguridad (Excel + Google Drive) =================
const LS_GDRIVE_CLIENTID = 'mant_gdrive_clientid';
const LS_GDRIVE_LAST_BACKUP = 'mant_gdrive_last_backup';
let gTokenClient = null;
let gAccessToken = null;

function openBackupSheet(){ renderBackupSheet(); openSheet('backupSheet'); }

function renderBackupSheet(){
  const clientId = localStorage.getItem(LS_GDRIVE_CLIENTID) || '';
  const lastBackup = localStorage.getItem(LS_GDRIVE_LAST_BACKUP);
  document.getElementById('backupBody').innerHTML = `
    <div class="field-label">Excel</div>
    <button class="primary-btn" id="backupExportExcel" style="margin-top:0;">Exportar a Excel</button>
    <button class="primary-btn" id="backupImportExcel" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);">Importar desde Excel</button>

    <div class="field-label">Google Drive</div>
    ${lastBackup ? `<div class="dist-sum-hint">Última copia en Drive: ${new Date(lastBackup).toLocaleString('es-AR')}</div>` : `<div class="dist-sum-hint">Todavía no hiciste ninguna copia a Drive.</div>`}
    <input type="text" id="gdriveClientId" placeholder="Client ID de Google (una sola vez)" value="${escapeHtml(clientId)}" style="margin-top:10px;">
    <button class="link-btn" id="gdriveSaveClientId" style="padding:8px 0;">Guardar Client ID</button>
    <button class="primary-btn" id="backupToDrive">Hacer copia de seguridad a Drive</button>
    <button class="primary-btn" id="restoreFromDrive" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);">Restaurar desde Drive</button>
    <div class="dist-sum-hint">La copia se guarda como "mantenimientos_backup.json" en tu Google Drive, en la carpeta raíz ("Mi unidad"). Restaurar reemplaza todos los datos actuales de la app por los del backup.</div>
  `;
  document.getElementById('backupExportExcel').addEventListener('click', exportarExcel);
  document.getElementById('backupImportExcel').addEventListener('click', ()=> document.getElementById('importFileInput').click());
  document.getElementById('gdriveSaveClientId').addEventListener('click', ()=>{
    const val = document.getElementById('gdriveClientId').value.trim();
    localStorage.setItem(LS_GDRIVE_CLIENTID, val);
    gTokenClient = null; // se reconstruye con el nuevo client id
    alert('Client ID guardado.');
  });
  document.getElementById('backupToDrive').addEventListener('click', backupToDrive);
  document.getElementById('restoreFromDrive').addEventListener('click', restoreFromDrive);
}

// Si el campo del Client ID tiene algo escrito pero todavía no se guardó (el usuario
// se olvidó de tocar "Guardar Client ID"), lo guardamos solos antes de seguir.
function autoguardarClientIdSiHaceFalta(){
  const input = document.getElementById('gdriveClientId');
  if(input && input.value.trim()){
    localStorage.setItem(LS_GDRIVE_CLIENTID, input.value.trim());
  }
}

function ensureGoogleAuth(onReady, onFail){
  autoguardarClientIdSiHaceFalta();
  const clientId = localStorage.getItem(LS_GDRIVE_CLIENTID);
  if(!clientId){
    alert('Todavía no hay un Client ID de Google cargado. Pegalo en el campo "Client ID de Google" de esta pantalla y volvé a tocar el botón.');
    if(onFail) onFail();
    return;
  }
  if(typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2){
    alert('No se pudo cargar el inicio de sesión de Google. Revisá que el celular tenga conexión a internet e intentá de nuevo.');
    if(onFail) onFail();
    return;
  }
  if(!gTokenClient){
    gTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      // drive.file: para el backup propio. drive.readonly: para poder leer los 5 excel
      // de stock que ya existen en tu Drive (no fueron creados por esta app).
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
      callback: (resp)=>{
        if(resp.error){
          alert('No se pudo iniciar sesión con Google: '+resp.error);
          if(onFail) onFail();
          return;
        }
        gAccessToken = resp.access_token;
        onReady();
      }
    });
  } else {
    gTokenClient.callback = (resp)=>{
      if(resp.error){ alert('No se pudo iniciar sesión con Google: '+resp.error); if(onFail) onFail(); return; }
      gAccessToken = resp.access_token;
      onReady();
    };
  }
  gTokenClient.requestAccessToken({prompt: gAccessToken ? '' : 'consent'});
}

async function findDriveBackupFile(){
  const q = encodeURIComponent("name='mantenimientos_backup.json' and trashed=false");
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&spaces=drive`, {
    headers: {Authorization: `Bearer ${gAccessToken}`}
  });
  if(!res.ok) throw new Error('No se pudo consultar Google Drive (HTTP '+res.status+').');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

function backupToDrive(){
  ensureGoogleAuth(async ()=>{
    try{
      const existing = await findDriveBackupFile();
      const payload = JSON.stringify({tasks: TASKS, dist: DIST, exportado: new Date().toISOString()});
      const boundary = 'mant_backup_boundary';
      const metadata = {name:'mantenimientos_backup.json', mimeType:'application/json'};
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${existing?'{}':JSON.stringify(metadata)}\r\n`+
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const url = existing
        ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      const res = await fetch(url, {
        method: existing ? 'PATCH' : 'POST',
        headers: {Authorization:`Bearer ${gAccessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}`},
        body
      });
      if(!res.ok) throw new Error('HTTP '+res.status);
      localStorage.setItem(LS_GDRIVE_LAST_BACKUP, new Date().toISOString());
      alert('Copia de seguridad guardada en Google Drive.');
      renderBackupSheet();
    }catch(e){
      console.error(e);
      alert('No se pudo guardar la copia en Drive. Probá de nuevo o revisá el Client ID.');
    }
  });
}

function restoreFromDrive(){
  ensureGoogleAuth(async ()=>{
    try{
      const existing = await findDriveBackupFile();
      if(!existing){
        alert('No encontré ningún "mantenimientos_backup.json" en tu Drive todavía.');
        return;
      }
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, {
        headers: {Authorization:`Bearer ${gAccessToken}`}
      });
      if(!res.ok) throw new Error('HTTP '+res.status);
      const data = await res.json();
      const fecha = existing.modifiedTime ? new Date(existing.modifiedTime).toLocaleString('es-AR') : '';
      if(!confirm(`Esto va a reemplazar TODOS los datos actuales de la app por los del backup de Drive (guardado el ${fecha}). ¿Confirmás?`)) return;
      TASKS = Array.isArray(data.tasks) ? data.tasks : [];
      DIST = data.dist || {};
      normalizeTasks();
      saveTasks(TASKS);
      saveDist(DIST);
      syncDistancias();
      processRenewals();
      closeSheet('backupSheet');
      renderAll();
      alert('Datos restaurados desde Google Drive.');
    }catch(e){
      console.error(e);
      alert('No se pudo restaurar desde Drive. Probá de nuevo.');
    }
  });
}

// ================= Stock (lectura de 5 excel en Google Drive) =================
const LS_STOCK_TERMS = 'mant_stock_terms_v1';
const STOCK_SOURCES = [
  {key:'General', label:'General', isGeneral:true},
  {key:'Tuc01', label:'Tuc 01'},
  {key:'Tuc02', label:'Tuc 02'},
  {key:'Tuc03', label:'Tuc 03'},
  {key:'Tuc04', label:'Tuc 04'},
];
const DEFAULT_STOCK_TERMS = {General:'stock nodo', Tuc01:'Tuc 01', Tuc02:'Tuc 02', Tuc03:'Tuc 03', Tuc04:'Tuc 04'};
function loadStockTerms(){
  try{ return Object.assign({}, DEFAULT_STOCK_TERMS, JSON.parse(localStorage.getItem(LS_STOCK_TERMS)||'{}')); }
  catch(e){ return Object.assign({}, DEFAULT_STOCK_TERMS); }
}
function saveStockTerms(t){ localStorage.setItem(LS_STOCK_TERMS, JSON.stringify(t)); }
let STOCK_TERMS = loadStockTerms();

// La caché de stock se guarda en el celular: así los datos de la última actualización
// quedan disponibles aunque cierres la app o recargues la página, sin volver a pedir Google.
const LS_STOCK_CACHE = 'mant_stock_cache_v1';
function loadStockCache(){
  try{ return JSON.parse(localStorage.getItem(LS_STOCK_CACHE)||'{}'); }
  catch(e){ return {}; }
}
function saveStockCache(){
  try{ localStorage.setItem(LS_STOCK_CACHE, JSON.stringify(STOCK_CACHE)); }catch(e){ /* almacenamiento lleno, no bloqueamos la app */ }
}
let STOCK_CACHE = loadStockCache(); // key -> {items, fetchedAt, fileName, lastError?}
const STOCK_LOADING = {}; // key -> true mientras se está pidiendo a Drive (nunca se persiste)
state.stockSource = 'General';
state.stockSearch = '';
state.stockOnlyZero = false;

async function driveFindFileByName(term, startsWith){
  const safeTerm = term.replace(/'/g, "\\'");
  const q = startsWith
    ? `name contains '${safeTerm}' and trashed=false`
    : `name contains '${safeTerm}' and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=10`, {
    headers: {Authorization:`Bearer ${gAccessToken}`}
  });
  if(!res.ok) throw new Error('HTTP '+res.status);
  const data = await res.json();
  const files = data.files || [];
  if(startsWith){
    const lower = term.toLowerCase();
    const exact = files.find(f=>f.name.toLowerCase().startsWith(lower));
    if(exact) return exact;
  }
  return files[0] || null;
}

async function driveDownloadWorkbook(file){
  const isGoogleSheet = file.mimeType === 'application/vnd.google-apps.spreadsheet';
  const url = isGoogleSheet
    ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}`
    : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
  const res = await fetch(url, {headers:{Authorization:`Bearer ${gAccessToken}`}});
  if(!res.ok) throw new Error('HTTP '+res.status);
  const buf = await res.arrayBuffer();
  return XLSX.read(buf, {type:'array'});
}

function findSheetCaseInsensitive(wb, name){
  const key = wb.SheetNames.find(n => n.trim().toLowerCase() === name.trim().toLowerCase());
  return key ? wb.Sheets[key] : null;
}

function parseStockSheet(ws){
  if(!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:true});
  const dataRows = aoa.slice(11); // fila 11 (índice 10) es el título; los datos arrancan en la fila 12
  return dataRows
    .filter(r => r[0] !== '' && r[0] !== undefined)
    .map(r => ({
      codigo: String(r[0]).trim(),
      descripcion: String(r[1]||'').trim(),
      saldo: r[4]===''||r[4]===undefined ? 0 : r[4]
    }));
}

function parseGavetasSheet(ws){
  if(!ws) return {};
  const aoa = XLSX.utils.sheet_to_json(ws, {header:1, defval:'', raw:true});
  const dataRows = aoa.slice(1); // fila 1 es el título
  const map = {};
  dataRows.forEach(r=>{
    const codigo = String(r[1]||'').trim(); // columna B
    if(!codigo) return;
    const atributo = String(r[3]||'').trim(); // D
    const estante = String(r[4]||'').trim();  // E
    const ubicacion = String(r[5]||'').trim();// F
    const modelos = String(r[7]||'').trim();  // H
    const partes = [atributo, estante, ubicacion].filter(p=>p!=='');
    map[codigo] = {ubicacion: partes.join('-'), modelos};
  });
  return map;
}

function renderStockChips(){
  const row = document.getElementById('stockSourceChips');
  row.innerHTML = STOCK_SOURCES.map(s=>`
    <div class="chip ${state.stockSource===s.key?'active':''}" data-source="${s.key}">${s.label}</div>
  `).join('');
  row.querySelectorAll('.chip').forEach(el=>{
    el.addEventListener('click', ()=>{
      state.stockSource = el.dataset.source;
      renderStockChips();
      renderStockList(); // solo muestra lo que ya haya en caché; no dispara login solo/a
    });
  });
}

function renderStockFilterChips(){
  const row = document.getElementById('stockFilterChips');
  if(!row) return;
  row.innerHTML = `<div class="chip ${state.stockOnlyZero?'active':''}" id="chipStockZero">Solo en cero</div>`;
  document.getElementById('chipStockZero').addEventListener('click', ()=>{
    state.stockOnlyZero = !state.stockOnlyZero;
    renderStockFilterChips();
    renderStockList();
  });
}

function stockItemHtml(item){
  return `
  <div class="task-card stock-card">
    <div class="row1">
      <div style="flex:1 1 180px;min-width:0;">
        <div class="cliente">${escapeHtml(item.codigo)}</div>
        <div class="localidad-line" style="margin-top:2px;">${escapeHtml(item.descripcion)}</div>
      </div>
      <div class="badge" style="background:${Number(item.saldo)===0?'var(--red-dim)':'var(--panel-2)'};color:${Number(item.saldo)===0?'var(--red)':'var(--text)'};">${escapeHtml(String(item.saldo))} u.</div>
    </div>
    <div class="meta-row">
      <div class="meta-tag dist">${item.ubicacion ? escapeHtml(item.ubicacion) : 'sin ubicación'}</div>
      ${item.modelos ? `<div class="meta-tag">Modelos: ${escapeHtml(item.modelos)}</div>` : ''}
    </div>
  </div>`;
}

function renderStockList(){
  const source = STOCK_SOURCES.find(s=>s.key===state.stockSource);
  const cached = STOCK_CACHE[state.stockSource];
  const loading = !!STOCK_LOADING[state.stockSource];
  const container = document.getElementById('stockList');
  const statusEl = document.getElementById('stockStatus');

  if(!cached && !loading){
    statusEl.textContent = '';
    container.innerHTML = emptyStateHtml('Tocá para cargar el stock de "'+source.label+'" desde Google Drive.') +
      `<div style="padding:0 18px;"><button class="primary-btn" id="stockLoadNow">Cargar stock</button></div>`;
    const btn = document.getElementById('stockLoadNow');
    if(btn) btn.addEventListener('click', ()=> fetchStockSource(state.stockSource, false));
    return;
  }
  if(!cached && loading){
    statusEl.textContent = 'Cargando desde Google Drive…';
    container.innerHTML = emptyStateHtml('Cargando…');
    return;
  }
  if(cached.error && !cached.items){
    statusEl.textContent = '';
    container.innerHTML = emptyStateHtml(cached.error) +
      `<div style="padding:0 18px;"><button class="primary-btn" id="stockRetry">Reintentar</button></div>`;
    const btn = document.getElementById('stockRetry');
    if(btn) btn.addEventListener('click', ()=> fetchStockSource(state.stockSource, true));
    return;
  }

  const fecha = `Actualizado: ${new Date(cached.fetchedAt).toLocaleString('es-AR')} · ${cached.items.length} ítems`;
  if(loading) statusEl.textContent = 'Actualizando…';
  else if(cached.lastError) statusEl.textContent = `${fecha} · no se pudo actualizar ahora, mostrando lo último guardado`;
  else statusEl.textContent = fecha;

  const q = state.stockSearch.trim().toLowerCase();
  const filtered = cached.items.filter(it =>
    (!q || it.codigo.toLowerCase().includes(q) || it.descripcion.toLowerCase().includes(q)) &&
    (!state.stockOnlyZero || Number(it.saldo)===0)
  );

  if(filtered.length===0){
    container.innerHTML = emptyStateHtml(
      state.stockOnlyZero && q ? 'No hay ítems en cero para esa búsqueda.' :
      state.stockOnlyZero ? 'No hay ítems en cero en este archivo.' :
      q ? 'No hay resultados para esa búsqueda.' : 'Ese archivo no tiene ítems cargados.'
    );
    return;
  }
  // Sin ningún filtro activo evitamos pintar miles de filas de una: mostramos los primeros 150.
  const algunFiltroActivo = !!q || state.stockOnlyZero;
  const toShow = algunFiltroActivo ? filtered : filtered.slice(0,150);
  container.innerHTML = toShow.map(it=>stockItemHtml(it)).join('') +
    (!algunFiltroActivo && filtered.length>toShow.length ? `<div class="dist-sum-hint" style="padding:10px 18px;">Mostrando ${toShow.length} de ${filtered.length}. Buscá por código o descripción, o filtrá por "Solo en cero".</div>` : '');
}

// Solo pide iniciar sesión con Google cuando no hay datos guardados todavía para esa
// fuente, o cuando el usuario tocó explícitamente "Actualizar" (force=true).
function fetchStockSource(key, force){
  if(!force && STOCK_CACHE[key] && STOCK_CACHE[key].items){ renderStockList(); return; }
  if(STOCK_LOADING[key]) return; // ya hay una carga en curso para esta fuente
  STOCK_LOADING[key] = true;
  renderStockList();
  const terminar = ()=>{ STOCK_LOADING[key] = false; renderStockList(); };
  ensureGoogleAuth(async ()=>{
    try{
      const source = STOCK_SOURCES.find(s=>s.key===key);
      const term = STOCK_TERMS[key];
      const file = await driveFindFileByName(term, source.isGeneral);
      if(!file){
        const msg = `No encontré ningún archivo que contenga "${term}" en tu Drive. Revisá el nombre en "Configurar archivos".`;
        if(STOCK_CACHE[key] && STOCK_CACHE[key].items) STOCK_CACHE[key].lastError = msg;
        else STOCK_CACHE[key] = {error: msg};
        terminar();
        return;
      }
      const wb = await driveDownloadWorkbook(file);
      const wsStock = findSheetCaseInsensitive(wb, 'stock');
      if(!wsStock){
        const msg = `El archivo "${file.name}" no tiene una hoja llamada "stock".`;
        if(STOCK_CACHE[key] && STOCK_CACHE[key].items) STOCK_CACHE[key].lastError = msg;
        else STOCK_CACHE[key] = {error: msg};
        terminar();
        return;
      }
      const items = parseStockSheet(wsStock);
      // La hoja "Gavetas - nuevo" (ubicación + modelos) está en los 5 archivos, no solo en General.
      const wsGav = findSheetCaseInsensitive(wb, 'Gavetas - nuevo');
      if(wsGav){
        const ubicaciones = parseGavetasSheet(wsGav);
        items.forEach(it => {
          const info = ubicaciones[it.codigo];
          it.ubicacion = info ? info.ubicacion : '';
          it.modelos = info ? info.modelos : '';
        });
      }
      STOCK_CACHE[key] = {items, fetchedAt: Date.now(), fileName: file.name};
      saveStockCache();
      terminar();
    }catch(e){
      console.error(e);
      const msg = 'No se pudo leer el archivo desde Drive. Probá "Actualizar" de nuevo.';
      if(STOCK_CACHE[key] && STOCK_CACHE[key].items) STOCK_CACHE[key].lastError = msg;
      else STOCK_CACHE[key] = {error: msg};
      terminar();
    }
  }, terminar);
}

function openStockConfigSheet(){
  document.getElementById('stockConfigBody').innerHTML = `
    <div class="dist-sum-hint">Texto que se busca en el nombre del archivo dentro de tu Google Drive, para cada fuente.</div>
    ${STOCK_SOURCES.map(s=>`
      <div class="field-label">${s.label}</div>
      <input type="text" id="stockTerm_${s.key}" value="${escapeHtml(STOCK_TERMS[s.key]||'')}">
    `).join('')}
    <button class="primary-btn" id="stockTermsSave">Guardar</button>
  `;
  document.getElementById('stockTermsSave').addEventListener('click', ()=>{
    STOCK_SOURCES.forEach(s=>{
      STOCK_TERMS[s.key] = document.getElementById('stockTerm_'+s.key).value.trim() || DEFAULT_STOCK_TERMS[s.key];
    });
    saveStockTerms(STOCK_TERMS);
    Object.keys(STOCK_CACHE).forEach(k=> delete STOCK_CACHE[k]); // fuerza recarga con los nuevos nombres
    closeSheet('stockConfigSheet');
    renderStockList();
  });
  openSheet('stockConfigSheet');
}

// ================= Exportar a Excel =================
function exportarExcel(){
  if(typeof XLSX === 'undefined'){
    alert('No se pudo cargar la librería de Excel. Revisá que el celular tenga conexión a internet e intentá de nuevo.');
    return;
  }
  const filas = TASKS.map(t=>({
    'ID': t.id, 'Cliente': t.cliente||'', 'Localidad': t.localidad||'', 'Dirección': t.direccion||'',
    'Modelo': t.modelo||'', 'Cantidad equipos': t.cantidad,
    'Tipo de abono': t.tipo_abono,
    'Mes vencimiento': t.mes_vencimiento, 'Año vencimiento': t.anio_vencimiento,
    'Vence': MONTHS[t.mes_vencimiento-1]+' '+t.anio_vencimiento,
    'Último mantenimiento (Excel original)': t.ultimo_mantenimiento||'',
    'Pendiente': distTotal(t,'Pendiente'), 'Lista': distTotal(t,'Lista'),
    'MND': distTotal(t,'MND'), 'Asociar': distTotal(t,'Asociar'),
    'Distancia (km)': t.distancia_km ?? '', 'Observaciones': t.nota||'',
    'Fecha planificada': t.fecha_planificada||'', 'Orden plan': t.orden_plan||0,
    'Último registro': (t.registro && t.registro[0]) ? `${fmtDate(t.registro[0].fecha)} - ${t.registro[0].detalle}` : ''
  }));
  const registroRows = [];
  TASKS.forEach(t=>{
    (t.registro||[]).forEach(r=>{
      registroRows.push({'ID': t.id, 'Cliente': t.cliente||'', 'Localidad': t.localidad||'', 'Fecha': r.fecha, 'Detalle': r.detalle});
    });
  });
  const wb = XLSX.utils.book_new();
  const wsMain = XLSX.utils.json_to_sheet(filas);
  XLSX.utils.book_append_sheet(wb, wsMain, 'Mantenimientos');
  const wsReg = XLSX.utils.json_to_sheet(registroRows.length? registroRows : [{'ID':'','Cliente':'','Localidad':'','Fecha':'','Detalle':''}]);
  XLSX.utils.book_append_sheet(wb, wsReg, 'Registro de fechas');
  XLSX.writeFile(wb, `mantenimientos_${todayStr()}.xlsx`);
}

// ================= Importar datos =================
async function importarExcel(file){
  if(typeof XLSX === 'undefined'){
    alert('No se pudo cargar la librería de Excel. Revisá que el celular tenga conexión a internet e intentá de nuevo.');
    return;
  }
  try{
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    const wsMain = wb.Sheets['Mantenimientos'];
    if(!wsMain){
      alert('Ese archivo no tiene la hoja "Mantenimientos". ¿Es un archivo exportado desde esta app?');
      return;
    }
    const rows = XLSX.utils.sheet_to_json(wsMain, {defval:''});
    const wsReg = wb.Sheets['Registro de fechas'];
    const regRows = wsReg ? XLSX.utils.sheet_to_json(wsReg, {defval:''}) : [];
    const regById = {};
    regRows.forEach(r=>{
      const id = String(r['ID']||'').trim();
      if(!id || !r['Fecha']) return;
      if(!regById[id]) regById[id] = [];
      regById[id].push({fecha: String(r['Fecha']), detalle: String(r['Detalle']||'')});
    });

    let actualizadas = 0, nuevas = 0;
    rows.forEach(r=>{
      const id = String(r['ID']||'').trim();
      if(!id) return;
      const campos = {
        cliente: String(r['Cliente']||''), localidad: String(r['Localidad']||''),
        direccion: String(r['Dirección']||''), modelo: String(r['Modelo']||''),
        cantidad: parseInt(r['Cantidad equipos'],10) || 1,
        tipo_abono: String(r['Tipo de abono']||'Mensual'),
        mes_vencimiento: parseInt(r['Mes vencimiento'],10) || 9,
        anio_vencimiento: parseInt(r['Año vencimiento'],10) || new Date().getFullYear(),
        ultimo_mantenimiento: r['Último mantenimiento (Excel original)'] || null,
        distribucion: {
          Pendiente: parseInt(r['Pendiente'],10)||0, Lista: parseInt(r['Lista'],10)||0,
          MND: parseInt(r['MND'],10)||0, Asociar: parseInt(r['Asociar'],10)||0
        },
        distancia_km: r['Distancia (km)']===''? null : parseFloat(r['Distancia (km)']),
        nota: String(r['Observaciones']||''),
        fecha_planificada: r['Fecha planificada'] || null,
        orden_plan: parseInt(r['Orden plan'],10) || 0,
        registro: regById[id] || []
      };
      let t = TASKS.find(x=>x.id===id);
      if(t){
        Object.assign(t, campos);
        actualizadas++;
      } else {
        TASKS.push(Object.assign({id, historial:[]}, campos));
        nuevas++;
      }
    });

    saveTasks(TASKS);
    syncDistancias();
    processRenewals();
    renderAll();
    alert(`Importación lista: ${actualizadas} tarea(s) actualizada(s), ${nuevas} nueva(s).`);
  }catch(e){
    console.error(e);
    alert('No se pudo leer ese archivo. Asegurate de elegir un .xlsx exportado desde esta misma app.');
  }
}

// ================= Bind general =================
document.querySelectorAll('.tab-btn').forEach(btn=>{ btn.addEventListener('click', ()=> switchView(btn.dataset.view)); });
document.getElementById('searchInput').addEventListener('input', (e)=>{ state.search = e.target.value; renderAll(); });
document.getElementById('btnFilter').addEventListener('click', ()=>{ renderFilterSheet(); openSheet('filterSheet'); });
document.getElementById('filterApply').addEventListener('click', ()=>{ closeSheet('filterSheet'); renderAll(); });
document.getElementById('filterReset').addEventListener('click', ()=>{
  state.sortBy='distancia'; state.tipoFilter='Todos'; state.localidadFilter=[];
  renderFilterSheet();
});
document.getElementById('modalClose').addEventListener('click', ()=>closeSheet('taskModal'));
document.getElementById('addClose').addEventListener('click', ()=>closeSheet('addSheet'));
document.getElementById('distClose').addEventListener('click', ()=>closeSheet('distSheet'));
document.getElementById('planPickerClose').addEventListener('click', ()=>{ closeSheet('planPickerSheet'); renderPlan(); });
document.getElementById('overlay').addEventListener('click', closeAllSheets);
document.getElementById('btnSettings').addEventListener('click', openDistSheet);
document.getElementById('btnBackup').addEventListener('click', openBackupSheet);
document.getElementById('backupClose').addEventListener('click', ()=>closeSheet('backupSheet'));
document.getElementById('stockSearchInput').addEventListener('input', (e)=>{ state.stockSearch = e.target.value; renderStockList(); });
document.getElementById('btnStockRefresh').addEventListener('click', ()=> fetchStockSource(state.stockSource, true));
document.getElementById('btnStockConfig').addEventListener('click', openStockConfigSheet);
document.getElementById('stockConfigClose').addEventListener('click', ()=>closeSheet('stockConfigSheet'));
document.getElementById('importFileInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  e.target.value = '';
  if(file) importarExcel(file);
});
document.getElementById('dateSheetCancel').addEventListener('click', ()=>closeSheet('dateSheet'));
document.getElementById('fabAdd').addEventListener('click', ()=>{ if(state.view==='plan') openPlanPicker(); else openAddSheet(); });

document.getElementById('planDate').addEventListener('change', (e)=>{ state.planDate = e.target.value; renderPlan(); });
document.getElementById('planPrevDay').addEventListener('click', ()=> shiftPlanDate(-1));
document.getElementById('planNextDay').addEventListener('click', ()=> shiftPlanDate(1));
function shiftPlanDate(delta){
  const d = new Date(state.planDate+'T00:00:00');
  d.setDate(d.getDate()+delta);
  const p = n=>String(n).padStart(2,'0');
  state.planDate = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  renderPlan();
}

// ================= Init =================
async function boot(){
  const rawT = localStorage.getItem(LS_TASKS);
  const rawD = localStorage.getItem(LS_DIST);
  TASKS = rawT ? JSON.parse(rawT) : [];
  DIST = rawD ? JSON.parse(rawD) : {};

  if(!rawT || !rawD){
    const seed = await loadSeedData();
    if(seed){
      if(!rawT){ TASKS = seed.tasks.map(t=>Object.assign({registro:[]}, t)); saveTasks(TASKS); }
      if(!rawD){ DIST = seed.dist; saveDist(DIST); }
    } else if(!rawT){
      alert('No se pudo cargar datos.html. Comprobá que esté en la misma carpeta que index.html y que estés abriendo la app por http o https (por ejemplo GitHub Pages), no como archivo suelto.');
    }
  }

  normalizeTasks();
  syncDistancias();
  processRenewals();
  document.getElementById('planDate').value = state.planDate;
  renderAll();
}
boot();

// ================= PWA install support =================
(function setupPWA(){
  try{
    const manifest = {
      name: "Mantenimientos", short_name: "Mantenim.", start_url: "./", display: "standalone",
      background_color: "#14181C", theme_color: "#14181C",
      icons: [{src: document.querySelector('link[rel="apple-touch-icon"]').href, sizes: "512x512", type: "image/png"}]
    };
    const blob = new Blob([JSON.stringify(manifest)], {type:'application/manifest+json'});
    document.getElementById('manifestLink').href = URL.createObjectURL(blob);
  }catch(e){}
  // Limpieza: versiones anteriores registraban un service worker desde un blob que se
  // regeneraba en cada carga. Eso podía quedar "pegado" y servir una versión vieja de la
  // app después de actualizar. Lo desregistramos si quedó alguno dando vueltas.
  if('serviceWorker' in navigator){
    navigator.serviceWorker.getRegistrations().then(regs=>{
      regs.forEach(reg=> reg.unregister());
    }).catch(()=>{});
  }
})();

// ================= Botón "atrás" de Android: no salir de la app =================
(function trapBackButton(){
  history.pushState({app:true}, '', location.href);
  window.addEventListener('popstate', ()=>{
    const openSheetEl = document.querySelector('.sheet.show');
    if(openSheetEl){
      closeAllSheets();
    } else if(state.view !== 'meses'){
      switchView('meses');
    }
    // Si ya estamos en la pestaña principal sin nada abierto, no hacemos nada más:
    // el push de abajo evita que el navegador/Android cierre la app.
    history.pushState({app:true}, '', location.href);
  });
})();
