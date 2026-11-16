/* Información de actividades: enlaces UV validados y texto, nunca HTML ejecutable. */
(function(root){
  function activityURL(value){try{const raw=String(value||'').trim(),url=new URL(/^\d+$/.test(raw)?'https://aulavirtual.uv.es/mod/assign/view.php?id='+raw:raw);if(url.protocol!=='https:'||url.hostname!=='aulavirtual.uv.es'||url.port||url.username||url.password||!/^\/mod\/(assign|quiz)\/view\.php$/.test(url.pathname)||!/^\d+$/.test(url.searchParams.get('id')||''))return '';return url.origin+url.pathname+'?id='+url.searchParams.get('id');}catch(_){return '';}}
  function fromMail(m){const text=[m.body,m.snippet].filter(Boolean).join('\n'),links=text.match(/https:\/\/aulavirtual\.uv\.es\/[^\s<>"']+/gi)||[];return {uid:String(m.uid),folder:m.folder||'INBOX',subject:String(m.subject||''),from:String(m.from||''),fromName:String(m.from_name||''),date:String(m.date||''),body:String(m.body||m.snippet||'').slice(0,30000),url:links.map(link=>activityURL(link.replace(/[).,;!?]+$/,''))).find(Boolean)||''};}
  function taskURL(task){return activityURL(task.activityUrl)||activityURL(task.av)||activityURL(task.aula?.url)||activityURL(task.sourceMail?.url);}
  function materialURL(value){try{const u=new URL(value);return u.protocol==='https:'&&u.hostname==='aulavirtual.uv.es'&&!u.port&&!u.username&&!u.password&&(/^\/mod\/(resource|folder)\/view\.php$/.test(u.pathname)&&/^\d+$/.test(u.searchParams.get('id')||'')||/^\/pluginfile\.php\//.test(u.pathname))?u.href:'';}catch(_){return '';}}
  function apply(task,data){const url=activityURL(data?.url);if(!url||url!==taskURL(task))throw new Error('La actividad no coincide con esta tarea.');if(data.needsLogin||!data.verified)throw new Error('Inicia sesión en el Aula Virtual y vuelve a consultar la actividad.');
    task.aula={url,title:String(data.title||'').slice(0,500),course:String(data.course||'').slice(0,500),instructions:String(data.instructions||'').slice(0,30000),due:data.due||'',dueText:String(data.dueText||'').slice(0,300),submission:String(data.submission||'').slice(0,500),checkedAt:Date.now(),attachments:(data.attachments||[]).filter(a=>{try{const u=new URL(a.url);return u.protocol==='https:'&&u.hostname==='aulavirtual.uv.es'&&!u.port&&!u.username&&!u.password&&/\/pluginfile\.php\//.test(u.pathname);}catch(_){return false;}}).slice(0,40).map(a=>({name:String(a.name||'Archivo de la actividad').slice(0,300),url:a.url}))};
    task.aula.section=String(data.section||'').slice(0,500);task.aula.context=String(data.context||'').slice(0,12000);task.aula.materials=(data.materials||[]).filter(m=>materialURL(m.url)).slice(0,40).map(m=>({name:String(m.name||'Material del apartado').slice(0,300),url:materialURL(m.url)}));
    // No altera el título elegido, el estado manual ni una fecha no verificable.
    if(/^\d{4}-\d{2}-\d{2}$/.test(data.due||''))task.due=data.due;
    return task;
  }
  // Función autocontenida para un mundo aislado de Electron y para fixtures de Moodle.
  function extractDocument(){
    const url=new URL(location.href),id=url.searchParams.get('id'),valid=url.protocol==='https:'&&url.hostname==='aulavirtual.uv.es'&&/^\/mod\/(assign|quiz)\/view\.php$/.test(url.pathname)&&/^\d+$/.test(id||'');
    if(!valid||document.querySelector('input[type="password"],#login'))return {needsLogin:true,verified:false};
    const main=document.querySelector('#region-main'),text=el=>(el?.innerText||el?.textContent||'').replace(/\u00a0/g,' ').trim();
    const title=text(document.querySelector('.activity-header h1,.activity-header h2,[data-region="activity-header"] h1,[data-region="activity-header"] h2'))||text(main?.querySelector('h2'))||text(document.querySelector('#page-header h1'));
    const intro=document.querySelector('#intro,.activity-description .description-inner,.activity-description .no-overflow');
    const courseLink=[...document.querySelectorAll('.breadcrumb a,nav[aria-label] a')].find(a=>/\/course\/view\.php\?/.test(a.href));
    let dueText='',due='',submission='';
    const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    function parseDate(value){const normalized=norm(value),months={enero:1,gener:1,febrero:2,febrer:2,marzo:3,marc:3,abril:4,mayo:5,maig:5,junio:6,juny:6,julio:7,juliol:7,agosto:8,agost:8,septiembre:9,setembre:9,octubre:10,noviembre:11,novembre:11,diciembre:12,desembre:12,january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};let m=normalized.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/),d,mo,y;if(m)[,d,mo,y]=m;else{m=normalized.match(/\b(\d{1,2})\s+(?:de\s+|d')?([a-z]+)\s+(?:de\s+|del\s+)?(\d{4})/);if(m){d=m[1];mo=months[m[2]];y=m[3];}}if(!mo)return '';const date=new Date(+y,+mo-1,+d);return date.getFullYear()===+y&&date.getMonth()===+mo-1&&date.getDate()===+d?[y,String(mo).padStart(2,'0'),String(d).padStart(2,'0')].join('-'):'';}
    for(const row of main?.querySelectorAll('.submissionstatustable tr,.generaltable tr')||[]){const cells=[...row.querySelectorAll('th,td')];if(cells.length<2)continue;const label=norm(text(cells[0])),value=cells[1];if(/fecha de entrega|data de lliurament|due date|fecha limite|termini de lliurament/.test(label)){dueText=text(value);const iso=value.querySelector('time[datetime]')?.getAttribute('datetime');due=iso&&/^\d{4}-\d{2}-\d{2}/.test(iso)?iso.slice(0,10):parseDate(dueText);}if(/estado de (la )?entrega|estat del lliurament|submission status/.test(label))submission=text(value);}
    if(!dueText){const rows=[...document.querySelectorAll('[data-region="activity-dates"] > div,.activity-dates > div'),...[...document.querySelectorAll('[data-region="activity-dates"] strong,.activity-dates strong')].map(el=>el.parentElement)];for(const item of rows){const label=norm(text(item.querySelector('strong,b'))||text(item).split(':')[0]);if(/^(vence|venciment|due|tancament|cierre|fecha de entrega)/.test(label)){dueText=text(item);due=parseDate(dueText);break;}}}
    const attachments=[...document.querySelectorAll('#intro a[href],.activity-description a[href],.introattachments a[href]')].filter(a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&u.hostname==='aulavirtual.uv.es'&&/\/pluginfile\.php\//.test(u.pathname);}catch(_){return false;}}).map(a=>({name:text(a)||'Archivo de la actividad',url:a.href})).filter((a,i,all)=>all.findIndex(b=>b.url===a.url)===i);
    return {verified:!!(main&&title&&(intro||document.querySelector('.submissionstatustable,.activity-dates,[data-region="activity-dates"]'))),url:url.origin+url.pathname+'?id='+id,title,course:text(courseLink),courseUrl:courseLink?.href||'',instructions:text(intro),due,dueText,submission,attachments};
  }
  function extractCourseContext(activity){
    const target=new URL(activity),text=el=>(el?.innerText||el?.textContent||'').trim();
    const anchor=[...document.querySelectorAll('#region-main a[href]')].find(a=>{try{const u=new URL(a.href);return u.origin===target.origin&&u.pathname===target.pathname&&u.searchParams.get('id')===target.searchParams.get('id');}catch(_){return false;}});
    const section=anchor?.closest('[data-for="section"],li.section,section.section,.course-section');if(!section)return {materials:[]};
    const name=text(section.querySelector('.sectionname,.section-title,h3,h4')),context=text(section.querySelector('.summarytext,.summary,.course-section-summary'));
    const materials=[...section.querySelectorAll('a[href]')].filter(a=>{try{const u=new URL(a.href);return u.protocol==='https:'&&u.hostname==='aulavirtual.uv.es'&&/^\/mod\/(resource|folder)\/view\.php$/.test(u.pathname)&&/^\d+$/.test(u.searchParams.get('id')||'');}catch(_){return false;}}).map(a=>({name:text(a).replace(/\s+(Archivo|File|Carpeta|Folder)\s*$/i,'').trim(),url:a.href})).filter((a,i,all)=>a.name&&all.findIndex(b=>b.url===a.url)===i).slice(0,40);
    return {section:name,context,materials};
  }
  // Revisión general: cursos, profesorado de cada curso y entregas próximas. Función autocontenida
  // para el mundo aislado; usa el servicio interno de Moodle con la sesión ya abierta (solo lectura).
  async function scanSite(){
    if(location.protocol!=='https:'||location.hostname!=='aulavirtual.uv.es'||/^\/(login|auth)\//.test(location.pathname)||document.querySelector('input[type="password"]'))return {needsLogin:true};
    let sesskey='';for(const a of document.querySelectorAll('a[href*="sesskey="]')){const m=a.href.match(/[?&]sesskey=([A-Za-z0-9]+)/);if(m){sesskey=m[1];break;}}
    if(!sesskey)sesskey=document.querySelector('input[name="sesskey"]')?.value||'';
    if(!/^[A-Za-z0-9]+$/.test(sesskey))return {needsLogin:true};
    const call=async(methodname,args)=>{const r=await fetch('/lib/ajax/service.php?sesskey='+sesskey+'&info='+methodname,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify([{index:0,methodname,args}])});const j=await r.json();if(!Array.isArray(j)||j[0]?.error)throw new Error(j?.[0]?.exception?.message||j?.error||'Respuesta no reconocida');return j[0].data;};
    const text=v=>{const d=document.createElement('textarea');d.innerHTML=String(v||'');return d.value.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();};
    const out={ok:true,courses:[],events:[],warnings:[]};
    try{const data=await call('core_course_get_enrolled_courses_by_timeline_classification',{offset:0,limit:0,classification:'all',sort:'fullname'});out.courses=(data.courses||[]).map(c=>({id:+c.id,fullname:text(c.fullname),shortname:text(c.shortname),idnumber:text(c.idnumber),contacts:[]}));}catch(e){out.warnings.push('cursos: '+e.message);}
    if(out.courses.length)try{const data=await call('core_course_get_courses_by_field',{field:'ids',value:out.courses.map(c=>c.id).join(',')});for(const c of data.courses||[]){const mine=out.courses.find(x=>x.id===+c.id);if(mine)mine.contacts=(c.contacts||[]).map(p=>text(p.fullname)).filter(Boolean).slice(0,20);}}catch(e){out.warnings.push('profesorado: '+e.message);}
    try{const from=Math.floor(Date.now()/1000)-86400,data=await call('core_calendar_get_action_events_by_timesort',{limitnum:50,timesortfrom:from,limittononsuspendedevents:true});
      for(const e of data.events||[]){if(!/^(assign|quiz)$/.test(e.modulename||'')||!e.timesort)continue;const d=new Date(e.timesort*1000),pad=n=>String(n).padStart(2,'0');out.events.push({url:String(e.url||e.action?.url||''),title:text(e.activityname||e.name),due:d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),time:pad(d.getHours())+':'+pad(d.getMinutes()),courseId:+(e.course?.id||0),course:text(e.course?.fullname)});}
    }catch(e){out.warnings.push('entregas: '+e.message);}
    if(!out.courses.length&&!out.events.length&&out.warnings.length)return {ok:false,error:out.warnings.join(' · ')};
    return out;
  }
  // Página de un curso: texto del apartado de información y sus PDF (guía, profesorado…). Autocontenida, solo lectura.
  async function scanCourse(skip){
    const here=new URL(location.href);
    if(here.protocol!=='https:'||here.hostname!=='aulavirtual.uv.es'||here.pathname!=='/course/view.php'||document.querySelector('input[type="password"]'))return {needsLogin:true};
    const text=el=>(el?.innerText||el?.textContent||'').replace(/ /g,' ').trim(),norm=v=>String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
    const INFO=/informaci|general|presentaci|professorat|profesorado|docent|guia|contact|introducci/,DOC=/guia|programa|temari|presentaci|calendari|informacio|profesorado|professorat|tutori/,NOT_DOC=/\(\d{4}\)|^(ley|llei|real decreto|reial decret|orden|ordre|decret)\b/;
    const sections=[...document.querySelectorAll('#region-main [data-for="section"],#region-main li.section,#region-main section.section,#region-main .course-section')].filter((el,i,all)=>!all.some(o=>o!==el&&o.contains(el)));
    const chosen=sections.filter((el,i)=>i===0||INFO.test(norm(text(el.querySelector('.sectionname,.section-title,h3,h4'))))).slice(0,3);
    const fileLink=a=>{try{const u=new URL(a.href);if(u.protocol!=='https:'||u.hostname!=='aulavirtual.uv.es'||u.port)return '';if(u.pathname==='/mod/resource/view.php'&&/^\d+$/.test(u.searchParams.get('id')||''))return u.origin+u.pathname+'?id='+u.searchParams.get('id');if(/^\/pluginfile\.php\/.+\.pdf$/i.test(u.pathname))return u.origin+u.pathname;}catch(_){}return '';};
    // Documentos de la asignatura: guía, programa, presentación, temario, calendario… (no la bibliografía ni la legislación)
    const found=[];for(const a of document.querySelectorAll('#region-main a[href]')){const url=fileLink(a);if(!url||found.some(f=>f.url===url))continue;const name=text(a).replace(/\s+/g,' ').replace(/\s+(Archivo|Fitxer|File)\s*$/i,'').trim().slice(0,300),n=norm(name);if(!DOC.test(n)||NOT_DOC.test(n))continue;const at=sections.findIndex(el=>el.contains(a));found.push({url,name,priority:(at>=0&&at<=1?3:1)+(/guia docent|programa|presentaci|guia orient/.test(n)?1:0)});}
    found.sort((a,b)=>b.priority-a.priority);const wanted=(found.some(f=>f.priority>=3)?found.filter(f=>f.priority>=3):found.slice(0,2)).slice(0,4),docs=[];
    const b64=buf=>{const bytes=new Uint8Array(buf);let out='';for(let i=0;i<bytes.length;i+=0x8000)out+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(out);};
    for(const f of wanted){
      if((skip||[]).includes(f.url)){docs.push({url:f.url,name:f.name,skipped:true});continue;}
      try{let r=await fetch(f.url+(f.url.includes('?')?'&redirect=1':''),{credentials:'same-origin'});
        if(/text\/html/i.test(r.headers.get('content-type')||'')){const m=(await r.text()).match(/https:\/\/aulavirtual\.uv\.es\/pluginfile\.php\/[^"'<>\s]+?\.pdf/i);if(!m)continue;r=await fetch(m[0].replace(/&amp;/g,'&'),{credentials:'same-origin'});}
        if(!r.ok||new URL(r.url).hostname!=='aulavirtual.uv.es'||!/pdf/i.test(r.headers.get('content-type')||''))continue;
        const buf=await r.arrayBuffer();if(buf.byteLength>6*1024*1024||buf.byteLength<200)continue;
        docs.push({url:f.url,name:f.name,data:b64(buf)});
      }catch(_){}
    }
    // Profesorado: la lista de participantes con rol de profesor/a
    const teachers=[];
    try{const r=await fetch('/user/index.php?id='+encodeURIComponent(here.searchParams.get('id'))+'&perpage=5000',{credentials:'same-origin'});
      if(r.ok&&new URL(r.url).pathname==='/user/index.php'){const d=new DOMParser().parseFromString(await r.text(),'text/html');
        for(const tr of d.querySelectorAll('table#participants tbody tr,table.generaltable tbody tr')){const link=tr.querySelector('a[href*="/user/view.php"]');if(!link)continue;const cells=[...tr.querySelectorAll('th,td')].map(c=>(c.textContent||'').replace(/\s+/g,' ').trim());
          if(!cells.some(c=>c.length<80&&/^(profes|teacher|docent)|\b(profesor|profesora|professor|professora|teacher)\b/i.test(c)))continue;
          const name=cells.find(c=>/^[^,@\d']{2,60},\s*[^,@\d']{2,40}$/.test(c))||(link.textContent||'').replace(/\s+/g,' ').trim();if(name&&name.length<120&&!teachers.includes(name))teachers.push(name);}}
    }catch(_){}
    // Entregas y cuestionarios que aparecen en la página del curso (aunque no estén en el calendario)
    const activities=[];for(const a of document.querySelectorAll('#region-main a[href]')){try{const u=new URL(a.href);if(u.hostname!=='aulavirtual.uv.es'||!/^\/mod\/(assign|quiz)\/view\.php$/.test(u.pathname)||!/^\d+$/.test(u.searchParams.get('id')||''))continue;const url=u.origin+u.pathname+'?id='+u.searchParams.get('id');if(activities.some(x=>x.url===url))continue;const title=text(a.querySelector('.instancename')||a).replace(/\s+/g,' ').replace(/\s+(Tarea|Tasca|Assignment|Cuestionario|Qüestionari|Quiz)\s*$/i,'').trim().slice(0,300);if(title)activities.push({url,title});}catch(_){}}
    return {ok:true,text:chosen.map(text).join('\n').slice(0,8000),docs,teachers:teachers.slice(0,20),activities:activities.slice(0,60)};
  }
  const api={activityURL,materialURL,fromMail,taskURL,apply,extractDocument,extractCourseContext,scanSite,scanCourse};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CuadernoAulaVirtual=api;
})(typeof globalThis!=='undefined'?globalThis:this);
