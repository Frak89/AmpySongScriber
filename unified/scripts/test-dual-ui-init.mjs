/**
 * Rev11: runtime DOM smoke test. Vite/npm build alone cannot catch JS TDZ
 * ReferenceErrors in initDualGGUF, which left "Avvia" permanently disabled.
 */
import assert from 'node:assert/strict';
import {initDualGGUF,inspectGGUFSelection} from '../src/dual-gguf.js';

class FakeEl {
 constructor(id){
  this.id=id;this.disabled=id==='ggufRun';
  this.checked=id==='ggufReuse'||id==='ggufConsoleAutoscroll';
  this.textContent='';this.files=[];this.childNodes=[];
  this.scrollHeight=0;this.scrollTop=0;this.listeners={};
 }
 addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
 append(child){this.childNodes.push(child);}
 removeChild(child){this.childNodes.splice(this.childNodes.indexOf(child),1);}
 replaceChildren(){this.childNodes=[];}
 get firstChild(){return this.childNodes[0]||null;}
 emit(name){for(const fn of this.listeners[name]||[])fn({target:this});}
}
const nodes=new Map();
globalThis.document={
 getElementById(id){if(!nodes.has(id))nodes.set(id,new FakeEl(id));return nodes.get(id);},
 createTextNode(text){return {textContent:text};}
};
globalThis.window={};
const $=id=>document.getElementById(id);
const run=$('ggufRun');
const controller=initDualGGUF({
 getSong:()=> 'brano.mp3',
 getDuration:async()=>20,
 getIsolatedChunk:async()=>{throw Error('Non deve avviare separazione senza un GGUF');},
 draftNotes:async()=>[],finishScore:async()=>({}),exportFile:async()=>{},
 onResult:()=>{}
});
assert.equal(run.disabled,false,'Run button must enable on startup');
assert.equal(typeof run.onclick,'function','Run handler must be registered');
assert.equal(typeof controller.isBusy,'function');
assert.equal($('ggufStatus').textContent.includes('GGUF 2 non selezionato'),true);
const qwen={name:'Qwen3-0.6B-Q4_K_M.gguf',size:378*1048576};
$('ggufReviewer').files=[qwen];
$('ggufReviewer').emit('change');
assert.equal(run.disabled,false,'Button must remain clickable with one GGUF');
assert.equal(inspectGGUFSelection(null,qwen,true).ok,true);
assert.equal(inspectGGUFSelection(null,null,true).ok,false);
$('ggufReviewer').files=[];
await run.onclick();
assert.equal(run.disabled,false,'Button must re-enable after preflight error');
assert.match($('ggufStatus').textContent,/GGUF 2 non selezionato/);
assert.ok($('ggufConsole').childNodes.length>0,'Diagnostic console must show messages');
console.log('PASS Rev11: no initialization TDZ, button enabled, actionable missing-file error and console works.');
process.exit(0); // console heartbeat is expected; stop this small smoke test.
