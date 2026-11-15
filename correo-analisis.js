/* Lectura local y determinista: no ejecuta instrucciones ni enlaces de los mensajes. */
(function(root){
  const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  function books(message){
    const body=String(message.body||'').split(/\n(?:On .+wrote:|El .+escribi[oó]:|De:|From:|>)/)[0];
    const rows=body.split(/\n/),found=[];
    for(let i=0;i<rows.length;i++){
      const text=rows[i].trim();
      if(!/(recomiend|recoman|lectura recomend|lectura recoman|bibliograf[ií]|libro|llibre)/i.test(text))continue;
      const match=text.match(/[«“"]([^»”"\n]{4,180})[»”"]/) || text.match(/(?:libro|llibre|lectura recomendada|lectura recomanada)\s*:\s*([^\n]{4,180})/i);
      if(!match)continue;
      const title=match[1].trim(),tail=text.slice((match.index||0)+match[0].length),author=(tail.match(/^\s*(?:,?\s+de|—|–)\s+([^.;\n]{3,90})/i)||[])[1]||'';
      const isbn=(text.match(/\bISBN\s*:?[\s-]*([\dXx -]{10,22})/)||[])[1]||'';
      if(!found.some(b=>norm(b.title)===norm(title)))found.push({title,authors:author.trim(),isbn:isbn.replace(/[ -]/g,''),source:text.slice(0,500)});
    }
    return found;
  }
  function extension(message,tasks,due){
    const text=norm((message.subject||'')+'\n'+String(message.body||'').split(/\n(?:>|De:|From:)/)[0]);
    if(!due||!/(ampli|prorro|nuevo plazo|nova data|nueva fecha|nou termini|se aplaza|s'ajorna|pospon|fecha.*actualiz|data.*actualitz)/.test(text))return null;
    const candidates=tasks.filter(t=>{const title=norm(t.sourceTitle||t.title).replace(/\s+/g,' ').trim();return title.length>=5&&text.includes(title);});
    return candidates.length===1?candidates[0]:null;
  }
  function extensionDate(message,reference){
    const text=norm((message.subject||'')+'\n'+String(message.body||'').split(/\n(?:>|De:|From:)/)[0]),dates=[];
    const months={enero:1,gener:1,febrero:2,febrer:2,marzo:3,marc:3,abril:4,mayo:5,maig:5,junio:6,juny:6,julio:7,juliol:7,agosto:8,agost:8,septiembre:9,setembre:9,octubre:10,noviembre:11,novembre:11,diciembre:12,desembre:12};
    const add=(day,month,year)=>{let y=Number(year)||Number(reference.slice(0,4));if(y<100)y+=2000;const date=new Date(y,month-1,day);if(date.getMonth()!==month-1||date.getDate()!==day)return;let iso=[y,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');if(!year&&iso<reference){y++;iso=y+iso.slice(4);}if(iso>=reference)dates.push(iso);};
    for(const m of text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/g))add(+m[1],+m[2],m[3]);
    for(const m of text.matchAll(/\b(\d{1,2})\s+(?:de\s+|d')?([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/g))if(months[m[2]])add(+m[1],months[m[2]],m[3]);
    return dates.sort().at(-1)||'';
  }
  const service=/no.?reply|no contestar|admin user|aula.?virtual|secretar|bibliotec|unitat|unidad|departament|facultat|facultad|servici|servei|coordinacio|coordinacion|comissio|comision|postgrau|postgrado|profesorado|professorat/i;
  const emailRX=/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
  const ownBody=body=>String(body||'').split(/\n(?:\s*>|On .+wrote:|El .+escribi[oó]:|De:\s|From:\s|[-_]{3,}\s*(?:Original|Mensaje|Missatge))/i)[0];
  function teacherName(value){let name=String(value||'').replace(/\s*\((?:v[ií]a|via)\s+Aula\s*Virtual\)\s*/ig,'').replace(/^[\s,"<>]+|[\s,"<>]+$/g,'').trim();if(name.includes(',')){const [surname,...given]=name.split(',');name=given.join(' ').trim()+' '+surname.trim();}name=name.replace(/\s+/g,' ');if(name===name.toUpperCase())name=name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu,(_,p,c)=>p+c.toUpperCase());return name;}
  const personKey=name=>norm(teacherName(name)).replace(/[^\p{L}\s]/gu,'').split(/\s+/).filter(Boolean).sort().join(' ');
  const person=name=>{const n=teacherName(name),parts=n.split(/\s+/);return parts.length>=2&&parts.length<=8&&!service.test(norm(n))&&!/[\d@|]/.test(n);};
  const personalEmail=email=>/^[\w.+-]+@uv\.es$/i.test(email||'')&&!service.test(norm(String(email).split('@')[0]));
  function teacherKeys(t){const keys=[];if(t.email)keys.push('email:'+String(t.email).toLowerCase());if(t.name)keys.push('name:'+personKey(t.name));for(const name of t.mailNames||[])keys.push('name:'+name);for(const email of t.mailEmails||[])keys.push('email:'+email);return [...new Set(keys)];}
  function teacherInfo(text){
    const lines=ownBody(text).split(/\r?\n/).map(x=>x.trim()).filter(Boolean),out={hours:'',room:'',phone:'',notes:''},quotes={};
    for(let i=0;i<lines.length;i++){
      const line=lines[i];let m;
      if(!out.hours&&(m=line.match(/^(?:(?:horario|horari)\s+(?:de |d')?|mis |les meues )?tutor[ií](?:as|es|a)\s*(?:[:\-–]\s*(.*)|$)/i))){const value=m[1]||lines[i+1]||'';if(/\d|lunes|martes|mi[eé]rcoles|jueves|viernes|dilluns|dimarts|dimecres|dijous|divendres|cita|online|teams/i.test(value)){out.hours=value.slice(0,200);quotes.hours=line+(m[1]?'':'\n'+value);}}
      if(!out.room&&(m=line.match(/^(?:mi |el meu )?(?:despacho|despatx|sala de tutor[ií]as?)\s*(?:n[ºo°.]\s*)?[:\-–]?\s*([^;|]{1,100})/i))&&!/virtual/i.test(m[1])){out.room=m[1].replace(/[.,]$/,'').trim();quotes.room=line;}
      if(!out.phone&&(m=line.match(/(?:^|\s)(?:tel[eéè]fon[oa]?|tlf\.?|tel\.?|ext\.?|extensi[oó])\s*[:.\-–]?\s*(\+?\d[\d\s.()\-]{2,22}\d)/i))){const digits=m[1].replace(/\D/g,'');if(digits.length>=4&&digits.length<=13){out.phone=m[1].trim();quotes.phone=line;}}
      if(!out.notes&&(m=line.match(/^(?:contacto|contacte|preferencia de contacto|prefer[eè]ncia de contacte)\s*[:\-–]\s*(.{4,200})/i))&&/correo|correu|mail|cita|teams|presencial/i.test(m[1])){out.notes=m[1];quotes.notes=line;}
    }return {...out,quotes};
  }
  function courseFor(message,subjects){
    const head=String(message.subject||''),body=ownBody(message.body).slice(0,1800),text=norm(head+' '+body);
    let hits=subjects.filter(s=>s.code&&new RegExp('(?:^|\\D)'+String(s.code).replace(/\D/g,'')+'(?:\\D|$)').test(text));
    if(hits.length===1)return hits[0];if(hits.length>1)return null;
    hits=subjects.filter(s=>norm(s.name||'').length>8&&text.includes(norm(s.name)));if(hits.length===1)return hits[0];if(hits.length>1)return null;
    hits=subjects.filter(s=>s.short&&new RegExp('(?:^|[^a-z0-9])'+norm(s.short).replace(/[^a-z0-9]/g,'')+'(?:[^a-z0-9]|$)').test(norm(head)));return hits.length===1?hits[0]:null;
  }
  function teacherCandidates(messages,subjects){
    const people=new Map(),explicit=new Map();
    for(const m of [...messages].sort((a,b)=>(b.date||'').localeCompare(a.date||''))){
      const from=String(m.from||'').toLowerCase(),via=/\((?:v[ií]a|via)\s+Aula\s*Virtual\)/i.test(m.from_name||''),name=teacherName(m.from_name),direct=personalEmail(from);
      const known=subjects.flatMap(s=>(s.teachers||[]).filter(t=>from&&(t.email?.toLowerCase()===from||(t.mailEmails||[]).includes(from))||person(name)&&(personKey(t.name)===personKey(name)||(t.mailNames||[]).includes(personKey(name)))).map(t=>({s,t})));
      const labeled=subjects.filter(s=>(s.emails||[]).some(e=>e.toLowerCase()===from)&&!service.test(norm(from.split('@')[0])));
      if(!person(name)&&!known.some(k=>k.t.email&&k.t.email.toLowerCase()===from)&&!labeled.length)continue;
      if(!direct&&!via&&!known.length&&!labeled.length)continue;
      const body=ownBody(m.body),lines=body.split(/\r?\n/),anchor=person(name)?lines.findIndex(l=>personKey(l)===personKey(name)):-1;
      const signed=anchor>=0?lines.slice(Math.max(0,anchor-4),anchor+12).join('\n'):body;
      let email=direct||labeled.length?from:'';
      if(!email){const replies=[...new Set((String(m.reply_to||'').match(emailRX)||[]).map(x=>x.toLowerCase()).filter(personalEmail))];if(replies.length===1)email=replies[0];}
      if(!email&&anchor>=0){const near=lines.slice(Math.max(0,anchor-1),anchor+5).join('\n'),emails=[...new Set((near.match(emailRX)||[]).map(x=>x.toLowerCase()).filter(personalEmail))];if(emails.length===1)email=emails[0];}
      const key=email?'email:'+email:'name:'+personKey(name),p=people.get(key)||{name:name||known[0]?.t.name||'',email,fields:{},messages:[],courses:new Set(),confirmed:new Set()};
      const origin={uid:String(m.uid),subject:String(m.subject||''),date:m.date||''};
      if(!p.fields.name&&p.name)p.fields.name={...origin,value:p.name,quote:m.from_name||p.name};
      if(!p.fields.email&&email)p.fields.email={...origin,value:email,quote:direct?from:m.reply_to||email};
      const course=courseFor(m,subjects),broad=/^\[PREGON\b/i.test(m.subject||''),teaching=direct||known.length||/contenido nuevo|contingut nou|es nuevo en el curso|[eé]s nou en el curs|anulaci[oó]n.*clase|cancel.*clas|tutor[ií]|mis clases|os veo|os informamos|estimad[oa]s?\s+(?:alumn|estudiant)/i.test((m.subject||'')+'\n'+body);
      if(course&&!broad){p.courses.add(course.id);if(teaching)p.confirmed.add(course.id);const ids=explicit.get(personKey(p.name))||new Set();ids.add(course.id);explicit.set(personKey(p.name),ids);}
      for(const {s} of known){p.courses.add(s.id);p.confirmed.add(s.id);}
      for(const s of labeled){p.courses.add(s.id);p.confirmed.add(s.id);}
      // No atribuir a un autor de Moodle la firma de otra persona que esté citando.
      const selfDeclared=/mis tutor|mi despacho|el meu despatx|les meues tutor|os atiendo|us atenc/i.test(body),info=teacherInfo(direct||selfDeclared?body:anchor>=0?signed:'');
      for(const field of ['hours','room','phone','notes'])if(!p.fields[field]&&info[field])p.fields[field]={value:info[field],uid:String(m.uid),subject:String(m.subject||''),date:m.date||'',quote:info.quotes[field]||''};
      p.messages.push({uid:String(m.uid),subject:String(m.subject||''),date:m.date||'',course:course?.id||''});people.set(key,p);
    }
    // Unir notificaciones sin dirección con el remitente personal de identidad exacta.
    for(const [key,p] of [...people])if(!p.email){const same=[...people.values()].filter(q=>q.email&&personKey(q.name)===personKey(p.name));if(same.length===1){const q=same[0];for(const c of p.courses)q.courses.add(c);for(const c of p.confirmed)q.confirmed.add(c);for(const [f,v]of Object.entries(p.fields))if(!q.fields[f]||(v.date||'')>(q.fields[f].date||''))q.fields[f]=v;q.messages.push(...p.messages);people.delete(key);}else if(same.length>1)p.ambiguous=true;}
    const result=Object.fromEntries(subjects.map(s=>[s.id,[]]));
    for(const p of people.values())for(const id of new Set([...p.courses,...(explicit.get(personKey(p.name))||[])])){
      const s=subjects.find(s=>s.id===id);if(!s)continue;const candidate={name:p.name,email:p.email,hours:p.fields.hours?.value||'',room:p.fields.room?.value||'',phone:p.fields.phone?.value||'',notes:p.fields.notes?.value||'',fieldSources:p.fields,sources:[...new Set(p.messages.map(m=>m.uid))],sourceMeta:p.messages.slice(0,20),confirmed:!p.ambiguous&&p.confirmed.has(id)};
      if(!teacherKeys(candidate).some(k=>s.teacherDismissed?.[k]))result[id].push(candidate);
    }return result;
  }
  const api={books,extension,extensionDate,norm,teacherName,personKey,teacherKeys,teacherInfo,teacherCandidates};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CuadernoCorreoAnalisis=api;
})(typeof globalThis!=='undefined'?globalThis:this);
