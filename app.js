// --- helpers ---
const B = id => document.getElementById(id);
const banner=()=>B('banner');
const normCap = c => String(c||'').trim().toUpperCase();
const trailing = s => String(s||'').match(/(\d{3})$/)?.[1]||null;

let MAP, MARKER, CURRENT_ESZ=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map(), REMOVED_CAPS=new Map();
let HILITE=null; // geojson layer for selected ESZ outline

// ESZ FeatureServer (Fire ESZ)
const ESZ_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0';
// County address locator (Frederick County addresses only)
const GEOCODE_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Geoprocessors/FrederickCountyAddressesPublic/GeocodeServer';
const MIN_GEOCODE_SCORE = 90;

function mutualAidEnabled(){ return B('mutualAid').checked; }
function isAvailable(u){ return (STATUS.get(u) || DATA?.UNIT_STATUS?.[u] || 'AQ') === 'AQ'; }
function effectiveCaps(u){
  const base= new Set((DATA?.UNIT_CAPS?.[u]||[]).map(normCap));
  if(USER_CAPS.has(u)) for(const c of USER_CAPS.get(u)) base.add(normCap(c));
  if(REMOVED_CAPS.has(u)) for(const c of REMOVED_CAPS.get(u)) base.delete(normCap(c));
  return [...base];
}
function isStationAllowed(st){
  if(mutualAidEnabled()) return true;
  const d=trailing(st); return d?d[0]==='9':false;
}
function stationUnits(st){
  const s = String(st || '').toUpperCase();
  const d = trailing(s);
  // gather possible keys: exact, bare 3-digit, and prefixed variants
  const keys = new Set([s]);
  if (d) {
    keys.add(d);
    keys.add(`LCF/${d}`);
    keys.add(`MCF/${d}`);
  }
  const src = DATA?.STATION_UNITS || {};
  const out = [];
  for (const k of keys) {
    const arr = Array.isArray(src[k]) ? src[k] : [];
    for (const u of arr) if (!out.includes(u)) out.push(u);
  }
  return out;
}

const ORDER_PREVIEW = 8; // stations shown before "+N more"
const ESZ_MIN_ZOOM = 13;  // ESZ outlines appear at this zoom and closer

function setESZ(key){
  // clear current recommendation on ESZ change
  clearRecommendation();
  CURRENT_ESZ = key;
  B('esz').textContent = key || '—';
  updateRecButton();
  ORDER_EXPANDED = false;
  renderStationOrder();
  if(HILITE) HILITE.setStyle({color:'#3b82f6', weight:4, fillOpacity:0.1});
}

let ORDER_EXPANDED = false;
function renderStationOrder(){
  const box=B('stationOrder'), more=B('btnOrderMore');
  box.innerHTML='';
  more.hidden=true;
  if(!CURRENT_ESZ){ box.textContent='Click the map or search an address.'; return; }
  const order = (DATA?.ESZ_ORDER?.[CURRENT_ESZ]) || DATA?.GLOBAL_ORDER || [];
  if(!order.length){ box.textContent='Station order: (none)'; return; }
  const shown = ORDER_EXPANDED ? order : order.slice(0, ORDER_PREVIEW);
  const chips=document.createElement('div'); chips.className='chips';
  shown.forEach((st,i)=>{ const c=document.createElement('span'); c.className='chip'; c.textContent=`${i+1}. ${st}`; chips.appendChild(c); });
  box.appendChild(chips);
  if(order.length > ORDER_PREVIEW){
    more.hidden=false;
    more.textContent = ORDER_EXPANDED ? 'Show less' : `+${order.length-ORDER_PREVIEW} more`;
  }
}

// Collapse/expand the sidebar (not persisted; resets to open on reload)
function setSidebar(open){
  B('app').classList.toggle('side-collapsed', !open);
  B('side').inert = !open;
  B('btnCloseSide').setAttribute('aria-expanded', String(open));
  setTimeout(()=>MAP?.invalidateSize(), 250); // backstop for the ResizeObserver, after the .2s transition
  (open ? B('btnCloseSide') : B('btnOpenSide'))?.focus();
}

// "Get recommendation" needs both a location and an incident type
function updateRecButton(){
  const hasInc = !!B('incident').value;
  B('btnRec').disabled = !(CURRENT_ESZ && hasInc);
  const need = [!CURRENT_ESZ && 'a location', !hasInc && 'an incident type'].filter(Boolean);
  B('recHint').textContent = need.length ? `Set ${need.join(' and ')} first.` : '';
}

