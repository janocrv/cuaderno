'use strict';
// This bridge is isolated from the page. It never exposes Node or IPC to UV scripts.
const { ipcRenderer } = require('electron');
const allowed = location.protocol === 'https:' && ['as.uv.es','portal.uv.es'].includes(location.hostname);
if (allowed) {
  const filled = new WeakSet();
  const fields = () => {const pw=document.querySelector('input[type="password"]');if(!pw)return null;const form=pw.form||pw.closest('form')||document;const user=form.querySelector('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="usu" i],input[name*="login" i],input[type="text"],input:not([type])');return user?{user,pw}:null;};
  async function fill() {const f=fields();if(!f||filled.has(f.pw))return;filled.add(f.pw);try{const saved=await ipcRenderer.invoke('cuaderno:uv:read',location.origin);if(!saved)return;if(!f.user.value)f.user.value=saved.user;if(!f.pw.value)f.pw.value=saved.password;for(const el of [f.user,f.pw]){el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}}catch(_){} }
  function remember(event) {if(!event.isTrusted)return;const f=fields();if(!f||!f.user.value.trim()||!f.pw.value)return;ipcRenderer.invoke('cuaderno:uv:save',{origin:location.origin,user:f.user.value.trim(),password:f.pw.value}).catch(()=>{});}
  document.addEventListener('submit',remember,true);
  document.addEventListener('click',event=>{if(event.target.closest('button[type="submit"],input[type="submit"]'))remember(event);},true);
  document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.closest('form'))remember(event);},true);
  window.addEventListener('DOMContentLoaded',()=>{fill();new MutationObserver(fill).observe(document.body,{childList:true,subtree:true});});
}
