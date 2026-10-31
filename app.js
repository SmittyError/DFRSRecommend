// --- helpers ---
const B = id => document.getElementById(id);
const banner=()=>B('banner');
const normCap = c => String(c||'').trim().toUpperCase();
const trailing = s => String(s||'').match(/(\d{3})$/)?.[1]||null;

let MAP, MARKER, CURRENT_ESZ=null;
let CURRENT_ADDR=null, ADDR_REQ=0; // label for the current location; ADDR_REQ drops stale reverse lookups
let INCIDENT_COMBO=null;
const STATUS=new Map(), DEFAULT_STATUS=new Map(), USER_CAPS=new Map(), REMOVED_CAPS=new Map();
let HILITE=null; // geojson layer for selected ESZ outline

// ESZ FeatureServer (Fire ESZ)
const ESZ_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/PublicSafety/EmergencyESZ/MapServer/0';
// County address locator (Frederick County addresses only)
const GEOCODE_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Geoprocessors/FrederickCountyAddressesPublic/GeocodeServer';
const MIN_GEOCODE_SCORE = 90;
// County street centerlines; the locators can't do intersections, so we find where two streets meet
const CENTERLINE_URL = 'https://fcgis.frederickcountymd.gov/server_pub/rest/services/Basemap/Centerline_StreetSearch/MapServer/0';

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
  return { reset(){ hidden.value=''; input.value=''; committed=''; close(); updateRecButton(); } };
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
  const units = [...document.querySelectorAll('#rec .pill[data-unit]')].map(p=>({unit:p.dataset.unit, kind:p.dataset.kind}));
  if(!units.length){ banner().className='warn'; banner().textContent='No units selected'; return; }
  if(!MARKER){ banner().className='warn'; banner().textContent='Set a location before dispatching'; return; }
  const names = units.map(u=>u.unit);
  if(!confirm(`Dispatch ${names.length} unit(s) and mark them CALL?\n\n${names.join(', ')}`)) return;
  for(const u of names){ STATUS.set(u,'CALL'); }
  const {lat, lng} = MARKER.getLatLng();
  const inc = createIncident({type:B('incident').value, esz:CURRENT_ESZ, address:CURRENT_ADDR, lat, lon:lng, units});
  resetDispatchForm();
  banner().className='ok'; banner().textContent=`Incident #${inc.id} dispatched: ${names.join(', ')}`;
}

// Ready the Dispatch tab for the next call: the incident now has its own pin
function resetDispatchForm(){
  clearRecommendation();
  clearAddressChoices();
  if(MARKER){ MARKER.remove(); MARKER=null; }
  if(HILITE){ HILITE.remove(); HILITE=null; }
  CURRENT_ADDR=null; ADDR_REQ++;
  B('q').value='';
  INCIDENT_COMBO?.reset();
  setESZ(null);
}

// Landing screen: fade out, then unlock the app behind it
function dismissSplash(){
  const splash=B('splash');
  B('app').inert=false;
  splash.classList.add('leaving');
  setTimeout(()=>splash.remove(), 500);
  MAP?.invalidateSize();
  B('q').focus();
}

// --- Active incidents (in memory only; cleared on reload per the no-persistence rule) ---
// Numbered per session; no timestamps are recorded.
const INCIDENTS = new Map(); // id -> {id, type, esz, address, lat, lon, units:[{unit,kind}], pin}
let INC_SEQ = 0;

function createIncident({type, esz, address, lat, lon, units}){
  const inc = {id:++INC_SEQ, type, esz, address, lat, lon, units:[...units]};
  inc.pin = L.marker([lat, lon], {
    // Tip of the rotated 30px teardrop sits ~21px below its center
    icon: L.divIcon({className:'inc-pin', html:`<span><i>${inc.id}</i></span>`, iconSize:[30,30], iconAnchor:[15,36], popupAnchor:[0,-34]}),
    title: `Incident #${inc.id} ${type}`, zIndexOffset:500,
  }).bindPopup(()=>incidentPopup(inc), {className:'inc-popup', minWidth:220}).addTo(MAP);
  INCIDENTS.set(inc.id, inc);
  renderIncidents();
  return inc;
}

