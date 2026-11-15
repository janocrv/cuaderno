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
  const api={activityURL,materialURL,fromMail,taskURL,apply,extractDocument,extractCourseContext,scanSite};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CuadernoAulaVirtual=api;
})(typeof globalThis!=='undefined'?globalThis:this);
