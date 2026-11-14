'use strict';
/*
  Cuaderno · app de escritorio (Mac y Windows).

  Es la misma interfaz (web/cuaderno-apuntes.html) dentro de su propia ventana, sin navegador.
  Lo que antes hacía servidor.py lo hace ahora este proceso, a través del protocolo interno
  cuaderno://app/ (mismas rutas /api/... que el servidor de Python, así la interfaz no cambia):
    - correo de la UV por IMAP (post.uv.es:993, solo lectura) y envío por SMTP (post.uv.es:587);
    - la contraseña se guarda cifrada con el almacén seguro del sistema (Llavero / DPAPI);
    - datos en una carpeta (por defecto la de la app; se puede elegir otra, p. ej. en Google Drive,
      y entonces se combinan con los de otros ordenadores igual que hacía servidor.py). Nunca se busca
      ni se usa Google Drive por su cuenta: por defecto todo queda en este ordenador;
    - archivos subidos, abrirlos con su programa, PDF y envío por correo.
  La app sigue funcionando al cerrar la ventana (para avisos y correo) y arranca con el ordenador.
*/
const { app, BrowserWindow, protocol, shell, dialog, Tray, Menu, safeStorage, nativeImage, session, net, clipboard, ipcMain, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const SCHEME = 'cuaderno';
const ORIGIN = `${SCHEME}://app`;
const WEB = path.join(__dirname, 'web');
const UV_IMAP = { host: 'post.uv.es', port: 993 };
const UV_SMTP = { host: 'post.uv.es', port: 587 };
const DAYS = 60, MAX_FIRST = 300, MAX_BODY = 30000, INTERVAL_MIN = 5;
const LOCAL_KEYS = ['active', 'activeNote', 'view', 'railOpen', 'theme', 'soundOff', 'subjectScope'];
const LISTS = ['notes', 'tasks', 'biblio', 'files'];

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);
app.setName('Cuaderno');
if (process.env.CUADERNO_PRUEBA) app.setPath('userData', process.env.CUADERNO_PRUEBA);   // pruebas sin tocar los datos reales
app.userAgentFallback = `${app.userAgentFallback} CuadernoApp/${app.getVersion()}`;

let win = null, tray = null, quitting = false;
let intranetWindow=null,geminiWindow=null;
function uvOrigin(event,origin) {try{const frame=new URL(event.senderFrame.url);return event.sender===intranetWindow?.webContents&&frame.protocol==='https:'&&['as.uv.es','portal.uv.es'].includes(frame.hostname)&&frame.origin===origin;}catch(_){return false;}}
ipcMain.handle('cuaderno:uv:read',(event,origin)=>{if(!uvOrigin(event,origin))return null;const saved=(ajustes().intranetLogins||{})[origin];if(!saved?.pw||!safeStorage.isEncryptionAvailable())return null;try{return {user:saved.user,password:safeStorage.decryptString(Buffer.from(saved.pw,'base64'))};}catch(_){return null;}});
ipcMain.handle('cuaderno:uv:save',(event,d)=>{if(!uvOrigin(event,d?.origin)||!safeStorage.isEncryptionAvailable()||typeof d.user!=='string'||typeof d.password!=='string'||d.user.length>200||d.password.length>1000)return false;const logins=ajustes().intranetLogins||{};logins[d.origin]={user:d.user,pw:safeStorage.encryptString(d.password).toString('base64')};setAjustes({intranetLogins:logins});return true;});
function openIntranet() {
  if(intranetWindow&&!intranetWindow.isDestroyed()){intranetWindow.show();intranetWindow.focus();return;}
  intranetWindow=new BrowserWindow({width:1200,height:850,title:'Intranet UV · Cuaderno',webPreferences:{partition:'persist:cuaderno-intranet',preload:path.join(__dirname,'intranet-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  intranetWindow.webContents.on('will-navigate',(event,url)=>{try{const u=new URL(url);if(u.protocol==='https:'&&(u.hostname==='uv.es'||u.hostname.endsWith('.uv.es')))return;}catch(_){}event.preventDefault();if(/^https?:/i.test(url))shell.openExternal(url);});
  intranetWindow.webContents.setWindowOpenHandler(({url})=>{try{const u=new URL(url);if(u.protocol==='https:'&&(u.hostname==='uv.es'||u.hostname.endsWith('.uv.es'))){intranetWindow.loadURL(url);return {action:'deny'};}}catch(_){}if(/^https?:/i.test(url))shell.openExternal(url);return {action:'deny'};});
  intranetWindow.on('closed',()=>{intranetWindow=null;});intranetWindow.loadURL('https://portal.uv.es/cgi-bin/portal/portal?lang=ca');
}
function openGemini(prompt) {
  if(prompt)clipboard.writeText(String(prompt).slice(0,200000));
  if(geminiWindow&&!geminiWindow.isDestroyed()){geminiWindow.show();geminiWindow.focus();return;}
  geminiWindow=new BrowserWindow({width:1050,height:850,title:'Gemini · Cuaderno',webPreferences:{partition:'persist:cuaderno-gemini',nodeIntegration:false,contextIsolation:true,sandbox:true}});
  geminiWindow.webContents.on('context-menu',(event,p)=>contextMenu(geminiWindow.webContents,p));
  geminiWindow.webContents.setWindowOpenHandler(({url})=>{if(/^https?:/i.test(url))shell.openExternal(url);return {action:'deny'};});
  geminiWindow.on('closed',()=>{geminiWindow=null;});geminiWindow.loadURL('https://gemini.google.com/app');
}

/* ------------------------------------------------------------------ utilidades */
const USER = () => app.getPath('userData');
const AJUSTES = () => path.join(USER(), 'ajustes.json');
const CACHE = () => path.join(USER(), 'correos.json');
const LOG = () => path.join(USER(), 'cuaderno.log');

function log(...a) {
  try { fs.appendFileSync(LOG(), `[${new Date().toLocaleString('es-ES')}] ${a.join(' ')}\n`); } catch (e) {}
}
function loadJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}
function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}
// JSON con las claves ordenadas, para comparar contenidos sin que importe el orden
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const ajustes = () => loadJSON(AJUSTES(), {});
function setAjustes(patch) { const a = { ...ajustes(), ...patch }; for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k]; saveJSON(AJUSTES(), a); return a; }

/* -------------------------------------------------------- carpeta de los datos */
// Los datos se guardan siempre en una carpeta local de este ordenador (dentro de la carpeta de la app),
// salvo que la persona elija otra en Ajustes → «Carpeta de datos».
function dataDir() {
  return ajustes().dataDir || path.join(USER(), 'datos');
}
// «--carpeta-datos=<ruta>»: la usa el lanzador antiguo del PC de Jano para que la app nueva abra sus datos de Drive
// desde el primer arranque. Solo se aplica si todavía no hay carpeta elegida y la carpeta existe.
function applyDataDirArg(argv) {
  const a = (argv || []).find(x => String(x).startsWith('--carpeta-datos='));
  if (!a || ajustes().dataDir) return;
  const dir = a.slice('--carpeta-datos='.length).replace(/^"|"$/g, '');
  try { if (fs.existsSync(dir)) { setAjustes({ dataDir: dir }); log('Carpeta de datos indicada al abrir:', dir); } } catch (e) {}
}
const STATE_FILE = () => path.join(dataDir(), 'cuaderno-datos.json');
const FILES_DIR = () => path.join(dataDir(), 'archivos');
const history = require('./historial')(dataDir);
let documentWorker=null,documentSequence=0;const documentRequests=new Map();
function documentJob(type,data){if(!documentWorker){documentWorker=new (require('worker_threads').Worker)(workerFile('documentos-worker.js'));documentWorker.on('message',m=>{const p=documentRequests.get(m.id);if(p){clearTimeout(p.timer);documentRequests.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}});documentWorker.on('error',e=>{for(const p of documentRequests.values()){clearTimeout(p.timer);p.reject(e);}documentRequests.clear();documentWorker=null;});}const id=++documentSequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{documentRequests.delete(id);reject(new Error('La operación está tardando demasiado. Vuelve a intentarlo.'));},120000);documentRequests.set(id,{resolve,reject,timer});documentWorker.postMessage({id,type,...data});});}