function incidentLocation(inc){
  return inc.address || (inc.esz ? `Map point in ESZ ${inc.esz}` : 'Map point');
}

// Return a unit to service so it can be recommended again
function clearUnit(inc, unit){
  STATUS.set(unit, 'AQ');
  inc.units = inc.units.filter(u=>u.unit!==unit);
  if(!inc.units.length){ removeIncident(inc); banner().className='ok'; banner().textContent=`${unit} cleared. Incident #${inc.id} closed.`; }
  else { renderIncidents(); banner().className='ok'; banner().textContent=`${unit} cleared from incident #${inc.id}`; }
}

function closeIncident(inc){
  const names = inc.units.map(u=>u.unit);
  if(names.length && !confirm(`Close incident #${inc.id} and clear ${names.length} unit(s)?\n\n${names.join(', ')}`)) return;
  for(const u of names) STATUS.set(u, 'AQ');
  removeIncident(inc);
  banner().className='ok'; banner().textContent=`Incident #${inc.id} closed` + (names.length ? `; cleared ${names.join(', ')}` : '');
}

function removeIncident(inc){
  inc.pin.remove();
  INCIDENTS.delete(inc.id);
  renderIncidents();
}

// Units changed away from CALL in the Unit status window drop off their incident
function syncIncidentsFromStatus(){
  for(const inc of [...INCIDENTS.values()]){
    inc.units = inc.units.filter(u=>STATUS.get(u.unit)==='CALL');
    if(!inc.units.length) removeIncident(inc);
  }
  renderIncidents();
}

function focusIncident(inc){
  MAP.setView([inc.lat, inc.lon], Math.max(MAP.getZoom(), 15));
  inc.pin.openPopup();
}

function unitChip(inc, u){
  const s=document.createElement('span'); s.className='pill blue unit-chip'; s.dataset.kind=u.kind||'other';
  const b=document.createElement('b'); b.textContent=u.unit; s.appendChild(b);
  const x=document.createElement('button'); x.type='button'; x.className='pillx'; x.textContent='×';
  x.title=`Clear ${u.unit} (back to AQ)`; x.setAttribute('aria-label', x.title);
  x.onclick=e=>{ e.stopPropagation(); clearUnit(inc, u.unit); };
  s.appendChild(x);
  return s;
}

function incidentPopup(inc){
  const d=document.createElement('div'); d.className='inc-pop';
  const h=document.createElement('div'); h.className='inc-pop-title'; h.textContent=`#${inc.id} · ${inc.type}`;
  const a=document.createElement('div'); a.className='inc-pop-addr'; a.textContent=incidentLocation(inc);
  const units=document.createElement('div'); units.className='inc-units';
  inc.units.forEach(u=>units.appendChild(unitChip(inc, u)));
  const close=document.createElement('button'); close.type='button'; close.className='secondary inc-close'; close.textContent='Close incident';
  close.onclick=()=>closeIncident(inc);
  d.append(h, a, units, close);
  return d;
}

