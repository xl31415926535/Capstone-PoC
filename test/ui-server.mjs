// Isolated local UI test harness. Never uses the real bank or online providers.
import { createApp } from '../server.mjs';
import fs from 'node:fs';
const root = new URL('../runtime/ui-tests/', import.meta.url);
fs.mkdirSync(root, { recursive: true });
const dataDir = fs.mkdtempSync(new URL('run-', root));
const app = createApp({dataDir, providerStatus:()=>[
  {id:'replay',label:'Recorded example',available:true,model:null,detail:'ISOLATED UI TEST — temporary records, no API calls.'},
  ...['codex','gemini','openai','jev'].map(id=>({id,label:id,available:false,model:null,detail:'Disabled in the isolated UI test.'}))
]});
const item=app.store.all()[0];
app.store.update(item.id,1,r=>({...r,title:'ISOLATED UI TEST — sample record'}));
app.server.listen(4318,'127.0.0.1',()=>console.log('ISOLATED UI TEST: http://127.0.0.1:4318'));
