'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const factoryPromise = require('hunspell-asm').loadModule();
const dictionaries = new Map();
async function dictionary(lang) {
  lang=lang==='ca'?'ca':'es';
  if(!dictionaries.has(lang)) dictionaries.set(lang,(async()=>{const factory=await factoryPromise,dir=path.dirname(require.resolve('dictionary-'+lang)),aff=factory.mountBuffer(fs.readFileSync(path.join(dir,'index.aff')),lang+'.aff'),dic=factory.mountBuffer(fs.readFileSync(path.join(dir,'index.dic')),lang+'.dic');return factory.create(aff,dic);})());
  return dictionaries.get(lang);
}
parentPort.on('message', async request => {
  try {const spell=await dictionary(request.lang);for(const word of request.personal||[])spell.addWord(word);
    const results=(request.words||[]).filter(word=>typeof word==='string'&&word.length<=80).map(word=>({word,correct:spell.spell(word),suggestions:request.suggest?spell.suggest(word).slice(0,8):[]}));
    parentPort.postMessage({id:request.id,results});
  }catch(e){parentPort.postMessage({id:request.id,error:e.message});}
});
