/* Trabajos en grupo (BETA, 16-11-2026).
   Cada trabajo se guarda en el BUZÓN de Cuaderno (Cloudflare Worker, escritorio/buzon-worker.js; dirección en
   package.json → cuadernoBuzon) o, en los primeros trabajos de la beta, en una carpeta compartida. Todo va cifrado
   (AES-256-GCM) con la clave del código de invitación: fuera de la app no se puede leer ni editar.
     trabajo.cdz              ficha del trabajo (solo la escribe el dueño): nombre, dueño, personas aceptadas
     personas/<id>.cdz        cada persona escribe solo la suya: nombre, avatar, ordenador, última visita y envío
     documento/<id>.cdz       estado Yjs completo del documento según esa persona (se mezclan todos al recibir)
   Nadie escribe el archivo de otro, así Drive nunca tiene que elegir entre dos versiones del mismo archivo.
   En este ordenador (userData/trabajos/<id>/) quedan el borrador, lo último enviado y copias de cada envío. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

module.exports = function ({ settings, save: save0, safeStorage, userDir, log, dialog, shell, window, json, buzon, sharedDir, person }) {
  // cada vez que cambia tu lista de trabajos se deja también en tu carpeta sincronizada (ver «Tus trabajos en todos…»)
  const save = patch => { const r = save0(patch); if (patch && patch.trabajos) setTimeout(publishMine, 0); return r; };
  const BUZON = () => String(process.env.CUADERNO_BUZON || buzon || '').replace(/\/+$/, '');
  const MAGIC = Buffer.from('CDZ1');
  const DEVICE = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const PREFIX = 'CUADERNO-TRABAJO-';
  const myId = () => { let a = settings(); if (!a.instanceId) a = save({ instanceId: crypto.randomUUID() }); return a.instanceId; };
  const list = () => settings().trabajos || [];
  const find = id => list().find(t => t.id === id);
  const safe = id => typeof id === 'string' && /^[\w-]{6,64}$/.test(id);

  const storeKey = key => safeStorage.isEncryptionAvailable()
    ? { keyEnc: safeStorage.encryptString(key.toString('base64')).toString('base64') } : { key: key.toString('base64') };
  const keyOf = t => Buffer.from(t.keyEnc ? safeStorage.decryptString(Buffer.from(t.keyEnc, 'base64')) : t.key, 'base64');
  function enc(key, obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
  }
  function dec(key, buf) {
    if (!buf || buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('formato');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16)); d.setAuthTag(buf.subarray(16, 32));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString('utf8'));
  }
  // Adjuntos (imágenes, PDF…): archivos/<fid>.cdz = cifrado de [4 bytes largo][ficha JSON][contenido]
  function encFile(key, meta, bytes) { const m = Buffer.from(JSON.stringify(meta)), len = Buffer.alloc(4); len.writeUInt32BE(m.length); return enc0(key, Buffer.concat([len, m, bytes])); }
  function decFile(key, buf) { const raw = dec0(key, buf), n = raw.readUInt32BE(0); return { meta: JSON.parse(raw.subarray(4, 4 + n).toString('utf8')), bytes: raw.subarray(4 + n) }; }
  function enc0(key, plain) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(plain), c.final()]); return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]); }
  function dec0(key, buf) {
    if (!buf || buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('formato');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16)); d.setAuthTag(buf.subarray(16, 32)); return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
  }
  const readEnc = (key, file) => { try { return dec(key, fs.readFileSync(file)); } catch (e) { return null; } };
  function writeAtomic(file, buf) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
  }
  // Dónde viven los archivos de un trabajo: carpeta (t.dir) o buzón (t.buzon). Misma interfaz, siempre asíncrona.
  const tokenOf = t => crypto.createHash('sha256').update(keyOf(t)).update(':cuaderno-buzon').digest('hex');   // el buzón solo ve su huella
  function store(t) {
    if (t.buzon) {
      const base = t.buzon + '/t/' + t.id + '/', auth = { Authorization: 'Bearer ' + tokenOf(t) };
      const call = async (rel, opt = {}) => {
        let r; try { r = await fetch(base + rel, { ...opt, headers: { ...auth, ...(opt.headers || {}) }, signal: AbortSignal.timeout(30000) }); }
        catch (e) { throw new Error('No hay conexión con el buzón de Cuaderno. Comprueba internet y vuelve a intentarlo.'); }
        return r;
      };
      return {
        kind: 'buzon',
        async get(rel) { const r = await call(rel); if (r.status === 404) return null; if (!r.ok) throw new Error('El buzón no responde (' + r.status + ').'); return Buffer.from(await r.arrayBuffer()); },
        async put(rel, buf) { const r = await call(rel, { method: 'PUT', body: buf }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'El buzón no ha guardado el archivo (' + r.status + ').'); },
        async list(folder) { const r = await call('lista?carpeta=' + encodeURIComponent(folder + '/')); if (!r.ok) return []; return ((await r.json()).files || []).map(f => ({ name: f.name.slice(folder.length + 1), mtime: f.mtime })); },
      };
    }
    const full = rel => path.join(t.dir, ...rel.split('/'));
    return {
      kind: 'carpeta',
      async get(rel) { try { return fs.readFileSync(full(rel)); } catch (e) { return null; } },
      async put(rel, buf) { writeAtomic(full(rel), buf); },
      async list(folder) { try { return fs.readdirSync(full(folder)).filter(n => n.endsWith('.cdz')).map(n => ({ name: n, mtime: mtime(path.join(full(folder), n)) })); } catch (e) { return []; } },
    };
  }
  const getEnc = async (t, rel) => { try { return dec(keyOf(t), await store(t).get(rel)); } catch (e) { return null; } };
  const putEnc = (t, rel, obj) => store(t).put(rel, enc(keyOf(t), obj));
  const localDir = id => path.join(userDir(), 'trabajos', id);
  const readLocal = id => { try { return JSON.parse(fs.readFileSync(path.join(localDir(id), 'local.json'), 'utf8')); } catch (e) { return {}; } };
  const writeLocal = (id, patch) => { const l = { ...readLocal(id), ...patch }; writeAtomic(path.join(localDir(id), 'local.json'), Buffer.from(JSON.stringify(l))); return l; };
  const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
  const cleanPerson = (p = {}) => ({
    name: String(p.name || '').trim().slice(0, 60) || 'Sin nombre',
    photo: typeof p.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.photo) && p.photo.length < 120000 ? p.photo : '',
  });
  async function writePerson(t, person, extra = {}) {
    const rel = 'personas/' + myId() + '.cdz', old = (await getEnc(t, rel)) || { joined: Date.now() };
    await putEnc(t, rel, { ...old, ...cleanPerson(person), id: myId(), device: DEVICE, seen: Date.now(), ...extra });
  }
  async function writeMeta(t, meta) { await putEnc(t, 'trabajo.cdz', meta); writeLocal(t.id, { meta }); }

  async function summary(t) {
    const me = myId(), local = readLocal(t.id), st = store(t);
    let meta = null, reachable = true;
    try { const raw = await st.get('trabajo.cdz'); meta = raw ? dec(keyOf(t), raw) : null; } catch (e) { reachable = false; }
    const folderOk = !!meta && (st.kind === 'buzon' || fs.existsSync(t.dir));
    const info = meta || local.meta || { name: t.name, owner: t.owner, accepted: [t.owner], refused: [] };
    const accepted = new Set(info.accepted || []), refused = new Set(info.refused || []);
    let people = [], docs = {};
    if (reachable) try {
      const [pl, dl] = await Promise.all([st.list('personas'), st.list('documento')]);
      for (const d of dl) docs[d.name.replace(/\.cdz$/, '')] = d.mtime;
      people = (await Promise.all(pl.map(f => getEnc(t, 'personas/' + f.name)))).filter(p => p && safe(p.id));
    } catch (e) { reachable = false; }
    const received = local.received || {};
    const members = people.filter(p => !refused.has(p.id)).map(p => ({
      id: p.id, name: p.name, photo: p.photo || '', device: p.device || '', seen: p.seen || 0, sent: p.sent || 0,
      me: p.id === me, owner: p.id === info.owner, accepted: accepted.has(p.id),
      news: p.id !== me && accepted.has(p.id) && (docs[p.id] || 0) > (received[p.id] || 0),
    })).sort((a, b) => (b.owner - a.owner) || (a.accepted === b.accepted ? (a.name || '').localeCompare(b.name || '') : b.accepted - a.accepted));
    return {
      id: t.id, name: info.name || t.name, subject: t.subject || '', subjectHint: info.subjectHint || '', where: t.buzon ? 'buzon' : 'carpeta', folder: t.dir ? path.basename(t.dir) : '', isOwner: info.owner === me, ownerName: info.ownerName || '', folderOk, offline: !reachable, docTimes: docs,
      accepted: accepted.has(me), members, news: members.some(m => m.news), sentAt: local.sentAt || 0,
      hasDraft: typeof local.html === 'string',
    };
  }
  async function pickFolder(title, message, envVar) {
    if (process.env.CUADERNO_PRUEBA && process.env[envVar]) return process.env[envVar];   // pruebas sin diálogo
    const r = await dialog.showOpenDialog(window(), { title, message, buttonLabel: 'Elegir', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }
  // Código corto de invitación (p. ej. K7PQ-4MZR-9TXA, 60 bits): el buzón guarda en /i/<huella> la invitación larga
  // cifrada con una clave que sale del propio código (scrypt). El buzón no ve ni el código ni la clave del trabajo.
  const ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const normShort = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const isShort = c => { const n = normShort(c); return n.length === 12 && [...n].every(ch => ABC.includes(ch)); };
  const newShort = () => { const b = crypto.randomBytes(12); return [...b].map(x => ABC[x % 32]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
  const shortLookup = c => crypto.createHash('sha256').update('cuaderno-inv:' + normShort(c)).digest('hex');
  const shortKey = c => crypto.scryptSync(normShort(c), 'cuaderno-invitacion-v1', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  async function buzonFetch(url, opt = {}) {
    try { return await fetch(url, { ...opt, signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Error('No hay conexión con el buzón de Cuaderno. Comprueba internet y vuelve a intentarlo.'); }
  }
  async function shortFor(t) {   // el mismo código mientras dure el trabajo (se guarda cifrado en este ordenador)
    const saved = t.invEnc ? (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(t.invEnc, 'base64')) : t.invEnc) : null;
    if (saved) return saved;
    const code = newShort(), inv = { v: 1, id: t.id, name: (await summary(t)).name, k: keyOf(t).toString('base64'), b: t.buzon };
    const r = await buzonFetch(t.buzon + '/i/' + shortLookup(code), { method: 'PUT', body: enc(shortKey(code), inv) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'El buzón no ha guardado la invitación.');
    const invEnc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(code).toString('base64') : code;
    save({ trabajos: list().map(x => x.id === t.id ? { ...x, invEnc } : x) });
    return code;
  }
  async function openShort(code) {
    const base = BUZON(); if (!base) throw new Error('Esta copia de Cuaderno no tiene buzón configurado.');
    const r = await buzonFetch(base + '/i/' + shortLookup(code));
    if (r.status === 404) throw new Error('No encuentro ese código. Revísalo; si te lo acaban de pasar, espera un minuto y vuelve a probar.');
    if (!r.ok) throw new Error('El buzón no responde (' + r.status + ').');
    try { return dec(shortKey(code), Buffer.from(await r.arrayBuffer())); } catch (e) { throw new Error('Ese código no es válido.'); }
  }
  const parseCode = code => {
    const raw = String(code || '').trim().replace(/\s+/g, ''); if (!raw.startsWith(PREFIX)) throw new Error('Ese código no es una invitación de Cuaderno.');
    const d = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (d.v !== 1 || !safe(d.id) || !d.k) throw new Error('La invitación está incompleta.');
    return d;
  };

  /* Tus trabajos en todos tus ordenadores (17-11-2026, regla de Jano). Si la carpeta de datos es una carpeta tuya
     sincronizada (Drive, iCloud…), cada ordenador deja ahí SU lista en `trabajos-mios/<id del ordenador>.json` (nadie
     escribe el archivo de otro, como en el resto de trabajos). Los demás ordenadores se unen solos, igual que con el
     código, y el ordenador que creó el trabajo acepta solo a tus otros ordenadores. Si sales de un trabajo en un
     ordenador, ese ordenador no vuelve a entrar solo («left»). Solo trabajos del buzón (los de carpeta dependen de una
     ruta de cada ordenador). La clave del trabajo queda en tu carpeta (es tuya); quien no usa una carpeta propia
     (compañeros con la carpeta local) sigue exactamente igual que antes. */
  const mineDir = () => { const d = sharedDir && sharedDir(); return d ? path.join(d, 'trabajos-mios') : null; };
  const readJSON = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  function publishMine() {
    const dir = mineDir(); if (!dir) return;
    try {
      const me = myId(), f = path.join(dir, me + '.json'), old = readJSON(f) || {};
      const out = { v: 1, device: me, name: DEVICE, left: old.left || [],
        trabajos: list().filter(t => t.buzon).map(t => ({ id: t.id, name: t.name, b: t.buzon, k: keyOf(t).toString('base64'), subject: t.subject || '', owner: t.owner || '' })) };
      if (JSON.stringify({ ...old, updated: 0 }) === JSON.stringify({ ...out, updated: 0 })) return;
      writeAtomic(f, Buffer.from(JSON.stringify({ ...out, updated: Date.now() })));
    } catch (e) { log('Trabajos en Drive:', e.message); }
  }
  function markLeft(id) {
    const dir = mineDir(); if (!dir) return;
    try {
      const f = path.join(dir, myId() + '.json'), o = readJSON(f) || { v: 1, device: myId(), name: DEVICE, trabajos: [] };
      o.left = [...new Set([...(o.left || []), id])]; o.trabajos = (o.trabajos || []).filter(x => x.id !== id); o.updated = Date.now();
      writeAtomic(f, Buffer.from(JSON.stringify(o)));
    } catch (e) { log('Trabajos en Drive:', e.message); }
  }
  let syncing = null;
  function syncMine() {
    const dir = mineDir(); if (!dir) return Promise.resolve();
    if (syncing) return syncing;
    syncing = (async () => {
      const me = myId(), others = [];
      try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.json') && n !== me + '.json') { const o = readJSON(path.join(dir, n)); if (o && o.v === 1 && safe(o.device) && o.device !== me) others.push(o); } } catch (e) { /* aún no hay carpeta */ }
      const left = new Set((readJSON(path.join(dir, me + '.json')) || {}).left || []);
      // 1) unirse solo a los trabajos de tus otros ordenadores (mismo camino que «Unirme con un código»)
      for (const o of others) for (const inv of o.trabajos || []) {
        if (!safe(inv.id) || !inv.k || !inv.b || find(inv.id) || left.has(inv.id)) continue;
        if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(inv.b) && !(process.env.CUADERNO_PRUEBA && /^http:\/\/127\.0\.0\.1:\d+$/.test(inv.b))) continue;
        try {
          const t2 = { id: inv.id, name: inv.name, buzon: inv.b, subject: String(inv.subject || '').slice(0, 64), ...storeKey(Buffer.from(inv.k, 'base64')) };
          const meta = await getEnc(t2, 'trabajo.cdz'); if (!meta || meta.id !== inv.id) continue;
          t2.name = meta.name; t2.owner = meta.owner;
          writeLocal(inv.id, { meta }); await writePerson(t2, person ? person() : {});
          save({ trabajos: [...list(), t2] });
          log('Trabajo en grupo traído de tu otro ordenador:', meta.name);
        } catch (e) { log('Trabajos en Drive:', e.message); }
      }
      // 2) en los trabajos que creaste en este ordenador, tus otros ordenadores quedan aceptados sin preguntarte
      const mine = others.map(o => o.device);
      if (mine.length) for (const t of list().filter(t => t.buzon && t.owner === me)) {
        try {
          const meta = await getEnc(t, 'trabajo.cdz'); if (!meta || meta.owner !== me) continue;
          const add = mine.filter(d => !(meta.accepted || []).includes(d)); if (!add.length) continue;
          meta.accepted = [...(meta.accepted || []), ...add]; meta.refused = (meta.refused || []).filter(x => !add.includes(x));
          await writeMeta(t, meta);
        } catch (e) { log('Trabajos en Drive:', e.message); }
      }
      publishMine();
    })().finally(() => { syncing = null; });
    return syncing;
  }

  // Lista común de documentos del grupo: lo aportado por todos menos lo quitado por cualquiera después
  async function groupDocs(t) {
    const files = await store(t).list('docs').catch(() => []);
    const lists = (await Promise.all(files.map(f => getEnc(t, 'docs/' + f.name).then(x => x && { by: f.name.replace(/\.cdz$/, ''), ...x })))).filter(Boolean);
    const added = new Map(), removed = {};
    for (const l of lists) {
      for (const x of l.added || []) if (x && safe(x.fid) && (!added.has(x.fid) || added.get(x.fid).at < x.at)) added.set(x.fid, { ...x, by: l.by });
      for (const [fid, at] of Object.entries(l.removed || {})) removed[fid] = Math.max(removed[fid] || 0, at || 0);
    }
    return [...added.values()].filter(x => !(removed[x.fid] >= x.at)).sort((a, b) => b.at - a.at);
  }

  async function handle(p, M, req, u) {
    if (!p.startsWith('/api/trabajos')) return null;
    try {
      if (M === 'GET' && p === '/api/trabajos') await syncMine().catch(() => {});   // trae los de tus otros ordenadores
      if (M === 'GET' && p === '/api/trabajos') return json({ me: myId(), device: DEVICE, buzon: !!BUZON(), trabajos: await Promise.all(list().map(t => summary(t).catch(e => ({ id: t.id, name: t.name, folderOk: false, members: [], error: e.message })))) });
      const id = u.searchParams.get('id'), t = id && find(id);
      if (M === 'GET' && p === '/api/trabajos/estado') {
        if (!t) return json({ error: 'No encuentro ese trabajo.' }, 404);
        const s = await summary(t), states = [], received = {};
        if (s.offline) throw new Error('No hay conexión con el buzón de Cuaderno. Tu borrador está guardado; vuelve a intentarlo con internet.');
        await Promise.all(s.members.filter(m => m.accepted || m.me).map(async m => {
          const d = await getEnc(t, 'documento/' + m.id + '.cdz');
          if (d && typeof d.state === 'string') { states.push(d.state); received[m.id] = s.docTimes[m.id] || 0; }
        }));
        const local = readLocal(t.id);
        return json({ summary: s, states, received, local: { state: local.state || null, html: typeof local.html === 'string' ? local.html : null, sentHtml: local.sentHtml ?? null } });
      }
      if (M === 'GET' && p === '/api/trabajos/invitacion') {
        if (!t) return json({ error: 'No encuentro ese trabajo.' }, 404);
        const name = (await summary(t)).name, inv = { v: 1, id: t.id, name, k: keyOf(t).toString('base64') }; if (t.buzon) inv.b = t.buzon;
        const long = PREFIX + Buffer.from(JSON.stringify(inv)).toString('base64url');
        return json({ code: t.buzon ? await shortFor(t) : long, long, where: t.buzon ? 'buzon' : 'carpeta' });
      }
      if (M === 'GET' && p === '/api/trabajos/archivo') {
        const fid = u.searchParams.get('fid'); if (!t || !safe(fid)) return json({}, 404);
        try { const { meta, bytes } = decFile(keyOf(t), await store(t).get('archivos/' + fid + '.cdz')); return new Response(bytes, { headers: { 'Content-Type': meta.type || 'application/octet-stream', 'Cache-Control': 'no-store' } }); }
        catch (e) { return json({}, 404); }
      }
      if (M === 'POST' && p === '/api/trabajos/archivo') {   // el cuerpo es el archivo tal cual
        const fid = u.searchParams.get('fid'); if (!t || !safe(fid)) return json({ error: 'Adjunto no válido.' }, 400);
        const bytes = Buffer.from(await req.arrayBuffer()); if (bytes.length > 25 * 1024 * 1024) throw new Error('El archivo supera los 25 MB.');
        const meta = { name: String(u.searchParams.get('nombre') || 'archivo').slice(0, 160), type: String(u.searchParams.get('tipo') || '').slice(0, 100), size: bytes.length, by: myId(), at: Date.now() };
        await store(t).put('archivos/' + fid + '.cdz', encFile(keyOf(t), meta, bytes));
        return json({ ok: true });
      }
      /* Documentos del grupo (17-11-2026): cada persona escribe solo su lista `docs/<su id>.cdz`
         = { added: [{ fid, name, type, size, at, note }], removed: { fid: hora } }. Lo que se ve es la suma de todo lo
         aportado menos lo que CUALQUIERA haya quitado después (todos pueden quitar). El archivo cifrado sigue en
         `archivos/<fid>.cdz` (el buzón no borra), así que quitar es reversible. */
      if (M === 'GET' && p === '/api/trabajos/documentos') {
        if (!t) return json({ error: 'No encuentro ese trabajo.' }, 404);
        return json({ docs: await groupDocs(t) });
      }
      if (M === 'POST' && p === '/api/trabajos/documentos/aportar') {   // el cuerpo es el archivo tal cual
        const fid = u.searchParams.get('fid'); if (!t || !safe(fid)) return json({ error: 'Documento no válido.' }, 400);
        const bytes = Buffer.from(await req.arrayBuffer()); if (!bytes.length) throw new Error('El archivo está vacío.');
        if (bytes.length > 25 * 1024 * 1024) throw new Error('El archivo supera los 25 MB.');
        const doc = { fid, name: String(u.searchParams.get('nombre') || 'documento').slice(0, 160), type: String(u.searchParams.get('tipo') || '').slice(0, 100), size: bytes.length, at: Date.now(), note: String(u.searchParams.get('nota') || '').slice(0, 200) };
        await store(t).put('archivos/' + fid + '.cdz', encFile(keyOf(t), { name: doc.name, type: doc.type, size: doc.size, by: myId(), at: doc.at }, bytes));
        const mine = (await getEnc(t, 'docs/' + myId() + '.cdz')) || { added: [], removed: {} };
        mine.added = [...(mine.added || []).filter(x => x.fid !== fid), doc]; delete (mine.removed || {})[fid];
        await putEnc(t, 'docs/' + myId() + '.cdz', mine);
        return json({ ok: true, docs: await groupDocs(t) });
      }
      if (M !== 'POST') return json({}, 404);
      const d = await req.json().catch(() => ({}));
      if (p === '/api/trabajos/crear') {
        const name = String(d.name || '').trim().slice(0, 80); if (!name) throw new Error('Ponle un nombre al trabajo.');
        const key = crypto.randomBytes(32), tid = crypto.randomUUID(), me = myId();
        let t2;
        if (BUZON() && !d.carpeta) t2 = { id: tid, name, buzon: BUZON(), owner: me, ...storeKey(key) };   // lo normal: sin carpetas ni Drive
        else {
          const parent = await pickFolder('¿Dónde creo la carpeta del trabajo?', 'Elige una carpeta de Google Drive u OneDrive para poder compartirla con tu grupo.', 'CUADERNO_TRABAJOS_DIR');
          if (!parent) return json({ ok: false });
          const folderName = (name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'Trabajo') + ' · Cuaderno';
          let dir = path.join(parent, folderName), n = 2; while (fs.existsSync(dir)) dir = path.join(parent, folderName + ' ' + n++);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'LEEME.txt'), 'Carpeta de un trabajo en grupo de Cuaderno (beta).\r\nLos archivos van cifrados: ábrelo desde la app (Trabajos en grupo).\r\nNo los muevas ni los borres.\r\n');
          t2 = { id: tid, name, dir, owner: me, ...storeKey(key) };
        }
        t2.subject = String(d.subject || '').slice(0, 64);   // asignatura en TUS datos (cada persona elige la suya)
        await writeMeta(t2, { id: tid, name, owner: me, ownerName: cleanPerson(d.person).name, subjectHint: String(d.subjectShort || '').slice(0, 20), created: Date.now(), accepted: [me], refused: [] });   // registra la llave en el buzón
        await writePerson(t2, d.person);
        save({ trabajos: [...list(), t2] });
        log('Trabajo en grupo creado:', name);
        return json({ ok: true, id: tid });
      }
      if (p === '/api/trabajos/unirse') {
        const inv = isShort(d.code) ? await openShort(d.code) : parseCode(d.code);
        if (inv.v !== 1 || !safe(inv.id) || !inv.k) throw new Error('La invitación está incompleta.');
        if (find(inv.id)) return json({ ok: true, id: inv.id, already: true });
        const key = Buffer.from(inv.k, 'base64');
        if (inv.b) {   // trabajo en el buzón: basta con el código
          if (!/^https:\/\/[\w.-]+(:\d+)?$/.test(inv.b) && !(process.env.CUADERNO_PRUEBA && /^http:\/\/127\.0\.0\.1:\d+$/.test(inv.b))) throw new Error('La invitación apunta a un buzón no válido.');
          const t2 = { id: inv.id, name: inv.name, buzon: inv.b, subject: String(d.subject || '').slice(0, 64), ...storeKey(key) };
          const meta = await getEnc(t2, 'trabajo.cdz');
          if (!meta || meta.id !== inv.id) throw new Error('No encuentro el trabajo «' + (inv.name || '') + '» en el buzón. Comprueba el código y tu conexión.');
          t2.name = meta.name; t2.owner = meta.owner;
          writeLocal(inv.id, { meta }); await writePerson(t2, d.person);
          save({ trabajos: [...list(), t2] });
          log('Unido al trabajo en grupo:', meta.name); return json({ ok: true, id: inv.id });
        }
        let dir = await pickFolder('Carpeta del trabajo «' + (inv.name || '') + '»', 'Elige la carpeta compartida del trabajo (la que te han compartido en Drive).', 'CUADERNO_UNIRSE_DIR');
        if (!dir) return json({ ok: false });
        if (!fs.existsSync(path.join(dir, 'trabajo.cdz'))) {   // quizá eligió la carpeta de arriba
          const sub = fs.readdirSync(dir).map(n => path.join(dir, n)).find(x => fs.existsSync(path.join(x, 'trabajo.cdz')) && readEnc(key, path.join(x, 'trabajo.cdz'))?.id === inv.id);
          if (sub) dir = sub;
        }
        const meta = readEnc(key, path.join(dir, 'trabajo.cdz'));
        if (!meta || meta.id !== inv.id) throw new Error('Esa carpeta no es la del trabajo «' + (inv.name || '') + '». Comprueba que te la han compartido y que Drive ya la ha descargado.');
        const t2 = { id: inv.id, name: meta.name, dir, owner: meta.owner, subject: String(d.subject || '').slice(0, 64), ...storeKey(key) };
        save({ trabajos: [...list(), t2] });
        writeLocal(inv.id, { meta });
        await writePerson(t2, d.person);
        log('Unido al trabajo en grupo:', meta.name);
        return json({ ok: true, id: inv.id });
      }
      const t3 = find(d.id);
      if (!t3) return json({ error: 'No encuentro ese trabajo.' }, 404);
      if (p === '/api/trabajos/visto') {
        const mine = await getEnc(t3, 'personas/' + myId() + '.cdz');
        if (!mine || Date.now() - (mine.seen || 0) > 60000 || d.force) await writePerson(t3, d.person);
        return json({ ok: true });
      }
      if (p === '/api/trabajos/borrador') {
        const patch = { html: String(d.html ?? '') }; if (typeof d.state === 'string') patch.state = d.state;
        writeLocal(t3.id, patch); return json({ ok: true });
      }
      if (p === '/api/trabajos/enviar') {
        if (typeof d.state !== 'string' || typeof d.html !== 'string') throw new Error('Faltan los datos del documento.');
        const now = Date.now();
        await putEnc(t3, 'documento/' + myId() + '.cdz', { state: d.state, at: now });
        await writePerson(t3, d.person, { sent: now });
        writeLocal(t3.id, { state: d.state, html: d.html, sentHtml: d.sentKey ?? d.html, sentAt: now, received: d.received || {} });
        // Copia en este ordenador, fuera de la carpeta compartida (se guardan las 40 últimas)
        const cdir = path.join(localDir(t3.id), 'copias'); fs.mkdirSync(cdir, { recursive: true });
        fs.writeFileSync(path.join(cdir, new Date(now).toISOString().replace(/[:.]/g, '-') + '.json'), JSON.stringify({ state: d.state, html: d.html, at: now }));
        const old = fs.readdirSync(cdir).filter(f => f.endsWith('.json')).sort(); for (const f of old.slice(0, Math.max(0, old.length - 40))) fs.rmSync(path.join(cdir, f), { force: true });
        return json({ ok: true, summary: await summary(t3) });
      }
      if (p === '/api/trabajos/aceptar') {
        const s = await summary(t3); if (!s.isOwner) throw new Error('Solo quien creó el trabajo puede aceptar a otras personas.');
        const meta = (await getEnc(t3, 'trabajo.cdz')) || readLocal(t3.id).meta; if (!meta) throw new Error('No puedo leer la ficha del trabajo.');
        if (!safe(d.member) || d.member === meta.owner) throw new Error('Persona no válida.');
        meta.accepted = (meta.accepted || []).filter(x => x !== d.member); meta.refused = (meta.refused || []).filter(x => x !== d.member);
        (d.accept ? meta.accepted : meta.refused).push(d.member);
        await writeMeta(t3, meta); return json({ ok: true, summary: await summary(t3) });
      }
      if (p === '/api/trabajos/restaurar') {   // el dueño rehace la carpeta compartida con lo que guarda este ordenador
        const local = readLocal(t3.id); if (t3.owner !== myId() || !local.meta) throw new Error('Solo quien creó el trabajo puede restaurarlo.');
        if (t3.dir) fs.mkdirSync(t3.dir, { recursive: true });
        await writeMeta(t3, local.meta); await writePerson(t3, d.person);
        if (local.state) await putEnc(t3, 'documento/' + myId() + '.cdz', { state: local.state, at: Date.now() });
        log('Trabajo en grupo restaurado:', local.meta.name); return json({ ok: true, summary: await summary(t3) });
      }
      if (p === '/api/trabajos/abrir') {   // abre un adjunto con su programa (copia descifrada en este ordenador)
        if (!safe(d.fid)) throw new Error('Adjunto no válido.');
        const { meta, bytes } = decFile(keyOf(t3), await store(t3).get('archivos/' + d.fid + '.cdz'));
        const out = path.join(localDir(t3.id), 'abiertos', d.fid, meta.name.replace(/[\\/:*?"<>|]+/g, '_') || 'archivo');
        fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, bytes);
        if (process.env.CUADERNO_PRUEBA) return json({ ok: true, name: meta.name });
        const err = await shell.openPath(out); return json({ ok: !err, error: err || undefined });
      }
      if (p === '/api/trabajos/mostrar') { if (process.env.CUADERNO_PRUEBA || !t3.dir) return json({ ok: true }); const err = await shell.openPath(t3.dir); return json({ ok: !err, error: err || undefined }); }
      if (p === '/api/trabajos/documentos/quitar') {   // cualquiera del grupo puede quitar cualquier documento
        if (!safe(d.fid)) throw new Error('Documento no válido.');
        const mine = (await getEnc(t3, 'docs/' + myId() + '.cdz')) || { added: [], removed: {} };
        mine.removed = { ...(mine.removed || {}), [d.fid]: Date.now() };
        await putEnc(t3, 'docs/' + myId() + '.cdz', mine);
        return json({ ok: true, docs: await groupDocs(t3) });
      }
      if (p === '/api/trabajos/asignatura') { save({ trabajos: list().map(x => x.id === t3.id ? { ...x, subject: String(d.subject || '').slice(0, 64) } : x) }); return json({ ok: true }); }
      if (p === '/api/trabajos/salir') { markLeft(t3.id); save({ trabajos: list().filter(x => x.id !== t3.id) }); return json({ ok: true }); }
      return json({}, 404);
    } catch (e) { log('Trabajos en grupo:', e.message); return json({ error: e.message }, 400); }
  }
  return { handle, syncMine };
};