// --- Incident type combobox ---
// Typing filters the list (prefix matches first, then contains). Enter/click picks; Esc closes.
// The chosen code lives in the hidden #incident input, which runRecommend reads.
function initIncidentCombo(codes){
  const input=B('incidentInput'), list=B('incidentList'), hidden=B('incident');
  let matches=[], active=-1, committed=''; // committed = last valid pick, restored on Esc/blur

  const open = ()=>{ list.hidden=false; input.setAttribute('aria-expanded','true'); };
  const close = ()=>{ list.hidden=true; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); active=-1; };

  function render(){
    const q=input.value.trim().toUpperCase();
    matches = !q ? codes : [
      ...codes.filter(c=>c.startsWith(q)),
      ...codes.filter(c=>!c.startsWith(q) && c.includes(q)),
    ];
    list.innerHTML='';
    if(!matches.length){
      const li=document.createElement('li'); li.className='combo-empty'; li.textContent='No matching incident type';
      list.appendChild(li);
    }
    matches.forEach((c,i)=>{
      const li=document.createElement('li');
      li.id='inc-opt-'+i; li.setAttribute('role','option'); li.className='combo-opt';
      li.setAttribute('aria-selected', String(c===hidden.value));
      // Bold the matched part
      const at = q ? c.indexOf(q) : -1;
      if(at>=0){ li.append(c.slice(0,at)); const m=document.createElement('mark'); m.textContent=c.slice(at,at+q.length); li.append(m, c.slice(at+q.length)); }
      else li.textContent=c;
      li.onmousedown=e=>{ e.preventDefault(); choose(c); };
      list.appendChild(li);
    });
    setActive(matches.length && q ? 0 : -1);
  }
  function setActive(i){
    list.querySelector('.active')?.classList.remove('active');
    active=i;
    if(i<0){ input.removeAttribute('aria-activedescendant'); return; }
    const li=B('inc-opt-'+i); li.classList.add('active'); li.scrollIntoView({block:'nearest'});
    input.setAttribute('aria-activedescendant', li.id);
  }
  function choose(code){
    const changed = code!==hidden.value;
    hidden.value=code; input.value=code; committed=code; close();
    if(changed) clearRecommendation();
    updateRecButton();
  }
  // Leaving the box: keep an exact match, otherwise restore the last valid choice
  function revert(){ if(committed) choose(committed); else { input.value=''; close(); } }
  function commitOrRevert(){
    const typed=input.value.trim().toUpperCase();
    if(codes.includes(typed)) choose(typed); else revert();
  }

  input.addEventListener('input', ()=>{
    if(hidden.value && input.value.trim().toUpperCase()!==hidden.value){ hidden.value=''; clearRecommendation(); updateRecButton(); }
    render(); open();
  });
  // Open the full list (not filtered by the current choice) from a click or the chevron
  function showAll(){ const q=input.value; input.value=''; render(); input.value=q; open(); }
  input.addEventListener('focus', ()=>{ input.select(); });
  input.addEventListener('click', ()=>{ if(list.hidden) showAll(); });
  input.addEventListener('blur', commitOrRevert);
  input.addEventListener('keydown', e=>{
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      if(list.hidden){ render(); open(); }
      const n=matches.length; if(!n) return;
      setActive(e.key==='ArrowDown' ? (active+1)%n : (active<=0 ? n-1 : active-1));
    }else if(e.key==='Enter'){
      if(!list.hidden && active>=0){ e.preventDefault(); choose(matches[active]); }
      else if(!list.hidden && matches.length===1){ e.preventDefault(); choose(matches[0]); }
    }else if(e.key==='Escape'){
      if(!list.hidden){ e.preventDefault(); revert(); }
    }
  });
  B('incidentToggle').onmousedown=e=>{
    e.preventDefault();
    if(list.hidden){ input.focus(); showAll(); }
    else close();
  };
}