/* ------------------------------------------------- combinar datos (como servidor.py) */
function mergeList(a, b, deleted) {
  const out = new Map();
  for (const it of [...(a || []), ...(b || [])]) {
    const i = it && it.id;
    if (!i) continue;
    const cur = out.get(i);
    if (!cur || (it._u || 0) > (cur._u || 0)) out.set(i, it);
  }
  return [...out.values()].filter(x => !(x.id in deleted) || (deleted[x.id] || 0) < (x._u || 0));
}
function mergeStates(disk, inc) {
  if (!disk) return inc;
  const deleted = { ...(disk.deleted || {}) };
  for (const [k, v] of Object.entries(inc.deleted || {})) deleted[k] = Math.max(v, deleted[k] || 0);
  const order = (disk.subjects || []).map(s => s.id);
  for (const s of inc.subjects || []) if (!order.includes(s.id)) order.push(s.id);
  const subs = {};
  for (const s of [...(disk.subjects || []), ...(inc.subjects || [])]) {
    const cur = subs[s.id];
    if (!cur) { subs[s.id] = { ...s }; continue; }
    const base = (s._u || 0) > (cur._u || 0) ? s : cur;
    const merged = { ...base };
    for (const k of LISTS) merged[k] = mergeList(cur[k], s[k], deleted);
    // los esquemas llevan su propia hora de cambio: no los pisa un cambio de nombre o color de la asignatura en otro ordenador
    const ea = cur.esquemas, eb = s.esquemas;
    if (ea || eb) merged.esquemas = !ea ? eb : !eb ? ea : ((eb._u || 0) > (ea._u || 0) ? eb : ea);
    subs[s.id] = merged;
  }
  for (const s of Object.values(subs)) for (const k of LISTS) s[k] = mergeList(s[k], [], deleted);
  const incNewer = (inc._u || 0) >= (disk._u || 0);
  const out = { ...(incNewer ? inc : disk) };
  // Ajustes (nombre, idioma, foto…) y horario: gana el que se cambió más tarde, no el ordenador que guardó el último
  const sd = disk.settings || {}, si = inc.settings || {};
  if (sd._u || si._u) {
    const incSet = (si._u || 0) >= (sd._u || 0);
    out.settings = incSet ? inc.settings : disk.settings;
    out.schedule = incSet ? (inc.schedule || disk.schedule) : (disk.schedule || inc.schedule);
  }
  out.subjects = order.filter(i => i in subs && !(i in deleted && deleted[i] >= (subs[i]._u || 0))).map(i => subs[i]);
  out.deleted = deleted;
  out.library = mergeList(disk.library, inc.library, deleted);
  out.homeBoard = mergeList(disk.homeBoard, inc.homeBoard, deleted);
  out.mailSeen = { ...(disk.mailSeen || {}), ...(inc.mailSeen || {}) };
  const ad = disk.autoMail || {}, ai = inc.autoMail || {};
  out.autoMail = {
    seen: { ...(ad.seen || {}), ...(ai.seen || {}) },
    dismissed: { ...(ad.dismissed || {}), ...(ai.dismissed || {}) },
    review: (incNewer ? ai : ad).review || [],
  };
  out.notified = { ...(disk.notified || {}), ...(inc.notified || {}) };
  for (const k of LOCAL_KEYS) delete out[k];
  out._u = Math.max(disk._u || 0, inc._u || 0);
  return out;
}
/* Corrector ortográfico: idioma según el selector ES/CA. En Mac lo decide el sistema (detecta el idioma solo);
   en Windows se usan los diccionarios de Chromium (se descargan una vez de Google la primera vez). */
