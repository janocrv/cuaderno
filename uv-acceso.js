'use strict';
// Local OS-encrypted vault, accessible only to the UV window's main frame.
module.exports = ({settings,save,safeStorage,contents,now=Date.now}) => {
  const pending=new Map();
  function kind(u){if(u.protocol!=='https:'||u.port||u.username||u.password)return null;if(u.hostname==='as.uv.es'&&u.pathname==='/cgi-bin/AuthServer'||u.hostname==='portal.uv.es'&&u.pathname==='/cgi-bin/portal/portal')return 'uv';if(u.hostname==='aulavirtual.uv.es'&&u.pathname==='/login/index.php')return 'moodle';return null;}
  function frame(e){try{const wc=contents();if(!wc||wc.isDestroyed()||e.sender!==wc||e.senderFrame!==wc.mainFrame)return null;return {wc,u:new URL(e.senderFrame.url)};}catch(_){return null;}}
  function record(k){const a=settings();return a.uvAccess?.[k]||(k==='uv'?(a.intranetLogins?.['https://as.uv.es']||a.intranetLogins?.['https://portal.uv.es']):null);}
  function discard(id){const p=pending.get(id);if(p)clearTimeout(p.timer);pending.delete(id);}
  function read(e){const f=frame(e),k=f&&kind(f.u);if(!k||!safeStorage.isEncryptionAvailable())return null;const r=record(k);try{return r?.pw?{user:r.user,password:safeStorage.decryptString(Buffer.from(r.pw,'base64'))}:null;}catch(_){return null;}}
  function stage(e,d){const f=frame(e),k=f&&kind(f.u);if(!k||d?.origin!==f.u.origin||!safeStorage.isEncryptionAvailable()||typeof d.user!=='string'||typeof d.password!=='string'||!d.user.trim()||!d.password||d.user.length>200||d.password.length>1000)return false;try{const pw=safeStorage.encryptString(d.password).toString('base64');discard(f.wc.id);const timer=setTimeout(()=>discard(f.wc.id),120000);timer.unref?.();pending.set(f.wc.id,{kind:k,user:d.user.trim(),pw,created:now(),timer});return true;}catch(_){return false;}}
  function success(e){const f=frame(e);if(!f||f.u.protocol!=='https:'||f.u.port)return false;const protectedPage=(f.u.hostname==='portal.uv.es'&&f.u.pathname==='/cgi-bin/portal/portal')||(f.u.hostname==='aulavirtual.uv.es'&&!/^\/(?:login|auth)(?:\/|$)/.test(f.u.pathname));const p=pending.get(f.wc.id);if(!protectedPage||!p||now()-p.created>120000)return false;save({uvAccess:{...(settings().uvAccess||{}),[p.kind]:{user:p.user,pw:p.pw,savedAt:now()}}});discard(f.wc.id);return true;}
  return {read,stage,success,discard,failed(e){const f=frame(e);if(f&&kind(f.u))discard(f.wc.id);},clear(){for(const id of pending.keys())discard(id);save({uvAccess:undefined,intranetLogins:undefined});},status(){return {saved:!!record('uv')?.pw,moodleSaved:!!record('moodle')?.pw};}};
};
