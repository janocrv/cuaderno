'use strict';
const path=require('path');
module.exports=({BrowserWindow,web,open})=>{
  const api=require(path.join(web,'aula-virtual.js'));
  let busy=false;
  async function read(value){
    const url=api.activityURL(value);if(!url)throw new Error('Hace falta el enlace de una actividad del Aula Virtual de la UV.');
    if(busy)throw new Error('Ya se está consultando una actividad. Espera a que termine.');busy=true;let reader,timer;
    try{
      reader=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{partition:'persist:cuaderno-intranet',nodeIntegration:false,contextIsolation:true,sandbox:true}});
      const allowed=u=>{try{const p=new URL(u);return p.protocol==='https:'&&!p.port&&!p.username&&!p.password&&(p.hostname==='uv.es'||p.hostname.endsWith('.uv.es'));}catch(_){return false;}};
      reader.webContents.on('will-navigate',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.on('will-redirect',(event,u)=>{if(!allowed(u))event.preventDefault();});reader.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      const result=await Promise.race([(async()=>{await reader.loadURL(url);if(api.activityURL(reader.webContents.getURL())!==url)return {needsLogin:true};const data=await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.extractDocument.toString()+')()'}]);
        if(data.verified&&data.courseUrl)try{const course=new URL(data.courseUrl);if(course.protocol==='https:'&&course.hostname==='aulavirtual.uv.es'&&!course.port&&!course.username&&!course.password&&course.pathname==='/course/view.php'&&/^\d+$/.test(course.searchParams.get('id')||'')){await reader.loadURL(course.href);if(new URL(reader.webContents.getURL()).origin===course.origin)Object.assign(data,await reader.webContents.executeJavaScriptInIsolatedWorld(1001,[{code:'('+api.extractCourseContext.toString()+')('+JSON.stringify(url)+')'}]));}}catch(_){data.contextUnavailable=true;}
        return data;})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('El Aula Virtual tarda demasiado. Puedes abrir la actividad y volver a intentarlo.')),25000);})]);
      if(result.needsLogin){open(url);return {ok:true,needsLogin:true,url};}
      if(!result.verified||api.activityURL(result.url)!==url)throw new Error('No se ha podido reconocer el contenido de esta actividad. Abre el original para revisarlo.');
      return {ok:true,...result};
    }finally{clearTimeout(timer);if(reader&&!reader.isDestroyed())reader.destroy();busy=false;}
  }
  return {read};
};