let uiLang = 'es';
let spellWorker=null,spellSequence=0;
const workerFile = name => app.isPackaged ? path.join(process.resourcesPath,'app.asar.unpacked',name) : path.join(__dirname,name);
const spellRequests=new Map();
function spelling(words,lang=uiLang,suggest=false) {
  if(!spellWorker){const {Worker}=require('worker_threads');spellWorker=new Worker(workerFile('ortografia-worker.js'));spellWorker.on('message',m=>{const pending=spellRequests.get(m.id);if(pending){clearTimeout(pending.timer);spellRequests.delete(m.id);m.error?pending.reject(new Error(m.error)):pending.resolve(m.results);}});spellWorker.on('error',e=>{for(const pending of spellRequests.values()){clearTimeout(pending.timer);pending.reject(e);}spellRequests.clear();spellWorker=null;});}
  const id=++spellSequence;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{spellRequests.delete(id);reject(new Error('El diccionario no responde.'));},15000);spellRequests.set(id,{resolve,reject,timer});spellWorker.postMessage({id,lang,words:[...new Set(words)].slice(0,300),suggest,personal:(ajustes().spellWords||{})[lang]||[]});});
}
function setSpellLang(lang) {
  uiLang = lang === 'ca' ? 'ca' : 'es';
  if (IS_MAC) return;
  try {
    const ses = session.defaultSession;
    const ok = ses.availableSpellCheckerLanguages || [];
    // un solo diccionario, el del idioma elegido: con los dos a la vez sugería palabras del otro idioma
    const want = uiLang === 'ca' ? ['ca'] : ['es-ES'];
    const langs = want.filter(l => ok.includes(l));
    const now = ses.getSpellCheckerLanguages();
    if (langs.length && langs.join() !== now.join()) { ses.setSpellCheckerLanguages(langs); log('Ortografía:', langs.join(', ')); }
  } catch (e) { log('Ortografía:', e.message); }
}
// Electron no trae menú con el botón derecho: sin él se subrayaban las faltas pero no había forma de corregirlas.
async function contextMenu(wc, p) {
  const T = uiLang === 'ca'
    ? { none: 'Sense suggeriments', add: 'Afegeix al diccionari', cut: 'Retalla', copy: 'Copia', paste: 'Enganxa', plain: 'Enganxa sense format', all: 'Selecciona-ho tot', link: 'Copia l’enllaç', open: 'Obri l’enllaç' }
    : { none: 'Sin sugerencias', add: 'Añadir al diccionario', cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', plain: 'Pegar sin formato', all: 'Seleccionar todo', link: 'Copiar enlace', open: 'Abrir enlace' };
  const items = [];
  let ownWord='';try{ownWord=await wc.executeJavaScript(`window.cuadernoSpellAt ? window.cuadernoSpellAt(${Number(p.x)},${Number(p.y)}) : ''`);}catch(_){}
  if(ownWord){try{const [result]=await spelling([ownWord],uiLang,true);p={...p,misspelledWord:''};if(result&&!result.correct){for(const suggestion of result.suggestions)items.push({label:suggestion,click:()=>wc.executeJavaScript(`window.cuadernoCorregirPalabra(${JSON.stringify(suggestion)})`).catch(()=>{})});if(!result.suggestions.length)items.push({label:T.none,enabled:false});items.push({label:T.add,click:()=>{const a=ajustes(),personal=a.spellWords||{};personal[uiLang]=[...new Set([...(personal[uiLang]||[]),ownWord])];setAjustes({spellWords:personal});wc.executeJavaScript('window.cuadernoRevisarOrtografia && window.cuadernoRevisarOrtografia(true)').catch(()=>{});}});items.push({type:'separator'});}}catch(_){} }
  if(p.mediaType==='image')items.push({label:uiLang==='ca'?'Copia la imatge':'Copiar imagen',click:()=>wc.copyImageAt(p.x,p.y)},{type:'separator'});
  if (p.misspelledWord) {
    const sug = (p.dictionarySuggestions || []).slice(0, 6);
    for (const s of sug) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!sug.length) items.push({ label: T.none, enabled: false });
    items.push({ label: T.add, click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    items.push({ type: 'separator' });
  }
  if (p.linkURL && /^(https?|mailto):/i.test(p.linkURL)) {
    items.push({ label: T.open, click: () => shell.openExternal(p.linkURL) }, { label: T.link, click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
  }
  const f = p.editFlags || {};
  if (p.isEditable) {
    items.push({ role: 'cut', label: T.cut, enabled: !!f.canCut }, { role: 'copy', label: T.copy, enabled: !!f.canCopy },
      { role: 'paste', label: T.paste, enabled: !!f.canPaste }, { role: 'pasteAndMatchStyle', label: T.plain, enabled: !!f.canPaste },
      { type: 'separator' }, { role: 'selectAll', label: T.all });
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ role: 'copy', label: T.copy });
  }
  while (items.length && items[items.length - 1].type === 'separator') items.pop();
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || undefined });
}
let stateBusy = Promise.resolve();
// Cuántos apuntes, tareas, referencias, archivos y asignaturas hay (para frenar borrados masivos)
function itemIds(st) {
  const ids = new Set();
  for (const s of (st && st.subjects) || []) { ids.add(s.id); for (const k of LISTS) for (const x of s[k] || []) if (x && x.id) ids.add(x.id); }
  for (const x of (st && st.library) || []) if (x && x.id) ids.add(x.id);
  for (const x of (st && st.homeBoard) || []) if (x && x.id) ids.add(x.id);
  return ids;
}
// Copia de seguridad automática antes de cambiar los datos (como mucho una cada 20 minutos; se guardan 60)
function backupState() {
  try {
    const f = STATE_FILE(); if (!fs.existsSync(f)) return;
    const dir = path.join(dataDir(), 'copias'); fs.mkdirSync(dir, { recursive: true });
    const list = fs.readdirSync(dir).filter(n => /^cuaderno-datos-.*\.json$/.test(n)).sort();
    const last = list.length ? fs.statSync(path.join(dir, list[list.length - 1])).mtimeMs : 0;
    if (Date.now() - last < 20 * 60 * 1000) return;
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `cuaderno-datos-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`;
    fs.copyFileSync(f, path.join(dir, name));
    for (const old of list.slice(0, Math.max(0, list.length + 1 - 60))) fs.unlinkSync(path.join(dir, old));
  } catch (e) { log('Copia de seguridad:', e.message); }
}
/* Dos copias de seguridad que se turnan cada 5 minutos: «copia-A.json» y «copia-B.json», en la carpeta
   «copias-seguridad» junto a los datos. Cada vez se sobrescribe la más antigua, así que siempre queda una de hace
   como mucho 5 minutos y otra de hace como mucho 10, aunque una se estropee al escribirse.
   Nunca se pierde nada: si los datos han encogido de golpe (muchos apuntes menos), antes de turnar se aparta la copia
   grande en «copia-antes-de-borrar-<fecha>.json», que no se borra nunca. Los adjuntos (carpeta «archivos») no se borran nunca. */
