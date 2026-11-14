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
  const api={books,extension,extensionDate,norm};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CuadernoCorreoAnalisis=api;
})(typeof globalThis!=='undefined'?globalThis:this);
