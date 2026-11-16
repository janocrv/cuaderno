'use strict';
const path=require('path');
module.exports=({BrowserWindow,web,open,login})=>{
  const api=require(path.join(web,'aula-virtual.js'));
  let busy=false;
  async function read(value,quiet=false){
    const url=api.activityURL(value);if(!url)throw new Error('Hace falta el enlace de una actividad del Aula Virtual de la UV.');
    if(busy)throw new Error('Ya se está consultando una actividad. Espera a que termine.');busy=true;let reader,timer;
    try{
      reader=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{partition:'persist:cuaderno-intranet',nodeIntegration:false,contextIsolation:true,sandbox:true}});
      const allowed=u=>{try{const p=new URL(u);return p.protocol==='https:'&&!p.port&&!p.username&&!p.password&&(p.hostname==='uv.es'||p.hostname.endsWith('.uv.es'));}catch(_){return false;}};
      reader.webContents.on('will-navigate',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.on('will-redirect',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const result=await Promise.race([(async()=>{await reader.loadURL(url);if(api.activityURL(reader.webContents.getURL())!==url)return {needsLogin:true};const data=await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.extractDocument.toString()+')()'}]);
        if(data.verified&&data.courseUrl)try{const course=new URL(data.courseUrl);if(course.protocol==='https:'&&course.hostname==='aulavirtual.uv.es'&&!course.port&&!course.username&&!course.password&&course.pathname==='/course/view.php'&&/^\d+$/.test(course.searchParams.get('id')||'')){await reader.loadURL(course.href);if(new URL(reader.webContents.getURL()).origin===course.origin)Object.assign(data,await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.extractCourseContext.toString()+')('+JSON.stringify(url)+')'}]));}}catch(_){data.contextUnavailable=true;}
        return data;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('El Aula Virtual tarda demasiado. Puedes abrir la actividad y volver a intentarlo.')),25000);})]);
      if(result.needsLogin){if(!quiet)open(url);return {ok:true,needsLogin:true,url};}
      if(!result.verified||api.activityURL(result.url)!==url)throw new Error('No se ha podido reconocer el contenido de esta actividad. Abre el original para revisarlo.');
      return {ok:true,...result};
    }finally{clearTimeout(timer);if(reader&&!reader.isDestroyed())reader.destroy();busy=false;}
  }
  // Revisión general silenciosa (cursos, profesorado y entregas). Nunca abre ventanas a la vista.
  const HOME='https://aulavirtual.uv.es/my/';
  const clean=(v,n)=>String(v||'').slice(0,n);
  async function scanOnce(options={}){
    let reader,timer;
    try{
      reader=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{partition:'persist:cuaderno-intranet',nodeIntegration:false,contextIsolation:true,sandbox:true}});
      const allowed=u=>{try{const p=new URL(u);return p.protocol==='https:'&&!p.port&&!p.username&&!p.password&&(p.hostname==='uv.es'||p.hostname.endsWith('.uv.es'));}catch(_){return false;}};
      reader.webContents.on('will-navigate',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.on('will-redirect',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      return await Promise.race([(async()=>{await reader.loadURL(HOME).catch(()=>{});let u;try{u=new URL(reader.webContents.getURL());}catch(_){return {needsLogin:true};}
        if(u.hostname!=='aulavirtual.uv.es'||/^\/(login|auth)\//.test(u.pathname))return {needsLogin:true};
        const data=await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.scanSite.toString()+')()'}]);
        // Revisión a fondo: la página de cada curso, con el texto y los PDF de su apartado de información.
        if(options.deep&&data?.ok)for(const c of (data.courses||[]).slice(0,14)){if(!/^\d+$/.test(String(c.id)))continue;
          try{await reader.loadURL('https://aulavirtual.uv.es/course/view.php?id='+c.id).catch(()=>{});const u=new URL(reader.webContents.getURL());if(u.hostname!=='aulavirtual.uv.es'||u.pathname!=='/course/view.php')continue;
            const info=await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.scanCourse.toString()+')('+JSON.stringify((options.skip||[]).slice(0,400))+')'}]);if(info?.ok)c.info=info;}catch(_){}}
        if(options.deep&&data?.ok)data.deep=true;
        return data;})(),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('El Aula Virtual tarda demasiado en responder.')),options.deep?150000:30000);})]);
    }finally{clearTimeout(timer);if(reader&&!reader.isDestroyed())reader.destroy();}
  }
  async function scan(options={}){
    options={deep:!!options.deep,skip:Array.isArray(options.skip)?options.skip.filter(x=>typeof x==='string'):[]};
    if(busy)throw new Error('Ya se está consultando el Aula Virtual. Espera a que termine.');busy=true;
    try{
      let data=await scanOnce(options);
      if(data?.needsLogin&&login&&await login())data=await scanOnce(options);
      if(!data||data.needsLogin)return {ok:true,needsLogin:true};
      if(data.ok===false)throw new Error('El Aula Virtual no ha devuelto la información: '+clean(data.error,300));
      return {ok:true,checkedAt:Date.now(),warnings:(data.warnings||[]).slice(0,5).map(w=>clean(w,200)),
        deep:!!data.deep,courses:(data.courses||[]).slice(0,80).map(c=>({id:+c.id||0,fullname:clean(c.fullname,300),shortname:clean(c.shortname,120),idnumber:clean(c.idnumber,120),contacts:(c.contacts||[]).slice(0,20).map(n=>clean(n,160)).filter(Boolean),...(c.info?{info:{text:clean(c.info.text,8000),docs:(c.info.docs||[]).slice(0,4).filter(d=>api.materialURL(d.url)||/^https:\/\/aulavirtual\.uv\.es\/mod\/resource\/view\.php\?id=\d+$/.test(d.url||'')).map(d=>({url:d.url,name:clean(d.name,300),skipped:!!d.skipped,data:typeof d.data==='string'&&d.data.length<9e6&&/^[A-Za-z0-9+/=]*$/.test(d.data)?d.data:''}))}}:{})})),
        events:(data.events||[]).slice(0,80).map(e=>({url:api.activityURL(e.url),title:clean(e.title,300),due:/^\d{4}-\d{2}-\d{2}$/.test(e.due)?e.due:'',time:/^\d{2}:\d{2}$/.test(e.time)?e.time:'',courseId:+e.courseId||0,course:clean(e.course,300)})).filter(e=>e.url&&e.title&&e.due)};
    }finally{busy=false;}
  }
  return {read,scan};
};