const SAFE_DIR = () => path.join(dataDir(), 'copias-seguridad');
function rotatingBackup() {
  try {
    const f = STATE_FILE(); if (!fs.existsSync(f)) return;
    let st; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { log('Copia alterna: los datos no se pueden leer ahora; se reintentará'); return; }
    if (!st || !Array.isArray(st.subjects)) return;
    const dir = SAFE_DIR(); fs.mkdirSync(dir, { recursive: true });
    const slots = ['A', 'B'].map(k => { const p = path.join(dir, `copia-${k}.json`); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch (e) {} return { p, m }; });
    const newest = slots[0].m >= slots[1].m ? slots[0] : slots[1], target = newest === slots[0] ? slots[1] : slots[0];
    const prev = newest.m ? loadJSON(newest.p, null) : null;
    if (prev && canon(prev) === canon(st)) return;   // nada nuevo desde la última copia
    if (prev) {
      const a = itemIds(prev).size, b = itemIds(st).size;
      if (a - b > 5 && b < a * 0.7) {
        const d = new Date(), p2 = n => String(n).padStart(2, '0');
        const side = path.join(dir, `copia-antes-de-borrar-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.json`);
        if (!fs.existsSync(side)) fs.copyFileSync(newest.p, side);
        log(`Copia alterna: los datos han bajado de ${a} a ${b} elementos; la copia anterior queda guardada en ${path.basename(side)}`);
      }
    }
    const tmp = target.p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st), 'utf8');
    JSON.parse(fs.readFileSync(tmp, 'utf8'));   // se comprueba que se ha escrito entera antes de sustituir la copia
    fs.renameSync(tmp, target.p);
  } catch (e) { log('Copia alterna:', e.message); }
}
function syncState(inc) {
  const run = async () => {
    const exists = fs.existsSync(STATE_FILE());
    const disk = loadJSON(STATE_FILE(), null);
    // El archivo existe pero no se puede leer (p. ej. Google Drive lo está bajando): no se escribe nada, se reintenta
    if (exists && !disk) throw new Error('Los datos guardados no se pueden leer ahora mismo; se reintentará');
    const fresh = inc._fresh; delete inc._fresh;
    if (fresh && disk) return disk;   // ordenador nuevo (Cuaderno vacío): adopta los datos guardados
    for (const k of LOCAL_KEYS) delete inc[k];
    // Freno de seguridad: si un ordenador pide borrar de golpe muchos elementos que siguen guardados, no se hace caso
    if (disk && inc.deleted) {
      const have = itemIds(disk), known = disk.deleted || {};
      const gone = Object.keys(inc.deleted).filter(id => have.has(id) && !(id in known));
      if (gone.length > 5 && gone.length > have.size * 0.3) {
        log(`Borrado masivo ignorado: ${gone.length} de ${have.size} elementos`);
        for (const id of gone) delete inc.deleted[id];
      }
    }
    const merged = mergeStates(disk, inc);
    if (!disk || canon(merged) !== canon(disk)) {
      backupState();
      try{history.capture(disk,merged);}catch(e){log('Historial:',e.message);}
      fs.mkdirSync(dataDir(), { recursive: true });
      const tmp = STATE_FILE() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(merged), 'utf8');
      fs.renameSync(tmp, STATE_FILE());
    }
    setSpellLang(merged && merged.settings && merged.settings.lang);
    return merged;
  };
  const p = stateBusy.then(run, run);
  stateBusy = p.catch(() => {});
  return p;
}
const safeId = i => /^[A-Za-z0-9_-]{4,64}$/.test(i || '');

/* --------------------------------------------------------------- cuenta de la UV */
const status = { last_sync: null, error: null, syncing: false };
let pwMem = null;

function uvUser(raw) { let u = String(raw || '').trim().toLowerCase(); if (u.includes('@')) u = u.split('@')[0]; return u; }
function getPassword() {
  if (pwMem) return pwMem;
  const a = ajustes();
  if (!a.pw) return null;
  try { pwMem = safeStorage.decryptString(Buffer.from(a.pw, 'base64')); return pwMem; } catch (e) { log('No se puede leer la contraseña guardada:', e.message); return null; }
}
function storePassword(pw) {
  pwMem = pw;
  if (safeStorage.isEncryptionAvailable()) { setAjustes({ pw: safeStorage.encryptString(pw).toString('base64') }); return true; }
  setAjustes({ pw: undefined });
  return false;
}
const isConfigured = () => !!ajustes().user && !!getPassword();

function imapClient(user, pass) {
  const { ImapFlow } = require('imapflow');
  return new ImapFlow({ ...UV_IMAP, secure: true, auth: { user, pass }, logger: false, socketTimeout: 90000, connectionTimeout: 30000 });
}
function imapError(e) {
  if (e && (e.authenticationFailed || /auth|login|credential/i.test(String(e.responseText || e.message || ''))))
    return 'La UV no ha aceptado ese usuario o esa contraseña. Revísalos e inténtalo de nuevo.';
  return 'No se ha podido conectar con el correo de la UV. Comprueba tu conexión a internet.';
}
async function configure(rawUser, pw) {
  const user = uvUser(rawUser);
  if (!user || !pw) return { ok: false, message: 'Escribe tu usuario y tu contraseña de la UV.' };
  if (!/^[a-z0-9._-]{2,64}$/.test(user)) return { ok: false, message: 'El usuario no parece correcto: es la parte de tu correo antes de la @.' };
  const c = imapClient(user, pw);
  try { await c.connect(); await c.logout(); }
  catch (e) { log('Prueba de cuenta fallida:', e.message); try { c.close(); } catch (x) {} return { ok: false, message: imapError(e) }; }
  const old = ajustes();
  if (old.user && old.user !== user) { try { fs.unlinkSync(CACHE()); } catch (e) {} }
  setAjustes({ user });
  const stored = storePassword(pw);
  status.error = null;
  setTimeout(syncMail, 200);
  return { ok: true, user, message: stored ? '' : 'La contraseña no se ha podido guardar de forma segura: se pedirá de nuevo al reiniciar.' };
}
function forget() {
  pwMem = null;
  setAjustes({ user: undefined, pw: undefined });
  try { fs.unlinkSync(CACHE()); } catch (e) {}
  status.last_sync = null; status.error = null;
}