// Light/dark toggle (not persisted; initial theme comes from the OS preference in index.html)
function toggleTheme(){
  const root=document.documentElement;
  root.dataset.theme = root.dataset.theme==='light' ? 'dark' : 'light';
  syncThemeButton();
}
function syncThemeButton(){
  const next = document.documentElement.dataset.theme==='light' ? 'dark' : 'light';
  const label = `Switch to ${next} mode`;
  B('btnTheme').title=label; B('btnTheme').setAttribute('aria-label', label);
}

function clearRecommendation(){
  B('rec').innerHTML='';
  B('dbg').textContent='';
  B('recCard').hidden=true;
}

// Color dot for each recommended unit, keyed by the capability it fills. Unlisted caps show as "other".
const CAP_KIND = {
  fire:    ['E','EK','DD','Q','T','TW','AERIAL','ELEV','FS','CAFS','CO','MP','SS','TR','FOB'],
  water:   ['K','K3000','DDK','TANK','FK'],
  ems:     ['A','ALS','ALSAMB','BLS','EMS','BUS','MCSU','UTVEMS'],
  command: ['BC','SAF'],
};
const KIND_OF = new Map(Object.entries(CAP_KIND).flatMap(([k,caps])=>caps.map(c=>[c,k])));
const capKind = cap => KIND_OF.get(normCap(cap)) || 'other';

function unitPill(it){
  const s=document.createElement('span');
  if(it.unit==='NEEDED'){ s.className='pill needed'; s.textContent='NEEDED'; return s; }
  s.className='pill blue'; s.dataset.unit=it.unit; s.dataset.kind=capKind(it.cap);
  const name=document.createElement('b'); name.textContent=it.unit; s.appendChild(name);
  const st=trailing(it.st)||it.st;
  if(st){ const sub=document.createElement('span'); sub.className='pill-sub'; sub.textContent='· Sta '+st; s.appendChild(sub); }
  return s;
}
function row(cap, items){ const d=document.createElement('div'); d.className='row'; const l=document.createElement('label'); l.className='cap'; l.textContent=cap; d.appendChild(l); const box=document.createElement('div'); box.className='box'; items.forEach(it=>box.appendChild(unitPill(it))); d.appendChild(box); return d; }

// SU preference only for BLS at stations 909, 921, 913
const SU_PREF = new Set(['909','921','913']);

function buildCandidatesByOrder(order, caps, used){
  const want = (caps||[]).map(normCap);
  const out=[];
  order.forEach((st, idx)=>{
    if(!isStationAllowed(st)) return;
    let units = stationUnits(st);
    // Prefer SU for BLS in specific stations
    const onlyBLS = want.length===1 && want[0]==='BLS';
    const d = trailing(st);
    if(onlyBLS && SU_PREF.has(d||st)){
      const su = units.filter(u=>/^SU\d+$/i.test(u));
      const rest = units.filter(u=>!/^SU\d+$/i.test(u));
      units = su.concat(rest);
    }
    for(const u of units){
      if(used.has(u)) continue;
      if(!isAvailable(u)) continue;
      const capsOfU = effectiveCaps(u);
      for(const r of want){
        if(capsOfU.includes(r)){
          out.push({unit:u, cap:r, rank:idx, st:st});
          break;
        }
      }
    }
  });
  return out;
}

function pickForCap(cap, order, used){
  const arr = buildCandidatesByOrder(order, [cap], used);
  return arr.length ? arr[0] : null;
}


function maybeAddDD(out, order, used){
  // If plan needs E and a DD is earlier than the first chosen E, add the DD and then back-fill another E.
  const firstEIndex = out.findIndex(x=>x.cap==='E');
  if(firstEIndex<0) return;
  const firstE = out[firstEIndex];
  const adds = buildCandidatesByOrder(order, ['DD'], used).filter(x=>x.rank < firstE.rank);
  for(const d of adds){
    if(!out.some(x=>x.unit===d.unit)){
      out.push(d); used.add(d.unit);
    }
    const next = pickForCap('E', order, used);
    if(next){ out.push(next); used.add(next.unit); }
  }
}
function maybeAddDDK(out, order, used){
  const ix = out.findIndex(x=>x.cap==='K');
  if(ix<0) return;
  const first = out[ix];
  const adds = buildCandidatesByOrder(order, ['DDK'], used).filter(x=>x.rank<first.rank);
  for(const d of adds){
    if(!out.some(x=>x.unit===d.unit)){ out.push(d); used.add(d.unit); }
    const next = pickForCap('K', order, used);
    if(next){ out.push(next); used.add(next.unit); }
  }
}

