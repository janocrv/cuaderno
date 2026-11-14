'use strict';
// All network operations are explicit calls from the mail UI. Never used by tests
// against a real account: dependencies can be replaced with local fakes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
module.exports = function createMailSuite({ settings, password, client, userDir, filesDir, parseMessage, smtp, nodemailer = require('nodemailer') }) {
  const busy = new Set();
  const account = () => { const a = settings(), pw = password(); if (!a.user || !pw) throw new Error('Conecta primero tu cuenta de la UV en Ajustes.'); return { a, pw }; };
  const dir = () => { const {a}=account(); const d=path.join(userDir(), 'correo-'+a.user);fs.mkdirSync(d,{recursive:true});return d; };
  const read = name => { try{return JSON.parse(fs.readFileSync(path.join(dir(),name+'.json'),'utf8'));}catch(_){return {};} };
  const write = (name,data) => {const f=path.join(dir(),name+'.json');fs.writeFileSync(f+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(f+'.tmp',f);};
  async function withClient(action) {const {a,pw}=account(),c=client(a.user,pw);try{await c.connect();return await action(c);}finally{try{await c.logout();}catch(_){try{c.close();}catch(_){}}}}
  const folderName = value => {const s=String(value||'INBOX');if(s.length>512 || /[\r\n\0]/.test(s))throw new Error('Carpeta no válida.');return s;};
  const validId = id => /^[\w-]{1,100}$/.test(String(id||''));
  function addresses(value) {
    if(/[\r\n]/.test(String(value||'')))throw new Error('Revisa las direcciones de correo.');
    const values=require('nodemailer/lib/addressparser')(String(value||'').replace(/;/g,','));
    if(values.some(v=>v.group || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v.address||'')))throw new Error('Hay una dirección de correo que no es válida.');
    return values;
  }
  async function original(c,folder,uid) {
    if(!/^\d+$/.test(String(uid)))throw new Error('Mensaje no válido.');
    const lock=await c.getMailboxLock(folderName(folder),{readOnly:true});
    try{const msg=await c.fetchOne(String(uid),{source:true},{uid:true});if(!msg?.source)throw new Error('No se encuentra este mensaje.');return await require('mailparser').simpleParser(msg.source);}
    finally{lock.release();}
  }
  return {
    drafts() { return Object.values(read('borradores')).sort((a,b)=>b.updated-a.updated); },
    saveDraft(d) { const id=validId(d.id)?d.id:crypto.randomUUID(),rows=read('borradores'); rows[id]={id,to:String(d.to||'').slice(0,5000),cc:String(d.cc||'').slice(0,5000),bcc:String(d.bcc||'').slice(0,5000),subject:String(d.subject||'').slice(0,500),text:String(d.text||'').slice(0,200000),attachments:Array.isArray(d.attachments)?d.attachments.slice(0,30):[],inReplyTo:String(d.inReplyTo||'').replace(/[\r\n]/g,'').slice(0,500),references:String(d.references||'').replace(/[\r\n]/g,'').slice(0,2000),updated:Date.now()};write('borradores',rows);return rows[id]; },
    deleteDraft(id) {const rows=read('borradores');delete rows[id];write('borradores',rows);},
    folders() {return withClient(async c=>(await c.list()).filter(f=>!f.flags?.has('\\Noselect')).map(f=>({path:f.path,name:f.name,specialUse:f.specialUse||''})));},
    messages(folder) {return withClient(async c=>{folder=folderName(folder);const lock=await c.getMailboxLock(folder,{readOnly:true});try{
      const ids=((await c.search({since:new Date(Date.now()-90*864e5)},{uid:true}))||[]).map(Number).sort((a,b)=>b-a).slice(0,100);const mails=[];
      for(let start=0;start<ids.length;start+=15){const raw=[];for await(const msg of c.fetch(ids.slice(start,start+15),{uid:true,flags:true,source:true},{uid:true}))raw.push(msg);for(const msg of raw)mails.push(await parseMessage(String(msg.uid),msg.flags,msg.source));}
      return mails.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    }finally{lock.release();}});},
    attachment(folder,uid,index) {return withClient(async c=>{const m=await original(c,folder,uid),attachments=(m.attachments||[]).filter(a=>a.filename&&!a.related),a=attachments[Number(index)];if(!a)throw new Error('No se encuentra el adjunto.');return {filename:a.filename,mime:a.contentType,content:a.content};});},
    async send(d) {
      const {a,pw}=account();if(!validId(d.id))throw new Error('Guarda el borrador antes de enviarlo.');
      const outcomes=read('envios');if(outcomes[d.id]?.sent)return outcomes[d.id];
      if(busy.has(d.id))throw new Error('Este mensaje ya se está enviando.');
      if(outcomes[d.id]?.pending)throw new Error('No se pudo confirmar el envío anterior. Revisa Enviados antes de volver a enviarlo.');
      const to=addresses(d.to),cc=addresses(d.cc),bcc=addresses(d.bcc);if(!to.length&&!cc.length&&!bcc.length)throw new Error('Añade al menos un destinatario.');
      if(to.length+cc.length+bcc.length>100)throw new Error('Hay demasiados destinatarios.');
      if(/[\r\n]/.test(String(d.subject||'')))throw new Error('El asunto debe ocupar una sola línea.');
      let total=0;const attachments=(d.attachments||[]).map(f=>{if(!validId(f.id))throw new Error('Adjunto no válido.');const filename=String(f.name||'archivo').replace(/[\\/\r\n\0]/g,'_'),file=path.join(filesDir(),f.id+'.bin');if(!fs.existsSync(file))throw new Error('No se ha podido cargar el adjunto «'+filename+'».');total+=fs.statSync(file).size;return {filename,path:file,contentType:f.mime||'application/octet-stream'};});
      if(total>20*1024*1024)throw new Error('Los adjuntos superan los 20 MB.');
      const stateFile=path.join(settings().dataDir||path.join(userDir(),'datos'),'cuaderno-datos.json');let personal={};try{personal=JSON.parse(fs.readFileSync(stateFile,'utf8')).settings||{};}catch(_){}
      const sender=/^[^\s@]+@(?:alumni\.)?uv\.es$/i.test(personal.myEmail||'')?personal.myEmail:a.user+'@alumni.uv.es';
      const message={from:{name:personal.userName||'',address:sender},to,cc,bcc,subject:String(d.subject||''),text:String(d.text||''),attachments,messageId:`<cuaderno-${d.id}@${sender.split('@')[1]}>`};
      if(d.inReplyTo&&!/[\r\n]/.test(d.inReplyTo))message.inReplyTo=d.inReplyTo;
      if(d.references&&!/[\r\n]/.test(d.references))message.references=d.references;
      const composer=new (require('nodemailer/lib/mail-composer'))(message).compile();composer.keepBcc=false;
      const raw={message:await new Promise((resolve,reject)=>composer.build((error,buffer)=>error?reject(error):resolve(buffer))),envelope:composer.getEnvelope(),messageId:message.messageId};
      busy.add(d.id);outcomes[d.id]={pending:true,date:new Date().toISOString()};write('envios',outcomes);
      try{
        const transport=nodemailer.createTransport({...smtp,secure:false,requireTLS:true,auth:{user:a.user,pass:pw}});
        const result=await transport.sendMail({envelope:raw.envelope,raw:raw.message});
        if(result.rejected?.length && !result.accepted?.length)throw Object.assign(new Error('El servidor rechazó los destinatarios.'),{responseCode:550});
        const outcome={sent:true,date:new Date().toISOString(),messageId:raw.messageId,warning:result.rejected?.length?'Algunos destinatarios fueron rechazados: '+result.rejected.join(', '):''};
        outcomes[d.id]=outcome;write('envios',outcomes);this.deleteDraft(d.id);
        try{await withClient(async c=>{const folders=await c.list();let sent=folders.find(f=>f.specialUse==='\\Sent')||folders.find(f=>/^(?:inbox[./])?(?:sent|sent messages|enviados|enviats)$/i.test(f.path));let folder=sent?.path;if(!folder){folder='Sent';await c.mailboxCreate(folder);}await c.append(folder,raw.message,['\\Seen']);});outcome.savedToSent=true;}
        catch(_){outcome.savedToSent=false;outcome.warning+=(outcome.warning?' ':'')+'El mensaje se envió, pero no se pudo guardar una copia en Enviados. No lo vuelvas a enviar.';}
        outcomes[d.id]=outcome;write('envios',outcomes);return outcome;
      }catch(e){if(e.responseCode>=400){delete outcomes[d.id];write('envios',outcomes);}throw e;}
      finally{busy.delete(d.id);}
    },
  };
};