/* ------------------------------------------------------------- lectura del correo */
function htmlToText(html) {
  let t = String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<\/?(br|p|div|tr|li|h[1-4]|table|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  t = t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
async function parseMessage(uid, flags, source) {
  const { simpleParser } = require('mailparser');
  const m = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = (m.from && m.from.value && m.from.value[0]) || {};
  const body = ((m.text && m.text.trim()) ? m.text : htmlToText(m.html || '')).trim().slice(0, MAX_BODY);
  return {
    uid,
    from_name: from.name || '',
    from: String(from.address || '').toLowerCase(),
    to: (m.to && m.to.text) || '',
    cc: (m.cc && m.cc.text) || '',
    reply_to: (m.replyTo && m.replyTo.text) || '',
    message_id: m.messageId || '', references: Array.isArray(m.references) ? m.references.join(' ') : (m.references || ''),
    subject: m.subject || '(sin asunto)',
    date: m.date && !isNaN(m.date) ? m.date.toISOString() : null,
    body,
    snippet: body.replace(/\s+/g, ' ').slice(0, 180),
    seen: !!(flags && flags.has('\\Seen')),
    attachments: (m.attachments || []).filter(a => a.filename && !a.related).map(a => a.filename),
  };
}
let mailBusy = false;
const mailSuite = require('./correo-suite')({ settings: ajustes, password: getPassword, client: imapClient, userDir: USER, filesDir: FILES_DIR, parseMessage, smtp: UV_SMTP });
async function syncMail() {
  const a = ajustes();
  if (!a.user) { status.error = null; return; }
  const pw = getPassword();
  if (!pw) { status.error = 'Falta la contraseña del correo. Vuelve a conectar tu cuenta en Ajustes de correo.'; return; }
  if (mailBusy) return;
  mailBusy = true; status.syncing = true;
  const c = imapClient(a.user, pw);
  try {
    await c.connect();
    const lock = await c.getMailboxLock('INBOX', { readOnly: true });
    try {
      let cache = loadJSON(CACHE(), { uidvalidity: null, mails: [] });
      const uv = String(c.mailbox.uidValidity);
      if (cache.uidvalidity !== uv) cache = { uidvalidity: uv, mails: [] };
      const since = new Date(Date.now() - DAYS * 864e5);
      const uids = ((await c.search({ since }, { uid: true })) || []).map(Number).sort((x, y) => x - y);
      const flags = {};
      for (let i = 0; i < uids.length; i += 200) {
        for await (const msg of c.fetch(uids.slice(i, i + 200), { uid: true, flags: true }, { uid: true })) flags[String(msg.uid)] = msg.flags;
      }
      const known = new Set(cache.mails.map(x => x.uid));
      const fresh = uids.map(String).filter(u => !known.has(u)).slice(-MAX_FIRST);
      for (let i = 0; i < fresh.length; i += 20) {
        const raw = [];
        for await (const msg of c.fetch(fresh.slice(i, i + 20), { uid: true, flags: true, source: true }, { uid: true })) raw.push(msg);
        for (const msg of raw) {
          try { cache.mails.push(await parseMessage(String(msg.uid), msg.flags, msg.source)); }
          catch (e) { log('No se ha podido leer un correo:', e.message); }
        }
      }
      const alive = new Set(uids.map(String));
      cache.mails = cache.mails.filter(x => alive.has(x.uid));
      for (const x of cache.mails) if (flags[x.uid]) x.seen = flags[x.uid].has('\\Seen');
      cache.mails.sort((p, q) => String(q.date || '').localeCompare(String(p.date || '')));
      saveJSON(CACHE(), cache);
      status.last_sync = new Date().toISOString();
      status.error = null;
      if (fresh.length) log(`${fresh.length} correo(s) nuevo(s).`);
    } finally { lock.release(); }
    await c.logout();
  } catch (e) {
    log('Error del correo:', e.message);
    status.error = e && e.authenticationFailed
      ? 'La UV ha rechazado el acceso. Si has cambiado la contraseña, vuelve a conectar tu cuenta en Ajustes de correo.'
      : 'No se ha podido comprobar el correo. Revisa tu conexión a internet.';
    try { c.close(); } catch (x) {}
  } finally { mailBusy = false; status.syncing = false; }
}

/* ------------------------------------------------------------- archivos, PDF, envío */
const OPENABLE = new Set(('pdf doc docx odt rtf txt md csv ppt pptx pps ppsx odp key xls xlsx ods numbers pages png jpg jpeg gif webp bmp heic tif tiff ' +
  'mp3 m4a wav ogg mp4 mov webm avi zip rar 7z epub ggb sb3').split(' '));
async function openWithDefaultApp(id, name) {
  const src = path.join(FILES_DIR(), `${id}.bin`);
  if (!safeId(id) || !fs.existsSync(src)) throw new Error('No se encuentra el archivo');
  name = String(name || '').replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 150) || 'archivo';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!OPENABLE.has(ext)) throw new Error('Este tipo de archivo no se abre desde aquí; descárgalo');
  const dir = path.join(os.tmpdir(), 'cuaderno-abiertos', id);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, name);
  fs.copyFileSync(src, dst);
  const err = await shell.openPath(dst);
  if (err) throw new Error(err);
}
async function htmlToPdf(html, regions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuaderno-pdf-'));
  const file = path.join(dir, 'doc.html');
  fs.writeFileSync(file, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: false, javascript: true } });
  try {
    await w.loadFile(file);
    await new Promise(r => setTimeout(r, 400));   // tipos de letra e imágenes
    const escape=s=>String(s||'').slice(0,240).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const template=(text,page=false)=>'<div style="font:10px Arial;color:#666;width:100%;margin:0 20mm;display:flex;justify-content:space-between"><span style="white-space:pre-wrap">'+escape(text)+'</span>'+(page?'<span class="pageNumber"></span>':'')+'</div>';
    return await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4',displayHeaderFooter:!!(regions.header||regions.footer),headerTemplate:template(regions.header),footerTemplate:template(regions.footer,true) });
  } finally {
    w.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function sendPdfMail(d) {
  const nodemailer = require('nodemailer');
  const a = ajustes(), pw = getPassword();
  if (!a.user || !pw) throw new Error('El correo no está configurado.');
  const to = String(d.to || '').split(/[,;\s]+/).filter(x => x.includes('@'));
  const sender = String(d.from || '').trim();
  if (!to.length) throw new Error('Falta la dirección de destino.');
  if (!sender.includes('@')) throw new Error('Falta tu dirección de correo (remitente).');
  const title = String(d.title || 'Documento').trim();
  const fname = title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120) || 'documento';
  const t = nodemailer.createTransport({ ...UV_SMTP, secure: false, requireTLS: true, auth: { user: a.user, pass: pw } });
  await t.sendMail({
    from: { name: d.from_name || '', address: sender }, to,
    subject: String(d.subject || title).trim(),
    text: String(d.text || '').trim() || 'Te envío el documento adjunto en PDF.',
    attachments: [{ filename: fname + '.pdf', content: await htmlToPdf(String(d.html || ''),d), contentType: 'application/pdf' }],
  });
}

/* ---------------------------------------------------- actualizaciones (GitHub Releases)
   Cada versión se publica en GitHub (publicar-version.command) con los tres instaladores.
   La app mira la última versión al arrancar y cada pocas horas; si hay una nueva, la interfaz
   ofrece «Actualizar»: se descarga el instalador de este sistema y se instala solo.
   Windows: instalador NSIS en silencio (/S) y vuelve a abrir la app (--force-run).
   Mac: un pequeño script espera a que la app se cierre, cambia Cuaderno.app por la nueva y la abre. */