// HM33 rule (skip for ESZ "50xx" unless need >1 HM)
function enforceHM33(out, eszKey, used){
  const needHM = out.some(x=>x.cap==='HM');
  if(!needHM) return;
  if(String(eszKey||'').startsWith('50')) return;
  if(DATA?.UNIT_CAPS?.HM33 && isAvailable('HM33') && effectiveCaps('HM33').includes('HM')){
    if(!out.some(x=>x.unit==='HM33')){
      out.push({unit:'HM33', cap:'HM', rank:-1, st:'FIRE/033'});
      used.add('HM33');
    }
  }
}

// 911/924 and 910/930 BLS suppression

function suppressBLSPairing(out, plan){
  // Apply only when BLS is being added via If Closer (not when it is required in plan groups)
  const ifCloserCaps = new Set((plan?.ifCloser || []).map(normCap));
  if (!ifCloserCaps.has('BLS')) return out;

  // Stations of any selected A units (use trailing 3-digit station id when available)
  const aStations = new Set(
    out.filter(x => x.cap === 'A').map(x => (trailing(x.st) || String(x.st)))
  );

  // Suppression mapping:
  // - If A from 924 is selected, suppress BLS from 911
  // - If A from 930 is selected, suppress BLS from 910
  const suppressStations = new Set();
  if (aStations.has('924')) suppressStations.add('911');
  if (aStations.has('930')) suppressStations.add('910');

  if (!suppressStations.size) return out;

  return out.filter(x => !(x.cap === 'BLS' && suppressStations.has(trailing(x.st) || String(x.st))));
}

