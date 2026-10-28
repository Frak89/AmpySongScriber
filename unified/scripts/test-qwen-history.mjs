import assert from 'node:assert/strict';
import {saveAnalysis,listAnalyses,deleteAnalysis,analysisText,safeRecord} from '../src/qwen-history.js';
const store=new Map();
globalThis.localStorage={
 getItem(key){return store.has(key)?store.get(key):null;},
 setItem(key,value){store.set(key,String(value));},
 removeItem(key){store.delete(key);}
};
const createdAt='2026-10-28T06:05:00.000Z';
const record={createdAt,question:'Come correggere le note del basso?',answer:'',song:'prova.wav',track:'basso',model:'Qwen3-0.6B-Q4_K_M.gguf',status:'pending'};
const pending=await saveAnalysis(record);
assert.equal(pending.storage,'localstorage');
assert.ok(pending.id);
let records=await listAnalyses();
assert.equal(records.length,1);
assert.equal(records[0].status,'pending');
const saved=await saveAnalysis({...record,id:pending.id,status:'complete',answer:'Rivedere l ottava del basso e il BPM.'});
assert.equal(saved.id,pending.id);
records=await listAnalyses();
assert.equal(records.length,1);
assert.equal(records[0].status,'complete');
assert.match(analysisText(records[0]),/Rivedere l ottava/);
assert.match(analysisText(records[0]),/prova.wav/);
await deleteAnalysis(records[0]);
assert.equal((await listAnalyses()).length,0);
assert.throws(()=>safeRecord({question:'',answer:'Test'}),/Domanda vuota/);
console.log('PASS Qwen local history: request saved, response updated, export text, delete, validation');