const PKG = (() => { try { return require('./package.json'); } catch (e) { return {}; } })();
const REPO = process.env.CUADERNO_REPO || PKG.cuadernoRepo || '';
const UPDATE_API = process.env.CUADERNO_UPDATE_API || (REPO ? `https://api.github.com/repos/${REPO}/releases/latest` : '');
const upd = { current: app.getVersion(), latest: null, notes: '', available: false, state: 'idle', progress: 0, error: null, checked: null, enabled: !!UPDATE_API };
let updAsset = null;
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
const assetName = () => IS_WIN ? 'Cuaderno-win-x64.exe' : IS_MAC ? `Cuaderno-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg` : null;
async function checkUpdate() {
  if (!UPDATE_API || ['downloading', 'installing'].includes(upd.state)) return upd;
  try {
    const r = await net.fetch(UPDATE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Cuaderno' } });
    if (r.status === 404) { upd.available = false; upd.error = null; upd.checked = new Date().toISOString(); return upd; }   // aún no hay versiones
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const v = String(j.tag_name || '').replace(/^v/, '');
    const a = (j.assets || []).find(x => x.name === assetName());
    updAsset = a ? a.browser_download_url : null;
    upd.latest = v; upd.notes = String(j.body || '').trim().slice(0, 800);
    const was = upd.available;
    upd.available = !!(v && updAsset && cmpVer(v, upd.current) > 0);
    upd.error = null; upd.checked = new Date().toISOString();
    if (upd.state === 'error') upd.state = 'idle';
    // desde cuándo hay versión nueva sin instalar (para avisar en «Avisos» si pasan días)
    if (upd.available) {
      let s = ajustes().updSeen;
      if (!s || s.cur !== upd.current) { s = { cur: upd.current, t: Date.now() }; setAjustes({ updSeen: s }); }
      upd.since = s.t;
    } else upd.since = null;
    // la interfaz se entera en el acto (la rueda se pone naranja sin tener que pulsarla)
    if (upd.available && !was && win && !win.isDestroyed()) win.webContents.executeJavaScript('window.cuadernoVersionCheck && window.cuadernoVersionCheck()').catch(() => {});
  } catch (e) { upd.error = 'No se ha podido comprobar si hay versiones nuevas (¿hay internet?).'; log('Actualizaciones:', e.message); }
  return upd;
}
async function download(url, dest) {
  const r = await net.fetch(url, { headers: { 'User-Agent': 'Cuaderno' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  const out = fs.createWriteStream(dest);
  const reader = r.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
    if (total) upd.progress = Math.min(99, Math.round(got * 100 / total));
  }
  await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
  if (total && got !== total) throw new Error('Descarga incompleta');
  upd.progress = 100;
}
const MAC_SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; DEST="$3"
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
MNT="$(mktemp -d)"
if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG" >/dev/null 2>&1 && [ -d "$MNT/Cuaderno.app" ]; then
  NEW="$(dirname "$DEST")/.Cuaderno-nuevo.app"
  rm -rf "$NEW"
  if ditto "$MNT/Cuaderno.app" "$NEW"; then rm -rf "$DEST" && mv "$NEW" "$DEST"; fi
  hdiutil detach "$MNT" -quiet
  xattr -cr "$DEST" 2>/dev/null
  open "$DEST"
else
  open "$DMG"
fi
`;
async function installUpdate() {
  if (['downloading', 'installing'].includes(upd.state)) return;
  if (!app.isPackaged) { upd.state = 'error'; upd.error = 'Esta copia de prueba no se puede actualizar.'; return; }   // nunca sustituir Electron en pruebas
  await checkUpdate();   // siempre la última publicada en ese momento (no la que se vio hace horas)
  if (!upd.available || !updAsset) return;
  upd.state = 'downloading'; upd.progress = 0; upd.error = null;
  try {
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuaderno-act-'));
    const file = path.join(dir, assetName());
    await download(updAsset, file);
    upd.state = 'installing';
    log('Instalando la versión', upd.latest);
    if (IS_WIN) {
      spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    } else if (IS_MAC) {
      const bundle = path.resolve(process.execPath, '..', '..', '..');
      let ok = bundle.endsWith('.app');
      try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); } catch (e) { ok = false; }
      if (!ok) {   // p. ej. abierta desde el .dmg o sin permiso: se abre el instalador para arrastrarla
        await shell.openPath(file);
        upd.state = 'manual';
        return;
      }
      const sh = path.join(dir, 'actualizar.sh');
      fs.writeFileSync(sh, MAC_SCRIPT, { mode: 0o755 });
      spawn('/bin/bash', [sh, String(process.pid), file, bundle], { detached: true, stdio: 'ignore' }).unref();
    }
    setTimeout(() => { quitting = true; app.quit(); }, 800);
  } catch (e) {
    upd.state = 'error'; upd.error = 'No se ha podido descargar la actualización. Inténtalo más tarde.';
    log('Actualizar:', e.message);
  }
}

/* -------------------------------------------------------- protocolo cuaderno://app */
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm' };
const json = (obj, code = 200) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
function fileResponse(p, type) {
  try { return new Response(fs.readFileSync(p), { headers: { 'Content-Type': type || TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' } }); }
  catch (e) { return json({}, 404); }
}
async function handle(req) {
  const u = new URL(req.url);
  const p = decodeURIComponent(u.pathname);
  const M = req.method;
  if (M === 'GET') {
    if(p==='/api/historial')return json({versions:history.list(u.searchParams.get('nota'))});
    if(p==='/api/historial/version')return json(history.get(u.searchParams.get('nota'),u.searchParams.get('version')));
    if(p==='/api/buscar'){const state=loadJSON(STATE_FILE(),{}),files=[];for(const s of state.subjects||[])for(const f of s.files||[]){const ext=String(f.ext||'').toLowerCase();if(safeId(f.id)&&['pdf','docx','txt','md','csv'].includes(ext))files.push({sid:s.id,id:f.id,name:f.name,ext,path:path.join(FILES_DIR(),f.id+'.bin')});}return json(await documentJob('search',{query:String(u.searchParams.get('q')||'').slice(0,200),files}));}
    if (p === '/api/correo/carpetas') return json({folders:await mailSuite.folders()});
    if (p === '/api/correo/mensajes') return json({mails:await mailSuite.messages(u.searchParams.get('carpeta'))});
    if (p === '/api/correo/borradores') return json({drafts:mailSuite.drafts()});
    if (p === '/api/correo/adjunto') { const a=await mailSuite.attachment(u.searchParams.get('carpeta'),u.searchParams.get('uid'),u.searchParams.get('indice'));return new Response(a.content,{headers:{'Content-Type':a.mime||'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`}}); }
    if (p === '/' || p === '/index.html' || p === '/cuaderno-apuntes.html') return fileResponse(path.join(WEB, 'cuaderno-apuntes.html'));
    if (p === '/aviso.mp3') return fileResponse(path.join(WEB, 'aviso.mp3'));
    if (p === '/avisos.mp3') return fileResponse(path.join(WEB, 'avisos.mp3'));
    if (p.startsWith('/sonidos/')) {const name=path.basename(p);if(!/^[a-z0-9-]+\.(mp3|wav)$/.test(name))return json({},404);return fileResponse(path.join(WEB,'sonidos',name),name.endsWith('.wav')?'audio/wav':'audio/mpeg');}
    if (p === '/esquemas.html') return fileResponse(path.join(WEB, 'esquemas.html'));   // pizarra de esquemas (pestaña «Esquemas»)
    if (p === '/correo-analisis.js') return fileResponse(path.join(WEB, 'correo-analisis.js'));
    if (p.startsWith('/ia/')) { const f = path.basename(p); if (!/^[\w.-]+$/.test(f)) return json({}, 404); return fileResponse(path.join(WEB, 'ia', f)); }   // IA local (worker, librería y motor)
    if (['/cuaderno.png', '/cuaderno-uv.png', '/favicon.ico'].includes(p)) return fileResponse(path.join(WEB, 'cuaderno.png'), 'image/png');
    if (p === '/api/estado') { const a = ajustes(); return json({ ok: true, app: true, configured: isConfigured(), user: a.user || null, ...status }); }
    if (p === '/api/correos') {
      const a = ajustes();
      const cache = a.user ? loadJSON(CACHE(), { mails: [] }) : { mails: [] };
      return json({ mails: cache.mails || [], configured: isConfigured(), user: a.user || null, ...status });
    }
    if (p === '/api/archivos') {
      let ids = [];
      try { ids = fs.readdirSync(FILES_DIR()).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)); } catch (e) {}
      return json({ ids });
    }
    if (p.startsWith('/api/archivo/')) {
      const id = p.split('/').pop();
      if (!safeId(id)) return json({}, 404);
      return fileResponse(path.join(FILES_DIR(), `${id}.bin`), 'application/octet-stream');
    }
    if (p === '/api/carpeta') return json({ dir: dataDir(), def: path.join(USER(), 'datos') });
    if (p === '/api/version') return json(upd);
    return json({}, 404);
  }
  if (M === 'POST') {
    try {
      if(p==='/api/word/importar'){const buffer=await req.arrayBuffer();if(buffer.byteLength>25*1024*1024)throw new Error('El documento supera los 25 MB.');return json(await documentJob('import',{buffer}));}
      if(p==='/api/word/exportar'){const d=await req.json(),result=await documentJob('export',{html:d.html,title:d.title,header:d.header,footer:d.footer});return new Response(result.buffer,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}});}
      if(p==='/api/historial/snapshot'){const d=await req.json();if(!d.note?.id)throw new Error('Falta el apunte.');history.snapshot(d.note,d.subject||{},true);return json({ok:true});}
      if (p === '/api/correo/enviar') return json(await mailSuite.send(await req.json()));
      if (p === '/api/intranet/abrir') {openIntranet();return json({ok:true});}
      if (p === '/api/intranet/olvidar') {setAjustes({intranetLogins:undefined});await session.fromPartition('persist:cuaderno-intranet').clearStorageData();if(intranetWindow&&!intranetWindow.isDestroyed())intranetWindow.reload();return json({ok:true});}
      if (p === '/api/gemini/abrir') {const d=await req.json();openGemini(d.prompt||'');return json({ok:true});}
      if (p === '/api/ortografia') {const d=await req.json();setSpellLang(d.lang);return json({results:await spelling(Array.isArray(d.words)?d.words:[],d.lang==='ca'?'ca':'es',!!d.suggest)});}
      if (p === '/api/correo/borradores') return json({draft:mailSuite.saveDraft(await req.json())});
      if (p === '/api/correo/borradores/borrar') { const d=await req.json();mailSuite.deleteDraft(d.id);return json({ok:true}); }
      if (p === '/api/cuenta') { const d = await req.json(); return json(await configure(d.user, d.password)); }
      if (p === '/api/cuenta/olvidar') { forget(); return json({ ok: true }); }
      if (p === '/api/version') return json(await checkUpdate());
      if (p === '/api/actualizar') { installUpdate(); return json({ ok: true }); }
      if (p === '/api/sincronizar') { await syncMail(); return json({ ok: !status.error, error: status.error }); }
      if (p === '/api/datos') return json({ ok: true, state: await syncState(await req.json()) });
      if (p.startsWith('/api/archivo/')) {
        const id = p.split('/').pop();
        if (!safeId(id)) return json({}, 400);
        const buf = Buffer.from(await req.arrayBuffer());
        if (!buf.length || buf.length > 200 * 1024 * 1024) return json({}, 400);
        fs.mkdirSync(FILES_DIR(), { recursive: true });
        const tmp = path.join(FILES_DIR(), `${id}.tmp`);
        fs.writeFileSync(tmp, buf); fs.renameSync(tmp, path.join(FILES_DIR(), `${id}.bin`));
        return json({ ok: true });
      }
      if (p === '/api/abrir') { const d = await req.json(); try { await openWithDefaultApp(d.id, d.name); } catch (e) { return json({ ok: false, error: e.message }); } return json({ ok: true }); }
      if (p === '/api/pdf') { const d = await req.json(); return new Response(await htmlToPdf(String(d.html || ''),d), { headers: { 'Content-Type': 'application/pdf' } }); }
      if (p === '/api/enviar') {
        const d = await req.json();
        try { await sendPdfMail(d); } catch (e) { log('Error al enviar:', e.message); return json({ ok: false, error: e.message }); }
        return json({ ok: true });
      }
      if (p === '/api/guardar') {   // guardar un archivo (p. ej. el PDF de un resumen) donde elija la persona
        const name = String(u.searchParams.get('nombre') || 'documento.pdf').replace(/[\\/:*?"<>|]+/g, '').slice(0, 150) || 'documento.pdf';
        const buf = Buffer.from(await req.arrayBuffer());
        const r = await dialog.showSaveDialog(win, { title: 'Guardar el PDF', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (r.canceled || !r.filePath) return json({ ok: false, canceled: true });
        fs.writeFileSync(r.filePath, buf);
        return json({ ok: true, path: r.filePath, folder: path.basename(path.dirname(r.filePath)) });
      }
      if (p === '/api/carpeta/abrir') {
        fs.mkdirSync(dataDir(), { recursive: true });
        const err = await shell.openPath(dataDir());
        return json({ ok: !err, error: err || undefined });
      }
      if (p === '/api/carpeta/local') {   // volver a la carpeta de este ordenador
        setAjustes({ dataDir: undefined });
        return json({ ok: true, dir: dataDir(), adopt: fs.existsSync(STATE_FILE()) });
      }
      if (p === '/api/carpeta') {
        const r = await dialog.showOpenDialog(win, {
          title: 'Carpeta de los datos del Cuaderno', buttonLabel: 'Usar esta carpeta',
          message: 'Elige la carpeta donde guardar tus apuntes.',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (r.canceled || !r.filePaths[0]) return json({ ok: false });
        let dir = r.filePaths[0];
        // Si eligen la carpeta del Cuaderno (la que contiene «datos»), se usa «datos»
        if (!fs.existsSync(path.join(dir, 'cuaderno-datos.json')) && fs.existsSync(path.join(dir, 'datos', 'cuaderno-datos.json'))) dir = path.join(dir, 'datos');
        const adopt = fs.existsSync(path.join(dir, 'cuaderno-datos.json'));
        const oldFiles = FILES_DIR();
        if (!adopt && path.resolve(dir) !== path.resolve(dataDir()) && fs.existsSync(oldFiles)) {
          try { fs.cpSync(oldFiles, path.join(dir, 'archivos'), { recursive: true, force: false }); } catch (e) { log('Copia de archivos:', e.message); }
        }
        setAjustes({ dataDir: dir });
        log('Carpeta de datos:', dir);
        return json({ ok: true, dir, adopt });
      }
    } catch (e) { log('Error en', p, e.message); return json({ ok: false, error: e.message }, 500); }
    return json({}, 404);
  }
  return json({}, 405);
}

/* ------------------------------------------------------------------- ventana */
function iconPath() { return path.join(WEB, 'cuaderno.png'); }
function createWindow(show) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520, show: false, title: 'Cuaderno',
    icon: IS_MAC ? undefined : iconPath(),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 16, y: 16 } : undefined,
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', plugins: true, spellcheck: true, contextIsolation: true, sandbox: true },
  });
  win.webContents.on('context-menu', (e, p) => contextMenu(win.webContents, p));
  win.loadURL(`${ORIGIN}/`);
  win.once('ready-to-show', () => { if (show) bringHere(); });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });   // sigue en marcha para avisos y correo
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return url.startsWith('blob:') || url === 'about:blank' ? { action: 'allow' } : { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) shell.openExternal(url); }
  });
}
// En Mac, la ventana podía quedarse en otro escritorio (Space) y parecía que la app no se abría:
// se hace visible un instante en todos los escritorios para traerla al actual, y luego se deja ahí.
function bringHere() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.show(); win.focus();
  if (IS_MAC) {
    app.focus({ steal: true });
    setTimeout(() => { if (win && !win.isDestroyed()) win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); }, 400);
  }
}
function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else bringHere();
}
function askUpdate() {
  showWindow();
  const run = () => win.webContents.executeJavaScript('window.cuadernoBuscarActualizaciones && window.cuadernoBuscarActualizaciones()').catch(() => {});
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(run, 1500)); else run();
}
function buildMenu() {
  const tpl = [
    ...(IS_MAC ? [{ label: 'Cuaderno', submenu: [
      { role: 'about', label: 'Acerca de Cuaderno' }, { label: 'Buscar actualizaciones…', click: askUpdate }, { type: 'separator' },
      { role: 'hide', label: 'Ocultar Cuaderno' }, { role: 'hideOthers', label: 'Ocultar otros' }, { role: 'unhide', label: 'Mostrar todo' },
      { type: 'separator' }, { role: 'quit', label: 'Salir de Cuaderno' }] }] : []),
    { label: 'Edición', submenu: [
      { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' },
      { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' },
      { role: 'pasteAndMatchStyle', label: 'Pegar sin formato' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
    { label: 'Visualización', submenu: [
      { role: 'reload', label: 'Recargar' }, { type: 'separator' },
      { role: 'resetZoom', label: 'Tamaño real' }, { role: 'zoomIn', label: 'Ampliar' }, { role: 'zoomOut', label: 'Reducir' },
      { type: 'separator' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] },
    { label: 'Ventana', submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'zoom', label: 'Zoom' }, { role: 'close', label: 'Cerrar ventana' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}
function buildTray() {
  if (IS_MAC) return;   // en Mac basta con el Dock
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip('Cuaderno');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Cuaderno', click: showWindow },
    { label: 'Buscar actualizaciones…', click: askUpdate },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

/* ------------------------------------------------------------------- arranque */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {});   // sigue en segundo plano
  applyDataDirArg(process.argv);
  app.whenReady().then(() => {
    // Solo el dominio de preferencias de Cuaderno; no cambia el teclado del resto del Mac.
    // Antes de crear ventanas, para que AppKit use repetición y no el selector de acentos.
    if (IS_MAC) systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
    protocol.handle(SCHEME, req => handle(req).catch(e => { log('Error:', e.message); return json({ ok: false, error: e.message }, 500); }));
    try { const st = loadJSON(STATE_FILE(), null); setSpellLang(st && st.settings && st.settings.lang); } catch (e) { setSpellLang('es'); }
    buildMenu();
    buildTray();
    // Arrancar con el ordenador (sin abrir la ventana)
    let hidden = process.argv.includes('--oculto');
    if (app.isPackaged && !process.env.CUADERNO_PRUEBA) {
      try {
        if (IS_MAC) { hidden = hidden || app.getLoginItemSettings().wasOpenedAtLogin; app.setLoginItemSettings({ openAtLogin: true }); }
        else app.setLoginItemSettings({ openAtLogin: true, args: ['--oculto'] });
      } catch (e) { log('Inicio automático:', e.message); }
    }
    createWindow(!hidden);
    setTimeout(syncMail, 1500);
    setInterval(syncMail, INTERVAL_MIN * 60 * 1000);
    setTimeout(checkUpdate, 8000);
    setInterval(checkUpdate, 30 * 60 * 1000);   // cada media hora mira si hay versión nueva en GitHub
    setTimeout(rotatingBackup, 60 * 1000);
    setInterval(rotatingBackup, 5 * 60 * 1000);   // dos copias que se turnan cada 5 minutos (copias-seguridad/copia-A y copia-B)
    log('Cuaderno', app.getVersion(), 'iniciado. Datos en', dataDir());
  });
}
