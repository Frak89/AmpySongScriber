/**
 * Rev12 lifecycle for GGUF worker. The worker can be terminated even if the
 * nested llama.cpp WASM is stuck in CPU prompt-prefill and never sends tokens.
 *
 * This is a real hard deadline, not a fake progress percentage.
 * Max model load 90s; max wait for first token 50s; max inter-token idle 35s;
 * max overall generation 125s. Defaults may be overridden for unit tests.
 */
export const GGUF_TIMEOUTS=Object.freeze({
 loadMs:90000,firstTokenMs:50000,stallMs:35000,generationMs:125000
});
export function startGGUFWorker({
 file,role,system,user,
 onStage=()=>{},onToken=()=>{},onLog=()=>{},
 timeouts=GGUF_TIMEOUTS
}){
 let worker=null,settled=false,loadTimer=null,idleTimer=null,totalTimer=null;
 let gotText=false,observedChunks=0;
 let resolveWork,rejectWork;
 const promise=new Promise((resolve,reject)=>{resolveWork=resolve;rejectWork=reject;});
 const cleanup=()=>{
  for(const timer of [loadTimer,idleTimer,totalTimer])if(timer!==null)clearTimeout(timer);
  loadTimer=idleTimer=totalTimer=null;
  if(worker){worker.onmessage=null;worker.onerror=null;worker.terminate();worker=null;}
 };
 const complete=(error,result)=>{
  if(settled)return;
  settled=true;
  cleanup();
  error?rejectWork(error):resolveWork(result);
 };
 function failed(reason,kind='runtime'){
  const error=new Error(reason);
  error.ggufReason=kind;
  error.ggufTimedOut=kind==='timeout';
  error.userCancelled=kind==='cancelled';
  onLog({level:kind==='cancelled'?'warn':'error',text:reason});
  complete(error);
 }
 const countdown=(ms,label)=>setTimeout(()=>failed(label+' dopo '+Math.round(ms/1000)+' secondi senza completare. Worker GGUF terminato.','timeout'),ms);
 try{
  worker=new Worker(new URL('./gguf-inference-worker.js',import.meta.url),{type:'module'});
  onStage(role+' · inizializzazione Worker GGUF isolato');
  loadTimer=countdown(timeouts.loadMs,role+': caricamento modello oltre soglia');
  worker.onerror=e=>failed(role+': errore Worker/WASM: '+String(e?.message||e?.type||'sconosciuto'));
  worker.onmessage=e=>{
   if(settled)return;
   const d=e.data||{};
   if(d.type==='stage'){
    onStage(d.message||role+': '+(d.stage||'fase sconosciuta'));
   }else if(d.type==='log'){
    onLog({level:d.level||'info',text:d.text||''});
   }else if(d.type==='loaded'){
    if(loadTimer!==null)clearTimeout(loadTimer);loadTimer=null;
    onLog({level:'info',text:role+': GGUF caricato in '+(d.elapsedMs/1000).toFixed(1)+' s; attendo il primo token.'});
    idleTimer=countdown(timeouts.firstTokenMs,role+': nessun primo token');
    totalTimer=countdown(timeouts.generationMs,role+': inferenza oltre limite totale');
   }else if(d.type==='token'){
    const part=String(d.token||'');
    if(!part)return;
    gotText=true;observedChunks++;
    if(idleTimer!==null)clearTimeout(idleTimer);
    idleTimer=countdown(timeouts.stallMs,role+': interruzione del flusso token');
    onToken(part);
   }else if(d.type==='finishReason'){
    onLog({level:'info',text:role+': motivo terminazione '+d.reason});
   }else if(d.type==='result'){
    onLog({level:'info',text:role+': generazione completata in '+(d.elapsedMs/1000).toFixed(1)+' s; frammenti testuali '+observedChunks});
    complete(null,{answer:String(d.answer||''),chunks:d.chunks||observedChunks,gotText});
   }else if(d.type==='error'){
    failed(role+': '+String(d.message||'errore non specificato'));
   }
  };
  worker.postMessage({type:'run',file,role,system,user});
 }catch(error){
  complete(new Error(role+': impossibile avviare Worker locale: '+String(error?.message||error)));
 }
 return {
  promise,
  cancel:()=>failed(role+': interrotto manualmente; il Worker è stato terminato.','cancelled'),
  isSettled:()=>settled
 };
}