function runRecommend(){
  const inc=B('incident').value;
  const basePlan = DATA?.PLAN_STRUCT?.[inc];
  if(!basePlan){ banner().className='warn'; banner().textContent='No plan structure for '+inc; return; }

  // Determine effective plan (non-hydrant overrides REPLACE base)
  const nhSet = new Set((DATA?.NON_HYDRANT_ESZ||[]).map(v=>String(v).padStart(4,'0')));
  const isNH = nhSet.has(String(CURRENT_ESZ).padStart(4,'0'));
  const nhPlan = DATA?.PLAN_NH_OVERRIDES?.[inc];
  const plan = (isNH && nhPlan) ? nhPlan : basePlan;

  const order = (DATA?.ESZ_ORDER?.[CURRENT_ESZ]) || DATA?.GLOBAL_ORDER || [];
  const used=new Set();
  const selected=[];

  // Required groups
  for(const grp of (plan.groups||[])){
    const qty = Math.max(1, Number(grp.qty||1));
    const wantCaps = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    const cands = buildCandidatesByOrder(order, wantCaps, used);
    let have = 0;
    for(const c of cands){
      if(selected.some(x=>x.unit===c.unit)) continue;
      selected.push(c); used.add(c.unit);
      if(wantCaps.includes(c.cap)) have++;
      if(have >= qty) break;
    }
  }

  // ifCloser: add only if the candidate's station rank is earlier than the earliest already-selected unit
  const minRank = selected.length ? Math.min(...selected.map(x=>x.rank)) : Infinity;
  for(const cap of (plan.ifCloser||[])){
    const p = pickForCap(cap, order, used);
    if(p && p.rank < minRank){ selected.push(p); used.add(p.unit); }
  }

  // Special rules run only if plan actually asks for those caps

function fulfillsCap(itemCap, wantCaps){
  const C = normCap(itemCap);
  const want = new Set((wantCaps||[]).map(normCap));
  if(want.has(C)) return true;
  // Allow earlier-substitution equivalents to count toward the group
  if(C==='DD' && want.has('E')) return true;
  if(C==='DDK' && want.has('K')) return true;
  return false;
}
function requiredQty(plan, cap){
  let total = 0;
  for(const grp of (plan.groups||[])){
    const qty = Math.max(1, Number(grp.qty||1));
    const want = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    if(want.includes(normCap(cap))) total += qty;
  }
  return total;
}

// Replace E/K with earlier DD/DDK without exceeding required counts
function applyEarlierSubFor(selected, order, used, plan, cap, subCap){
  const required = requiredQty(plan, cap);
  if(required<=0) return;

  const chosenE = selected.filter(x=>x.cap===cap);
  const earliestE = chosenE.length ? Math.min(...chosenE.map(x=>x.rank)) : Infinity;
  // Only consider subs earlier than the earliest chosen E/K
  const subCands = buildCandidatesByOrder(order, [subCap], used).filter(x=>x.rank < earliestE);

  // Pool = current picks (cap or subCap) + eligible subs
  const pool = selected.filter(x=>x.cap===cap || x.cap===subCap).concat(subCands);
  // Sort pool by station rank ascending
  pool.sort((a,b)=>a.rank - b.rank);

  // Keep only the earliest 'required' items
  const keep = pool.slice(0, required);
  const keepUnits = new Set(keep.map(x=>x.unit));

  // Remove any extra cap/subCap picks beyond required
  for(let i=selected.length-1;i>=0;i--){
    const it = selected[i];
    if((it.cap===cap || it.cap===subCap) && !keepUnits.has(it.unit)){
      used.delete(it.unit);
      selected.splice(i,1);
    }
  }
  // Ensure kept subs are present
  for(const it of keep){
    if(!selected.some(x=>x.unit===it.unit)){
      selected.push(it);
      used.add(it.unit);
    }
  }
}

  const planCaps = new Set();
  for(const grp of (plan.groups||[])){
    const wantCaps = Array.isArray(grp.caps) ? grp.caps : [grp.caps];
    for(const c of wantCaps) planCaps.add(normCap(c));
  }
  if(planCaps.has('E')) addAllEarlierSubsExtra(selected, order, used, plan, 'E', 'DD');
  if(planCaps.has('K')) addAllEarlierSubsExtra(selected, order, used, plan, 'K', 'DDK');
  




function addAllEarlierSubsExtra(selected, order, used, plan, primaryCap, subCap){
  // Only if plan actually requires the primary capability
  let req = 0;
  for (const grp of (plan.groups || [])) {
    const qty = Math.max(1, Number(grp.qty || 1));
    const want = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
    if (want.includes(normCap(primaryCap))) req += qty;
  }
  if (req <= 0) return;

  const chosenPrim = selected.filter(x => x.cap === primaryCap);
  if (!chosenPrim.length) return;

  // Option B: a sub qualifies if it's earlier than ANY of the chosen primaries
  // => use the LATEST selected primary as the cutoff.
  const latestPrimRank = Math.max(...chosenPrim.map(x => x.rank));

  // Add all subCap candidates strictly earlier than the latest primary, in rank order
  const subs = buildCandidatesByOrder(order, [subCap], used).filter(x => x.rank < latestPrimRank)
                .sort((a,b)=>a.rank - b.rank);

  for(const s of subs){
    if(!selected.some(x=>x.unit===s.unit)){
      selected.push(s);
      used.add(s.unit);
    }
  }
}





  enforceHM33(selected, CURRENT_ESZ, used);

  // Station-pair suppression
  let filtered = suppressBLSPairing(selected, plan);

  // Sort by plan cap order then station rank
  const planCapOrder = [];
  for(const grp of (plan.groups||[])){
    const wantCaps = Array.isArray(grp.caps) ? grp.caps : [grp.caps];
    for(const c of wantCaps){ const C=normCap(c); if(!planCapOrder.includes(C)) planCapOrder.push(C); }
  }
  const idxOf = cap => { const C=normCap(cap); const i=planCapOrder.indexOf(C); return i<0 ? 999 : i; };
  filtered = filtered.sort((a,b)=>{
    const ai = idxOf(a.cap), bi = idxOf(b.cap);
    if(ai!==bi) return ai-bi;
    return a.rank - b.rank;
  });

  
  // Add placeholders for any unfilled capabilities (show as 'NEEDED')
  try{
    for(const grp of (plan.groups||[])){
      const qty = Math.max(1, Number(grp.qty||1));
      const wantCaps = Array.isArray(grp.caps) ? grp.caps.map(normCap) : [normCap(grp.caps)];
      let have = 0;
      for(const it of filtered){
        if(fulfillsCap(it.cap, wantCaps)) have++;
      }
      const missing = Math.max(0, qty - have);
      if(missing > 0){
        const label = (Array.isArray(grp.caps) ? grp.caps.map(normCap).join('/') : normCap(grp.caps));
        for(let i=0;i<missing;i++){
          filtered.push({unit:'NEEDED', cap:label, rank:99999});
        }
      }
    }
  }catch(e){ /* non-fatal */ }
renderRecommendation(filtered);
}
function renderRecommendation(arr){
  const box=B('rec'); box.innerHTML='';
  const dbg=B('dbg'); dbg.textContent='';
  const by=new Map();
  for(const it of arr){
    const g=by.get(it.cap)||[]; g.push(it); by.set(it.cap,g);
  }
  for(const [cap,list] of by){
    box.appendChild(row(cap,list));
  }
  dbg.textContent = JSON.stringify(arr,null,2);
  B('recCard').hidden=false;
  B('recCard').scrollIntoView({block:'nearest', behavior:'smooth'});
}

