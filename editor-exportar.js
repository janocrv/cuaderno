'use strict';
// Keep Cuaderno's paragraph geometry, tab stops and individual list markers in
// DOCX. The HTML converter handles runs/images/tables; this repairs properties
// it does not support. Tokens are random, local to this single export.
const crypto=require('crypto'),htmlparser=require('htmlparser2'),JSZip=require('jszip');
const {DOMParser,XMLSerializer}=require('@xmldom/xmldom');
const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const escapeText=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function styles(node){return Object.fromEntries(String(node.attribs?.style||'').split(';').map(s=>s.split(/:(.*)/s)).filter(a=>a.length>1).map(([k,v])=>[k.trim().toLowerCase(),v.trim()]));}
function twips(value,font=12){
 const s=String(value||'').trim();let m=s.match(/^(max|min)\((.*)\)$/i);if(m){const nums=m[2].split(',').map(v=>twips(v,font));return nums.every(Number.isFinite)?Math[m[1].toLowerCase()](...nums):null;}
 m=s.match(/^calc\((.+?)\s+([+-])\s+(.+)\)$/i);if(m){const a=twips(m[1],font),b=twips(m[3],font);return a!==null&&b!==null?a+(m[2]==='+'?b:-b):null;}
 m=s.match(/^(-?[\d.]+)(px|pt|cm|mm|em|rem)?$/i);if(!m||!Number.isFinite(Number(m[1])))return null;
 return Math.round(Number(m[1])*({px:15,pt:20,cm:1440/2.54,mm:1440/25.4,em:font*20,rem:240}[m[2]?.toLowerCase()]||20));
}
const children=(el,local)=>Array.from(el.childNodes||[]).filter(n=>n.nodeType===1&&n.namespaceURI===W&&n.localName===local);
const first=(el,local)=>children(el,local)[0];
function child(doc,el,local,prepend=false){let n=first(el,local);if(!n){n=doc.createElementNS(W,'w:'+local);if(prepend)el.insertBefore(n,el.firstChild);else el.appendChild(n);}return n;}
const attr=(el,name)=>el?.getAttributeNS(W,name)||el?.getAttribute('w:'+name);
const set=(el,name,value)=>el.setAttributeNS(W,'w:'+name,String(value));
module.exports=async function exportDocument({html,title,header,footer},sanitize){
 const nonce='CUADERNO_'+crypto.randomBytes(12).toString('hex'),tabToken=nonce+'_TAB_',meta=[],lists=new Map(),nodes=htmlparser.parseDOM(sanitize(html),{decodeEntities:true});
 const formats={'1':'decimal',a:'lower-alpha',A:'upper-alpha',i:'lower-roman',I:'upper-roman'};
 function prepare(list){
  const css=styles(list);if(list.name==='ol'&&!css['list-style-type']){css['list-style-type']=formats[list.attribs.type]||'decimal';list.attribs.style=Object.entries(css).map(([k,v])=>k+':'+v).join(';');}
  const items=(list.children||[]).filter(n=>n.name==='li'),special=css['list-style-type']==='none'||items.some(li=>li.attribs.value!==undefined||styles(li)['list-style-type']||li.attribs['data-marker-bold']||li.attribs['data-marker-italic']);
  let counter=Number(list.attribs.start);if(!Number.isInteger(counter))counter=1;if(list.name==='ol')list.attribs['data-start']=String(counter);
  for(const li of items){const own=Number(li.attribs.value);if(li.attribs.value!==undefined&&Number.isInteger(own))counter=own;
   lists.set(li,{number:counter++,style:styles(li)['list-style-type']||css['list-style-type']||(list.name==='ol'?'decimal':'disc'),bold:li.attribs['data-marker-bold']==='true',italic:li.attribs['data-marker-italic']==='true',special,first:true});
   // Native HTML may have bare text inside LI. Give it the same paragraph
   // boundary Tiptap uses, without moving nested lists into that paragraph.
   let inline=[];const result=[];const flush=()=>{if(!inline.length)return;if(!inline.some(n=>n.type!=='text'||n.data.trim())){inline=[];return;}const p={type:'tag',name:'p',attribs:{},parent:li,children:inline};inline.forEach(n=>n.parent=p);result.push(p);inline=[];};
   for(const n of li.children||[]){if(['p','h1','h2','h3','h4','ul','ol','table','blockquote'].includes(n.name)){flush();result.push(n);}else inline.push(n);}flush();li.children=result;
  }
 }
 function visit(node,inherited={},listItem=null){
  if(node.type!=='tag')return;
  if(['ol','ul'].includes(node.name))prepare(node);
  if(node.name==='li')listItem=lists.get(node)||null;
  const css={...inherited,...styles(node)};
  if(['td','th'].includes(node.name)&&!css.width&&node.attribs.colwidth){const widths=node.attribs.colwidth.split(',').map(Number);if(widths.length&&widths.every(n=>Number.isFinite(n)&&n>0))node.attribs.style=(node.attribs.style||'')+';width:'+widths.reduce((a,b)=>a+b,0)+'px';}
  if(node.name==='span'&&node.attribs['data-doc-tab']!==undefined){node.children=[{type:'text',data:tabToken,parent:node}];return;}
  if(/^p$|^h[1-6]$/.test(node.name)){
   const token=nonce+'_P'+meta.length+'_',marker=listItem?.first?{...listItem}:null;if(marker)listItem.first=false;
   meta.push({token,css,marker});node.children||=[];node.children.unshift({type:'text',data:token,parent:node});
  }
  const textStyles=Object.fromEntries(Object.entries(css).filter(([key])=>['line-height','font-size','font-family','font-weight','font-style','color','text-indent'].includes(key)));
  for(const n of node.children||[])visit(n,textStyles,listItem);
 }
 nodes.forEach(n=>visit(n));const content=nodes.map(n=>htmlparser.DomUtils.getOuterHTML(n)).join('');
 const region=s=>'<p>'+escapeText(s).replace(/\r?\n/g,'<br>')+'</p>';
 const buffer=await require('html-to-docx')('<!DOCTYPE html><html><body>'+content+'</body></html>',region(header),{title:title||'Apunte',creator:'Cuaderno',font:'Arial',fontSize:24,pageSize:{width:11906,height:16838},margins:{top:960,right:1020,bottom:960,left:1020,header:400,footer:400,gutter:0},header:!!header,footer:!!footer,table:{row:{cantSplit:true}}},region(footer));
 const zip=await JSZip.loadAsync(buffer),parser=new DOMParser(),doc=parser.parseFromString(await zip.file('word/document.xml').async('string'),'application/xml'),numbering=zip.file('word/numbering.xml')?parser.parseFromString(await zip.file('word/numbering.xml').async('string'),'application/xml'):null;
 const entries=new Map(meta.map(m=>[m.token,m])),tokenRx=new RegExp(nonce+'_P\\d+_','g');
 const body=doc.getElementsByTagNameNS(W,'body')[0];let seenBodyParagraph=false;
 let nextAbstract=numbering?Math.max(0,...Array.from(numbering.getElementsByTagNameNS(W,'abstractNum')).map(n=>Number(attr(n,'abstractNumId'))||0))+1:1;
 let nextNumber=numbering?Math.max(0,...Array.from(numbering.getElementsByTagNameNS(W,'num')).map(n=>Number(attr(n,'numId'))||0))+1:1;
 for(const p of Array.from(doc.getElementsByTagNameNS(W,'p'))){
  let info;for(const t of Array.from(p.getElementsByTagNameNS(W,'t'))){const value=t.textContent;const found=value.match(tokenRx);if(found){info=entries.get(found[0]);t.textContent=value.replace(tokenRx,'');}}
  if(!info){if(!seenBodyParagraph&&p.parentNode===body&&!p.textContent.trim()&&!p.getElementsByTagNameNS(W,'drawing').length&&!p.getElementsByTagNameNS(W,'br').length&&!p.getElementsByTagNameNS(W,'numPr').length)body.removeChild(p);continue;}
  if(p.parentNode===body)seenBodyParagraph=true;
  const props=child(doc,p,'pPr',true),css=info.css,font=(twips(css['font-size'])||240)/20;
  if(css['line-height']||css['margin-top']||css['margin-bottom']){
   const spacing=child(doc,props,'spacing');for(const [name,key] of [['before','margin-top'],['after','margin-bottom']]){const n=twips(css[key],font);if(n!==null)set(spacing,name,Math.max(0,n));}
   const line=String(css['line-height']||'');if(/^[\d.]+%?$/.test(line)){set(spacing,'line',Math.round(parseFloat(line)*(line.endsWith('%')?2.4:240)));set(spacing,'lineRule','auto');}
   else if(line){const n=twips(line,font);if(n!==null&&n>0){set(spacing,'line',n);set(spacing,'lineRule','exact');}}
  }
  for(const [name,key] of [['left','margin-left'],['firstLine','text-indent']]){const n=twips(css[key],font);if(n===null)continue;const ind=child(doc,props,'ind');set(ind,name==='firstLine'&&n<0?'hanging':name,name==='left'?n:Math.abs(n));}
  const marker=info.marker,numPr=first(props,'numPr');if(!marker?.special||!numPr||!numbering)continue;
  const oldNum=Array.from(numbering.getElementsByTagNameNS(W,'num')).find(n=>attr(n,'numId')===attr(first(numPr,'numId'),'val'));
  const oldAbstract=Array.from(numbering.getElementsByTagNameNS(W,'abstractNum')).find(n=>attr(n,'abstractNumId')===attr(first(oldNum||{},'abstractNumId'),'val'));if(!oldAbstract)continue;
  const clone=oldAbstract.cloneNode(true),abstractId=nextAbstract++,numId=nextNumber++,level=attr(first(numPr,'ilvl'),'val')||'0';set(clone,'abstractNumId',abstractId);
  const lvl=children(clone,'lvl').find(n=>attr(n,'ilvl')===level)||children(clone,'lvl')[0];if(!lvl)continue;
  const format={decimal:'decimal','lower-alpha':'lowerLetter','upper-alpha':'upperLetter','lower-roman':'lowerRoman','upper-roman':'upperRoman',none:'none'}[marker.style];
  set(child(numbering,lvl,'start'),'val',marker.number);set(child(numbering,lvl,'numFmt'),'val',format||'bullet');set(child(numbering,lvl,'lvlText'),'val',format==='none'?'':format?'%'+(Number(level)+1)+'.':({circle:'◦',square:'▪',disc:'•'}[marker.style]||marker.style.replace(/["']/g,'').trim()||'•'));
  const run=child(numbering,lvl,'rPr');if(marker.bold)set(child(numbering,run,'b'),'val','1');if(marker.italic)set(child(numbering,run,'i'),'val','1');
  numbering.documentElement.insertBefore(clone,first(numbering.documentElement,'num')||null);const num=numbering.createElementNS(W,'w:num');set(num,'numId',numId);set(child(numbering,num,'abstractNumId'),'val',abstractId);numbering.documentElement.appendChild(num);set(child(doc,numPr,'numId'),'val',numId);
 }
 for(const t of Array.from(doc.getElementsByTagNameNS(W,'t'))){if(!t.textContent.includes(tabToken))continue;const pieces=t.textContent.split(tabToken),parent=t.parentNode;pieces.forEach((piece,index)=>{if(index)parent.insertBefore(doc.createElementNS(W,'w:tab'),t);if(piece){const next=doc.createElementNS(W,'w:t');next.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');next.appendChild(doc.createTextNode(piece));parent.insertBefore(next,t);}});parent.removeChild(t);}
 // OOXML requires section properties after the body's paragraphs/tables.
 const section=first(body,'sectPr');if(section)body.appendChild(section);
 const serializer=new XMLSerializer();zip.file('word/document.xml',serializer.serializeToString(doc));if(numbering)zip.file('word/numbering.xml',serializer.serializeToString(numbering));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
};