function renderIncidents(){
  const list=B('activeList'); list.innerHTML='';
  const all=[...INCIDENTS.values()].sort((a,b)=>b.id-a.id); // newest first
  B('activeCount').textContent=all.length;
  B('activeCount').classList.toggle('has', all.length>0);
  B('activeEmpty').hidden = all.length>0;
  for(const inc of all){
    const card=document.createElement('article'); card.className='card inc-card';
    const head=document.createElement('div'); head.className='inc-head';
    const num=document.createElement('span'); num.className='inc-num'; num.textContent=inc.id;
    const title=document.createElement('div'); title.className='inc-title';
    const type=document.createElement('b'); type.textContent=inc.type;
    const where=document.createElement('span'); where.className='inc-where'; where.textContent=incidentLocation(inc);
    title.append(type, where);
    const view=document.createElement('button'); view.type='button'; view.className='ghost inc-view'; view.textContent='Map';
    view.title='Show on map'; view.onclick=()=>focusIncident(inc);
    head.append(num, title, view);

    const meta=document.createElement('div'); meta.className='hint';
    meta.textContent = `ESZ ${inc.esz||'—'} · ${inc.units.length} unit${inc.units.length===1?'':'s'} assigned`;

    const units=document.createElement('div'); units.className='inc-units';
    inc.units.forEach(u=>units.appendChild(unitChip(inc, u)));

    const close=document.createElement('button'); close.type='button'; close.className='secondary inc-close'; close.textContent='Close incident';
    close.onclick=()=>closeIncident(inc);

    card.append(head, meta, units, close);
    list.appendChild(card);
    // Keep an open popup in step with the list
    if(inc.pin.isPopupOpen()) inc.pin.setPopupContent(incidentPopup(inc));
  }
}

function showTab(name){
  for(const [btn, panel] of [['tabBtnDispatch','tabDispatch'],['tabBtnActive','tabActive']]){
    const on = panel === (name==='active' ? 'tabActive' : 'tabDispatch');
    B(btn).setAttribute('aria-selected', String(on));
    B(panel).hidden = !on;
  }
}

// Nearest county address for a clicked point (coordinates only go to the county locator)
async function labelFromPoint(lat, lon){
  const req = ++ADDR_REQ;
  CURRENT_ADDR = null;
  try{
    const js = await geocode('/reverseGeocode', {location:JSON.stringify({x:lon, y:lat, spatialReference:{wkid:4326}}), outSR:'4326'});
    const addr = js.address?.Match_addr;
    if(req===ADDR_REQ && addr) CURRENT_ADDR = 'Near ' + addr;
  }catch{ /* no nearby address: incident falls back to the ESZ label */ }
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
      sel.onchange=()=>{ STATUS.set(u,sel.value); syncIncidentsFromStatus(); };
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
  // Wire the landing screen first so it can always be dismissed, even if setup below fails
  B('btnStart').onclick=dismissSplash;
  B('btnStart').focus();

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
      clearAddressChoices();
      if(MARKER) MARKER.remove();
      MARKER=L.marker(e.latlng).addTo(MAP);
      labelFromPoint(e.latlng.lat, e.latlng.lng);
      await setESZFromPoint(e.latlng.lat, e.latlng.lng);
    });
  }catch(err){ console.warn('Map init failed',err); }

  // Incident type: type-to-search combobox, nothing selected by default
  INCIDENT_COMBO = initIncidentCombo(Object.keys(DATA.PLAN_STRUCT||{}).sort());

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
  B('tabBtnDispatch').onclick=()=>showTab('dispatch');
  B('tabBtnActive').onclick=()=>showTab('active');
  renderIncidents();
  B('btnStatus').onclick=openStatus;
  B('closeStatus').onclick=()=>B('statusModal').setAttribute('aria-hidden','true');
  B('resetCaps').onclick=resetCaps;

  // Address search via the county geocoder; "Street A / Street B" via county centerlines; place names via pois.js
  B('btnLocate').onclick=locateAddress;
  B('q').addEventListener('keydown', e=>{
    if(e.key==='Enter') locateAddress();
    else if(e.key==='Escape' && !B('addrChoices').hidden) clearAddressChoices();
  });
  B('addrChoicesCancel').onclick=()=>{ clearAddressChoices(); banner().className='ok'; banner().textContent='Ready'; B('q').focus(); };
  // Pick list keyboard: arrows move between choices (Enter picks the focused one), Esc closes
  B('addrChoicesList').addEventListener('keydown', e=>{
    const rows=[...B('addrChoicesList').querySelectorAll('button.addr-choice')];
    const i=rows.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      rows[e.key==='ArrowDown' ? (i+1)%rows.length : (i<=0 ? rows.length-1 : i-1)]?.focus();
    }else if(e.key==='Escape') B('addrChoicesCancel').click();
  });
  // Down arrow from the search box jumps into an open pick list
  B('q').addEventListener('keydown', e=>{
    if(e.key==='ArrowDown' && !B('addrChoices').hidden){ e.preventDefault(); B('addrChoicesList').querySelector('button.addr-choice')?.focus(); }
  });
}

