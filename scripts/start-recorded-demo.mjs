// Replay saved real-run evidence in a fresh, isolated bank. No online providers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port=Number(process.argv[2]||4319);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose a port from 1024 to 65535.');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'examples',name),'utf8'));
const snapshots=read('questions-v2.json').records;
if(snapshots.some(r=>r.status!=='draft'||r.reviewEvents.length))throw new Error('Recorded evidence must be unapproved drafts.');
const directory=path.join(root,'runtime','recorded-demos');
fs.mkdirSync(directory,{recursive:true});
const dataDir=fs.mkdtempSync(path.join(directory,'demo-'));
const records=snapshots.map(r=>({...r,title:'Recorded run · '+r.title,provenance:{...r.provenance,originalMode:r.provenance.mode,mode:'replay',label:'Saved actual Codex output from 29 Sep 2026 · no new model call in this demo'}}));
fs.writeFileSync(path.join(dataDir,'records.json'),JSON.stringify({schemaVersion:1,records},null,2));
fs.mkdirSync(path.join(dataDir,'evaluations'));
const batches=['evaluation-v2.json','evaluation-v2-first-run.json'].map(name=>{const {rows,metrics,definitions,...batch}=read(name);return batch;});
fs.writeFileSync(path.join(dataDir,'evaluations','records.json'),JSON.stringify({schemaVersion:1,records:batches},null,2));
const app=createApp({dataDir,seed:false,providerStatus:()=>[
 {id:'replay',label:'Recorded example',available:true,model:null,detail:'Saved evidence only. Online calls are disabled in this demonstration.'},
 ...['codex','gemini','openai','jev'].map(id=>({id,label:id,available:false,model:null,detail:'Disabled in recorded demonstration. Use start-local.ps1 for configured live providers.'}))
]});
app.server.listen(port,'127.0.0.1',()=>{
 console.log('RECORDED EVIDENCE DEMO: http://127.0.0.1:'+port);
 console.log('17 saved drafts, 2 historical reports. No online model calls. Review decisions are demo-only.');
 console.log('Isolated demo data: '+dataDir);
});
