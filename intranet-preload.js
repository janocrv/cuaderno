'use strict';
// Isolated preload: never exposes Node, IPC or a credential bridge to page scripts.
const {ipcRenderer}=require('electron');
if(window.top===window&&location.protocol==='https:'&&['as.uv.es','portal.uv.es','aulavirtual.uv.es'].includes(location.hostname)) {
  const loginPage=(location.hostname==='as.uv.es'&&location.pathname==='/cgi-bin/AuthServer')||(location.hostname==='portal.uv.es'&&location.pathname==='/cgi-bin/portal/portal')||(location.hostname==='aulavirtual.uv.es'&&location.pathname==='/login/index.php');
  let savedPromise,scheduled=false,reported=false,routed=false,gestureAt=0;
  const filled=new WeakSet(),errors=new WeakSet();
  const visible=el=>el&&!el.disabled&&el.getClientRects().length>0;
  function fields(){
    const passwords=[...document.querySelectorAll('input[type="password"]')].filter(visible);if(passwords.length!==1)return null;
    const pw=passwords[0],form=pw.form;if(!form||pw.autocomplete==='new-password'||/new|confirm|repeat|oldpass|password2/i.test(pw.name))return null;
    const user=[...form.querySelectorAll('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="usu" i],input[name*="login" i],input[type="text"],input:not([type])')].find(visible);if(!user)return null;
    try{const u=new URL(form.action||location.href,location.href);if(u.protocol!=='https:'||u.port||u.username||u.password)return null;
      if(location.hostname==='aulavirtual.uv.es'){if(u.hostname!==location.hostname||u.pathname!=='/login/index.php')return null;}
      else if(!((u.hostname==='as.uv.es'&&u.pathname==='/cgi-bin/AuthServer')||(u.hostname==='portal.uv.es'&&u.pathname==='/cgi-bin/portal/portal')))return null;
    }catch(_){return null;}return {user,pw,form};
  }
  async function fill(){
    if(!loginPage)return;
    for(const el of document.querySelectorAll('.loginerrors,.loginerror,.alert-danger,[role="alert"],.error'))if(!errors.has(el)&&/incorrect|inv.lid|err.n|fall|failed/i.test(el.textContent)){errors.add(el);ipcRenderer.invoke('cuaderno:uv:failed').catch(()=>{});}
    const f=fields();if(!f)return;
    const saved=await(savedPromise||=(ipcRenderer.invoke('cuaderno:uv:read').catch(()=>null)));
    if(location.hostname==='aulavirtual.uv.es'&&!saved&&!gestureAt&&!routed){
      const link=[...document.querySelectorAll('a[href]')].find(a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&u.hostname==='aulavirtual.uv.es'&&!u.port&&u.pathname==='/auth/saml2/login.php'&&/universitat|universidad|university|usuaris|usuarios/i.test(a.textContent);}catch(_){return false;}});
      if(link){routed=true;location.assign(link.href);return;}
    }
    if(!saved||filled.has(f.pw)||!f.pw.isConnected||f.user.value&&f.user.value.trim().toLowerCase()!==saved.user.toLowerCase())return;
    filled.add(f.pw);if(!f.user.value)f.user.value=saved.user;if(!f.pw.value)f.pw.value=saved.password;
    for(const el of [f.user,f.pw]){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  }
  function remember(e){
    if(!loginPage||!e.isTrusted||Date.now()-gestureAt>2000)return;const f=fields();if(!f||!f.user.value.trim()||!f.pw.value)return;
    if(e.type==='submit'&&e.target!==f.form)return;
    if(e.type==='click'&&!e.target.closest('button:not([type]),button[type="submit"],input[type="submit"]'))return;
    ipcRenderer.invoke('cuaderno:uv:save',{origin:location.origin,user:f.user.value.trim(),password:f.pw.value}).catch(()=>{});
  }
  function authenticated(){
    if(reported||document.querySelector('input[type="password"]'))return;
    const proof=document.querySelector('a[href*="logout"],a[href*="logoff"],a[href*="salir"],a[href*="tancar"],.usermenu .userbutton');
    if(proof){reported=true;ipcRenderer.invoke('cuaderno:uv:success').catch(()=>{});}
  }
  const schedule=()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;fill().catch(()=>{});authenticated();});};
  for(const type of ['pointerdown','keydown'])document.addEventListener(type,e=>{if(e.isTrusted&&e.target.closest('form'))gestureAt=Date.now();},true);
  document.addEventListener('submit',remember,true);document.addEventListener('click',remember,true);
  window.addEventListener('DOMContentLoaded',()=>{schedule();new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});});
}