async function geocode(path, params){
  const r = await fetch(GEOCODE_URL + path + '?' + new URLSearchParams({f:'json', ...params}));
  return r.json();
}

// Locate flow:
// 1. findAddressCandidates: one clear, confident match -> go straight there.
// 2. Otherwise (the county locator returns nothing when an address exists in several towns),
//    ask /suggest, resolve each suggestion to a point, and let the dispatcher pick the town.
async function locateAddress(){
  const q=B('q').value.trim();
  if(!q) return;
  clearAddressChoices();
  setLocateBusy(true);
  try{
    const streets = parseIntersection(q);
    if(streets) return await locateIntersection(q, streets);
    // Anything starting with a house number is an address; otherwise try place names first
    if(!/^\d/.test(q)){
      const places = findPlaces(q);
      if(places.length===1) return await goToPlace(places[0]);
      if(places.length) return showPlaceChoices(q, places);
    }

    const js = await geocode('/findAddressCandidates', {SingleLine:q, outSR:'4326', maxLocations:'10'});
    const good = (js.candidates||[]).filter(c=>c.score >= MIN_GEOCODE_SCORE);
    const top = good[0];
    const tied = top && good.some(c=>c.address!==top.address && c.score===top.score);
    if(top && !tied) return await goToAddress(top.address, top.location.y, top.location.x);

    const sug = (await geocode('/suggest', {text:q, maxSuggestions:'10'})).suggestions || [];
    const resolved = (await Promise.all(sug.map(resolveSuggestion))).filter(Boolean);
    const unique = [...new Map(resolved.map(r=>[r.address, r])).values()];
    if(!unique.length) throw new Error('no matching address');
    if(unique.length===1) return await goToAddress(unique[0].address, unique[0].lat, unique[0].lon);
    showAddressChoices(q, unique);
  }catch(err){
    banner().className='warn'; banner().textContent='Locate failed: '+(err.message||err);
  }finally{
    setLocateBusy(false);
  }
}

async function resolveSuggestion(s){
  try{
    const js = await geocode('/findAddressCandidates', {SingleLine:s.text, magicKey:s.magicKey, outSR:'4326', maxLocations:'1'});
    const c = js.candidates?.[0];
    return c ? {address:c.address, lat:c.location.y, lon:c.location.x} : null;
  }catch{ return null; }
}

// --- Intersections ("Rosemont Ave / Montevue Ln", "Main St & Church St, Frederick") ---
// The county locators only know point addresses, so we pull both streets from the county
// centerline layer and find where their segments meet.
const INTERSECTION_SEP = /\s*[\/&@+]\s*|\s+(?:AND|AT)\s+/i;
const JOIN_TOLERANCE_M = 15;  // a segment end this close to the other street counts as meeting it
const SAME_SPOT_M = 40;       // meeting points this close together are one intersection (N/S, E/W halves of a cross street)
// Centerlines spell numbered streets out ("E SEVENTH ST")
const ORDINALS = ['FIRST','SECOND','THIRD','FOURTH','FIFTH','SIXTH','SEVENTH','EIGHTH','NINTH','TENTH',
  'ELEVENTH','TWELFTH','THIRTEENTH','FOURTEENTH','FIFTEENTH','SIXTEENTH','SEVENTEENTH','EIGHTEENTH','NINETEENTH','TWENTIETH'];
const spellOrdinals = s => s.replace(/\b(\d+)(?:ST|ND|RD|TH)\b/g, (m,n)=>ORDINALS[n-1]||m);