function sendDispatch(){
  // NEEDED placeholders carry no data-unit, so they are never dispatched
  const units = [...document.querySelectorAll('#rec .pill[data-unit]')].map(p=>p.dataset.unit);
  if(!units.length){ banner().className='warn'; banner().textContent='No units selected'; return; }
  if(!confirm(`Dispatch ${units.length} unit(s) and mark them CALL?\n\n${units.join(', ')}`)) return;
  for(const u of units){ STATUS.set(u,'CALL'); }
  clearRecommendation();
  const b=banner(); if(b){ b.className='ok'; b.textContent='Dispatch sent: '+units.join(', '); }
}

function openStatus(){
  const modal=B('statusModal'); const grid=B('statusGrid'); grid.innerHTML='';
  const by=new Map();
  for(const [k,arr] of Object.entries(DATA.STATION_UNITS||{})){
    const d=trailing(k)||k; const g=by.get(d)||[];
    for(const u of arr){ if(!g.includes(u)) g.push(u); }
    by.set(d,g);
  }
  // Controls
  const controls=document.createElement('div'); controls.className='row';
  const expAll=document.createElement('button'); expAll.className='secondary'; expAll.textContent='Expand all';
  const colAll=document.createElement('button'); colAll.className='secondary'; colAll.textContent='Collapse all';
  controls.appendChild(expAll); controls.appendChild(colAll); grid.appendChild(controls);

  expAll.onclick=()=>{ for(const d of grid.querySelectorAll('details')) d.open=true; };
  colAll.onclick=()=>{ for(const d of grid.querySelectorAll('details')) d.open=false; };

  const stations=[...by.keys()].sort((a,b)=>(a+b).localeCompare(b+a,undefined,{numeric:true}));
  for(const st of stations){
    const wrap=document.createElement('details'); wrap.open=false; wrap.className='station';
    const sum=document.createElement('summary'); sum.textContent='Station '+st; wrap.appendChild(sum);
    const box=document.createElement('div'); box.className='station-body'; wrap.appendChild(box);
    grid.appendChild(wrap);
    for(const u of (by.get(st)||[])){
      const badge=document.createElement('span'); badge.className='badge';
      const name=document.createElement('b'); name.textContent=u; badge.appendChild(name);

      const sel=document.createElement('select'); ['AQ','PA','CA','CALL','OOS'].forEach(v=>{ const o=document.createElement('option'); o.value=v;o.text=v; sel.appendChild(o); });
      sel.value = STATUS.get(u)||DATA?.UNIT_STATUS?.[u]||'AQ';
      sel.onchange=()=>STATUS.set(u,sel.value);
      badge.appendChild(sel);

      const capIn=document.createElement('input'); capIn.placeholder='add cap'; capIn.size=6;
      const add=document.createElement('button'); add.className='secondary'; add.textContent='Add';
      add.onclick=()=>{ const v=normCap(capIn.value); if(v){ const s=USER_CAPS.get(u)||new Set(); s.add(v); USER_CAPS.set(u,s); capIn.value=''; renderStatusCaps(); } };
      badge.appendChild(capIn); badge.appendChild(add);

      box.appendChild(badge);
    }
  }
  renderStatusCaps();
  modal.setAttribute('aria-hidden','false');
}

