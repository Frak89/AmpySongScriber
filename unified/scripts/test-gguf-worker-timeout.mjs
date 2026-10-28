import assert from 'node:assert/strict';
import {startGGUFWorker} from '../src/gguf-worker-controller.js';

class NeverProducesToken {
 static created=[];
 constructor(){this.terminated=false;NeverProducesToken.created.push(this);}
 postMessage(){
  setTimeout(()=>this.onmessage?.({data:{type:'loaded',elapsedMs:10}}),2);
 }
 terminate(){this.terminated=true;}
}
class ReturnsTokens {
 static created=[];
 constructor(){this.terminated=false;ReturnsTokens.created.push(this);}
 postMessage(){
  setTimeout(()=>this.onmessage?.({data:{type:'loaded',elapsedMs:10}}),2);
  setTimeout(()=>this.onmessage?.({data:{type:'token',token:'{"noise":'}}),4);
  setTimeout(()=>this.onmessage?.({data:{type:'token',token:'"low"}'}}),6);
  setTimeout(()=>this.onmessage?.({data:{type:'result',answer:'{"noise":"low"}',chunks:2,elapsedMs:8}}),8);
 }
 terminate(){this.terminated=true;}
}
class FreezesLoading {
 static created=[];
 constructor(){this.terminated=false;FreezesLoading.created.push(this);}
 postMessage(){}
 terminate(){this.terminated=true;}
}
const common={
 file:{name:'Qwen3-0.6B-Q4_K_M.gguf',size:378*1048576},
 role:'IA1',system:'system',user:'{ }',
 timeouts:{loadMs:30,firstTokenMs:16,stallMs:18,generationMs:70}
};
const waitTooLong=startGGUFWorker({...common,WorkerClass:NeverProducesToken});
await assert.rejects(waitTooLong.promise,e=>e.ggufTimedOut===true && /nessun primo token/i.test(e.message));
assert.equal(NeverProducesToken.created[0].terminated,true,'no-token timeout MUST terminate the worker');
const observed=[];
const success=startGGUFWorker({...common,WorkerClass:ReturnsTokens,onToken:x=>observed.push(x)});
const result=await success.promise;
assert.equal(result.answer,'{"noise":"low"}');
assert.equal(observed.join(''),'{"noise":"low"}');
assert.equal(ReturnsTokens.created[0].terminated,true);
const load=startGGUFWorker({...common,WorkerClass:FreezesLoading});
await assert.rejects(load.promise,e=>e.ggufTimedOut===true && /caricamento/i.test(e.message));
assert.equal(FreezesLoading.created[0].terminated,true);
const cancelled=startGGUFWorker({...common,WorkerClass:FreezesLoading});
cancelled.cancel();
await assert.rejects(cancelled.promise,e=>e.userCancelled===true);
assert.equal(FreezesLoading.created[1].terminated,true);
console.log('PASS: GGUF model-load timeout, first-token timeout, successful streamed tokens and hard cancellation all terminate Worker.');