function parseIntersection(q){
  const [main, town=''] = q.split(/,(.*)/s).map(s=>s.trim());
  const parts = main.split(INTERSECTION_SEP).map(s=>spellOrdinals(normAddr(s))).filter(Boolean);
  return parts.length===2 && parts[0]!==parts[1] ? {a:parts[0], b:parts[1], town:town.toUpperCase()} : null;
}

// Street segments whose name has a word starting with the typed text ("MAIN ST" -> N MAIN ST, MAIN ST EXT)
async function fetchStreet(name){
  const s = name.replace(/[%_]/g,'').replace(/'/g,"''");
  const r = await fetch(CENTERLINE_URL + '/query?' + new URLSearchParams({
    f:'json', where:`ST_FULL LIKE '${s}%' OR ST_FULL LIKE '% ${s}%'`,
    outFields:'ST_FULL,CITY', returnGeometry:'true', outSR:'4326',
  }));
  const js = await r.json();
  if(js.error) throw new Error(js.error.message || 'street lookup failed');
  return (js.features||[]).map(f=>({name:f.attributes.ST_FULL, city:f.attributes.CITY||'', paths:f.geometry?.paths||[]}));
}

function metersApart([x1,y1],[x2,y2]){
  const dx=(x2-x1)*111320*Math.cos(y1*Math.PI/180), dy=(y2-y1)*110540;
  return Math.hypot(dx,dy);
}

// Where segment A's end touches any vertex of B, or B's end touches A (covers T-intersections)
function meetingPoint(fa, fb){
  const ends = f => f.paths.flatMap(p=>[p[0], p[p.length-1]]);
  const verts = f => f.paths.flat();
  for(const [e, other] of [[ends(fa), verts(fb)], [ends(fb), verts(fa)]])
    for(const p of e) for(const v of other)
      if(metersApart(p,v) <= JOIN_TOLERANCE_M) return p;
  return null;
}

async function locateIntersection(q, {a, b, town}){
  const [segA, segB] = await Promise.all([fetchStreet(a), fetchStreet(b)]);
  if(!segA.length) throw new Error(`no county street matches "${a}"`);
  if(!segB.length) throw new Error(`no county street matches "${b}"`);

  const found = []; // {address, lat, lon}
  for(const fa of segA) for(const fb of segB){
    if(fa.name===fb.name) continue;
    const city = fa.city || fb.city;
    if(town && !city.toUpperCase().startsWith(town)) continue;
    const p = meetingPoint(fa, fb);
    if(!p) continue;
    const address = `${fa.name} & ${fb.name}${city ? ', '+city : ''}`;
    if(found.some(f=>metersApart([f.lon,f.lat], p) <= SAME_SPOT_M)) continue;
    found.push({address, lat:p[1], lon:p[0]});
  }
  if(!found.length) throw new Error(`${a} and ${b} don't meet in county street data`);
  if(found.length===1) return await goToAddress(found[0].address, found[0].lat, found[0].lon);
  showAddressChoices(q, found, 'intersection');
}

// --- Places ("Food Lion", "Urbana Library") from pois.js, an OpenStreetMap extract built by
// tools/fetch_pois.py. Matching is all local; only a picked place's coordinates go to the county.
const MAX_PLACE_CHOICES = 25;
const normPlace = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(Boolean);
let PLACE_INDEX = null; // [{name, street, town, lat, lon, words}]

function findPlaces(q){
  if(!PLACE_INDEX) PLACE_INDEX = (window.POIS||[]).map(([name, brand, , street, town, lat, lon])=>
    ({name, street, town, lat, lon, words:normPlace(name+' '+brand)}));
  const typed = normPlace(q);
  if(!typed.length) return [];
  // Every typed word must start a word of the name or brand ("food lion" -> "Food Lion #1234")
  const hits = PLACE_INDEX.filter(p=>typed.every(t=>p.words.some(w=>w.startsWith(t))));
  const lead = typed.join(' ');
  const rank = p => normPlace(p.name).join(' ').startsWith(lead) ? 0 : 1;
  return hits.sort((a,b)=>rank(a)-rank(b) || a.name.localeCompare(b.name) || a.town.localeCompare(b.town));
}

// About 60% of places have no street address in OSM; label those by the nearest county address
async function nearestAddress(lat, lon){
  try{
    const a = (await geocode('/reverseGeocode', {location:JSON.stringify({x:lon, y:lat, spatialReference:{wkid:4326}}), outSR:'4326'})).address;
    return a?.Address ? {street:'Near '+a.Address, town:a.City||''} : null;
  }catch{ return null; }
}

const placeLabel = p => [p.name, p.street, p.town].filter(Boolean).join(', ');
const placeSub = p => [p.street, p.town].filter(Boolean).join(' · ') || 'Looking up nearest address…';

async function goToPlace(p){
  if(!p.street){ const near = await nearestAddress(p.lat, p.lon); if(near) p = {...p, street:near.street, town:p.town||near.town}; }
  return goToAddress(placeLabel(p), p.lat, p.lon);
}

function showPlaceChoices(q, places){
  const shown = places.slice(0, MAX_PLACE_CHOICES).map(p=>({...p}));
  shown.forEach(p=>{ p.address = placeLabel(p); p.pick = ()=>goToPlace(p); });
  showAddressChoices(q, shown, 'place', places.length);
  // Fill in missing addresses as the county answers; rows update in place (skipped once the list is gone)
  const rows = [...B('addrChoicesList').querySelectorAll('button.addr-choice')];
  shown.forEach((p,i)=>{
    if(p.street) return;
    nearestAddress(p.lat, p.lon).then(near=>{
      if(!rows[i].isConnected) return;
      if(near){ p.street = near.street; p.town = p.town || near.town; }
      rows[i].querySelector('.addr-street').textContent = near ? placeSub(p) : (p.town || 'No address on file');
    });
  });
}

async function goToAddress(address, lat, lon){
  clearAddressChoices();
  if(MARKER) MARKER.remove();
  MARKER = L.marker([lat, lon]).addTo(MAP);
  CURRENT_ADDR = address; ADDR_REQ++;
  B('q').value = address; // replace the partial text with the verified address
  MAP.setView([lat, lon], 16);
  banner().className='ok'; banner().textContent='Located: '+address;
  await setESZFromPoint(lat, lon); // may replace banner with an ESZ lookup warning
}

function setLocateBusy(busy){
  B('btnLocate').disabled=busy;
  B('btnLocate').textContent = busy ? 'Searching…' : 'Locate';
}

// --- Multiple-match picker (list in the sidebar + numbered pins on the map) ---
let CHOICE_LAYER=null;

// Uppercase, strip punctuation, and abbreviate directions/street types so typed text
// compares against the locator's "200 E MAIN ST" style.
const ABBR = {NORTH:'N',SOUTH:'S',EAST:'E',WEST:'W',STREET:'ST',AVENUE:'AVE',ROAD:'RD',DRIVE:'DR',LANE:'LN',COURT:'CT',PLACE:'PL',BOULEVARD:'BLVD',PIKE:'PIKE',CIRCLE:'CIR',TERRACE:'TER'};
const normAddr = s => String(s).toUpperCase().replace(/[.,#]/g,' ').split(/\s+/).filter(Boolean).map(w=>ABBR[w]||w).join(' ');

// kind: 'address' | 'intersection' | 'place'. Places arrive with name/street/town already split
// and their own pick(); total is how many places matched before the list was capped.
function showAddressChoices(q, options, kind='address', total=options.length){
  const isXing = kind==='intersection', isPlace = kind==='place';
  const typed = normAddr(q.split(',')[0]);
  const parse = o => { if(isPlace) return o; const [street, town='', , zip=''] = o.address.split(',').map(s=>s.trim()); return {...o, street, town, zip}; };
  // Exact street match (typed text may also carry a town after the street); every intersection or place found is a real match
  const isExact = o => { if(isXing || isPlace) return true; const st=normAddr(o.street); return st.startsWith(typed) || typed.startsWith(st+' '); };
  const all = options.map(parse);
  const exact = all.filter(isExact), similar = all.filter(o=>!isExact(o));
  const ordered = [...exact, ...similar];

  const box=B('addrChoices'), list=B('addrChoicesList');
  list.innerHTML='';
  B('addrChoicesTitle').textContent = isPlace
    ? (total > exact.length ? `Showing ${exact.length} of ${total} places. Type more to narrow:` : `${exact.length} places match. Pick one:`)
    : isXing ? `${exact.length} intersections match. Pick one:`
    : exact.length > 1 ? `${exact.length} towns have this address. Pick one:`
    : 'No exact single match. Pick an address:';

  CHOICE_LAYER = L.layerGroup().addTo(MAP);
  const pins = [];
  ordered.forEach((o,i)=>{
    const n=i+1;
    if(i===exact.length && similar.length && exact.length){
      const h=document.createElement('div'); h.className='addr-choices-sub'; h.textContent='Similar addresses'; list.appendChild(h);
    }
    const b=document.createElement('button');
    b.type='button'; b.className='addr-choice'+(i<exact.length?' exact':''); b.setAttribute('role','listitem');
    const num=document.createElement('span'); num.className='addr-num'; num.textContent=n;
    const txt=document.createElement('span'); txt.className='addr-txt';
    const town=document.createElement('b'); town.textContent=isPlace ? o.name : (o.town||'(no town)');
    const st=document.createElement('span'); st.className='addr-street'; st.textContent=isPlace ? placeSub(o) : `${o.street}${o.zip?' · '+o.zip:''}`;
    txt.append(town, st); b.append(num, txt);
    const pick = o.pick || (()=>goToAddress(o.address, o.lat, o.lon));
    b.onclick=pick;

    const pin = L.marker([o.lat,o.lon], {
      icon: L.divIcon({className:'addr-pin'+(i<exact.length?' exact':''), html:`<span>${n}</span>`, iconSize:[26,26], iconAnchor:[13,13]}),
      title: o.address, keyboard:false,
    // Permanent town labels only on exact matches (and short place lists); the rest label on hover to avoid overlap
    }).bindTooltip(isPlace ? (o.town ? `${o.name} · ${o.town}` : o.name) : isXing ? o.street : i<exact.length ? (o.town||o.street) : o.address.split(',').slice(0,2).join(','),
                   {permanent:i<exact.length && !(isPlace && exact.length > 8), direction:'right', offset:[12,0], className:'addr-tip'})
      .on('click', pick)
      .addTo(CHOICE_LAYER);
    pins.push(pin);
    // Hovering a row highlights its pin
    b.onmouseenter=b.onfocus=()=>pin.getElement()?.classList.add('hot');
    b.onmouseleave=b.onblur=()=>pin.getElement()?.classList.remove('hot');
    list.appendChild(b);
  });

  box.hidden=false;
  MAP.fitBounds(L.latLngBounds(pins.map(p=>p.getLatLng())), {padding:[60,60], maxZoom:15});
  banner().className='warn'; banner().textContent=`Multiple matches for "${q}". Pick the correct ${isPlace ? 'place' : isXing ? 'intersection' : 'town'}.`;
  list.querySelector('button')?.focus();
}

function clearAddressChoices(){
  B('addrChoices').hidden=true;
  B('addrChoicesList').innerHTML='';
  if(CHOICE_LAYER){ CHOICE_LAYER.remove(); CHOICE_LAYER=null; }
}

window.addEventListener('error',e=>{ if(banner()){banner().className='warn'; banner().textContent='JS error: '+(e.message||e);}});
window.addEventListener('unhandledrejection',e=>{ if(banner()){banner().className='warn'; banner().textContent='Promise error: '+(e.reason?.message||e.reason||e);}});

window.addEventListener('DOMContentLoaded', boot);