function renderStatusCaps(){
  const grid=B('statusGrid');
  for(const badge of grid.querySelectorAll('.badge')){
    const u = badge.querySelector('b').textContent;
    let caps = effectiveCaps(u).sort();
    // Build pill row with remove buttons
    let wrap = badge.querySelector('.capwrap');
    if(!wrap){
      wrap=document.createElement('span');
      wrap.className='small capwrap';
      wrap.style.marginLeft='6px';
      badge.appendChild(wrap);
    }
    wrap.innerHTML='';
    for(const c of caps){
      const pill=document.createElement('span'); 
      pill.className='pill';
      const label=document.createElement('span'); 
      label.textContent=c; 
      pill.appendChild(label);
      const x=document.createElement('button'); 
      x.type='button'; 
      x.className='pillx'; 
      x.textContent='×';
      x.title='Remove capability';
      x.onclick=()=>{
        // Prefer removing from ad-hoc set if present; otherwise mark as removed from base
        const addSet = USER_CAPS.get(u);
        if(addSet && addSet.has(c)){
          addSet.delete(c);
          if(addSet.size===0) USER_CAPS.delete(u);
        }else{
          const rem = REMOVED_CAPS.get(u) || new Set();
          rem.add(c);
          REMOVED_CAPS.set(u, rem);
        }
        renderStatusCaps();
      };
      pill.appendChild(x);
      wrap.appendChild(pill);
    }
  }
}

function resetCaps(){
  USER_CAPS.clear();
  REMOVED_CAPS.clear();
  if(B('statusModal').getAttribute('aria-hidden')==='false') renderStatusCaps();
  banner().className='ok'; banner().textContent='Ad-hoc caps reset';
}

// --- ESZ selection from point (click/locate) ---
async function setESZFromPoint(lat, lon){
  try{
    const g = {"x":lon,"y":lat,"spatialReference":{"wkid":4326}};
    const params = new URLSearchParams();
    params.set('f','geojson');
    params.set('geometry', JSON.stringify(g));
    params.set('geometryType','esriGeometryPoint');
    params.set('inSR','4326');
    params.set('spatialRel','esriSpatialRelIntersects');
    params.set('outFields','ESZ,STATION,STA_NAME,EMS');
    params.set('returnGeometry','true');

    const url = ESZ_URL + '/query?' + params.toString();
    const r = await fetch(url);
    const js = await r.json();

    if(!js.features || !js.features.length){
      setESZ(null);
      if(HILITE){ MAP.removeLayer(HILITE); HILITE=null; }
      return;
    }

    const feat = js.features[0];
    const eszNum = feat.properties.ESZ;
    const eszKey = String(eszNum).padStart(4,'0');
    setESZ(eszKey);

    if(HILITE){ MAP.removeLayer(HILITE); HILITE=null; }
    HILITE = L.geoJSON(feat, {style:{color:'#3b82f6',weight:4,fillOpacity:0.1}}).addTo(MAP);
  }catch(err){
    console.error(err);
    banner().className='warn'; banner().textContent='ESZ lookup failed';
  }
}

// --- boot ---
async function boot(){
  // Load embedded DATA
  if(!window.DATA){ banner().className='warn'; banner().textContent='DATA missing'; return; }
  window.DATA = window.DATA || {};
  window.DATA.UNIT_STATUS = window.DATA.UNIT_STATUS || {};
  window.DATA.UNIT_CAPS   = window.DATA.UNIT_CAPS   || {};
  window.DATA.STATION_UNITS = window.DATA.STATION_UNITS || {};

  // Initialize status maps
  for(const u of Object.keys(DATA.UNIT_CAPS||{})){
    STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ');
    DEFAULT_STATUS.set(u, DATA?.UNIT_STATUS?.[u]||'AQ');
  }

  // Map
  try{
    MAP=L.map('map',{zoomControl:false}).setView([39.414,-77.410],11);
    // Reopen-sidebar button sits above the zoom control (only visible while collapsed)
    const SideToggle = L.Control.extend({
      onAdd(){
        const b=L.DomUtil.create('button','map-open-side');
        b.id='btnOpenSide'; b.type='button'; b.title='Show panel'; b.setAttribute('aria-label','Show panel');
        b.innerHTML='<span aria-hidden="true">»</span> Panel';
        L.DomEvent.disableClickPropagation(b);
        b.onclick=()=>setSidebar(true);
        return b;
      }
    });
    new SideToggle({position:'topleft'}).addTo(MAP);
    L.control.zoom({position:'topleft'}).addTo(MAP);
    // Frederick County basemap only (no third-party tile fallback)
    const basemap = L.esri.tiledMapLayer({
      // Web Mercator cache; Tiled/BaseMap is State Plane and won't render in Leaflet
      url:'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Tiled/BaseMap_Tiled_WGS84/MapServer'
    }).addTo(MAP);
    // Warn only when no tile in the current view loads (edge tiles can 404 normally)
    let tilesOk=0;
    basemap.on('loading', ()=>{ tilesOk=0; });
    basemap.on('tileload', ()=>{ tilesOk++; });
    basemap.on('load', ()=>{
      if(!tilesOk){ banner().className='warn'; banner().textContent='County basemap tiles failed to load'; }
    });

    // ESZ boundaries and labels, drawn by the county server (non-interactive so map clicks pass through).
    // Hidden when zoomed out, where 639 zones become an unreadable mesh.
    const eszLayer = L.esri.dynamicMapLayer({
      url: ESZ_URL.replace(/\/0$/, ''),
      layers:[0], opacity:0.5, interactive:false
    });
    const syncEszLayer = ()=>{
      if(MAP.getZoom() >= ESZ_MIN_ZOOM) eszLayer.addTo(MAP); else eszLayer.remove();
    };
    MAP.on('zoomend', syncEszLayer);
    syncEszLayer();

    // Click to set point + ESZ
    MAP.on('click', async (e)=>{
      if(MARKER) MARKER.remove();
      MARKER=L.marker(e.latlng).addTo(MAP);
      await setESZFromPoint(e.latlng.lat, e.latlng.lng);
    });
  }catch(err){ console.warn('Map init failed',err); }

  // Incident type: type-to-search combobox, nothing selected by default
  initIncidentCombo(Object.keys(DATA.PLAN_STRUCT||{}).sort());

  // No ESZ until the user clicks the map or searches an address
  setESZ(null);
  B('btnOrderMore').onclick=()=>{ ORDER_EXPANDED=!ORDER_EXPANDED; renderStationOrder(); };
  B('btnCloseSide').onclick=()=>setSidebar(false);
  B('btnTheme').onclick=toggleTheme;
  syncThemeButton();
  // Leaflet must re-measure whenever the map box changes size (sidebar collapse, window resize)
  new ResizeObserver(()=>MAP?.invalidateSize()).observe(B('map'));

  // Buttons
  B('btnRec').onclick=()=>{ if(!CURRENT_ESZ || !B('incident').value) return; try{ runRecommend(); banner().className='ok'; banner().textContent='Ready'; }catch(err){ banner().className='warn'; banner().textContent='Recommendation failed: '+(err.message||err); } };
  B('btnDispatch').onclick=sendDispatch;
  B('btnStatus').onclick=openStatus;
  B('closeStatus').onclick=()=>B('statusModal').setAttribute('aria-hidden','true');
  B('resetCaps').onclick=resetCaps;

  // Address search via the county geocoder only (street addresses; no intersections)
  B('btnLocate').onclick=locateAddress;
  B('q').addEventListener('keydown', e=>{ if(e.key==='Enter') locateAddress(); });
}

async function locateAddress(){
  const q=B('q').value.trim();
  if(!q) return;
  try{
    const params = new URLSearchParams();
    params.set('f','json');
    params.set('SingleLine', q);
    params.set('outSR','4326');
    params.set('maxLocations','1');
    const r = await fetch(GEOCODE_URL + '/findAddressCandidates?' + params.toString());
    const js = await r.json();
    const c = js.candidates?.[0];
    if(!c || c.score < MIN_GEOCODE_SCORE) throw new Error('no confident match');
    const {x:lon, y:lat} = c.location;
    if(MARKER) MARKER.remove();
    MARKER = L.marker([lat, lon]).addTo(MAP);
    MAP.setView([lat, lon], 16);
    banner().className='ok'; banner().textContent='Located: '+c.address;
    await setESZFromPoint(lat, lon); // may replace banner with an ESZ lookup warning
  }catch(err){
    banner().className='warn'; banner().textContent='Locate failed: '+(err.message||err);
  }
}

window.addEventListener('error',e=>{ if(banner()){banner().className='warn'; banner().textContent='JS error: '+(e.message||e);}});
window.addEventListener('unhandledrejection',e=>{ if(banner()){banner().className='warn'; banner().textContent='Promise error: '+(e.reason?.message||e.reason||e);}});

window.addEventListener('DOMContentLoaded', boot);
