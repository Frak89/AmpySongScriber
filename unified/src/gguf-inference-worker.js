/**
 * Rev12. Isolated GGUF inference process.
 * A separate top-level Worker owns the Wllama worker so Android can force-stop
 * inference via Worker.terminate() when no token is produced.
 *
 * It reads a user-selected File handle, never uploads anything. The caller
 * enforces load/first-token/stalled-token timeouts on the main UI thread.
 */
import {Wllama} from '@wllama/wllama/esm/index.js';
const preview=value=>{
 try{
  if(typeof value==='string')return value.slice(0,1200);
  if(value instanceof Error)return (value.stack||value.message).slice(0,1200);
  return JSON.stringify(value).slice(0,1200);
 }catch{return String(value).slice(0,400);}
};
const forward=(level,...args)=>self.postMessage({
 type:'log',level,text:args.map(preview).join(' ')
});
const log={
 log:(...a)=>forward('info',...a),
 info:(...a)=>forward('info',...a),
 warn:(...a)=>forward('warn',...a),
 error:(...a)=>forward('error',...a),
 debug:()=>{}
};
let busy=false;
self.onmessage=async e=>{
 if(e.data?.type!=='run'||busy)return;
 busy=true;
 const {file,system,user,role}=e.data;
 let llm=null,answer='',chunks=0;
 const started=Date.now();
 try{
  self.postMessage({type:'stage',stage:'loading',message:role+': caricamento GGUF locale…'});
  llm=new Wllama({default:'/wllama/wllama.wasm'},{
   allowOffline:true,logger:log
  });
  await llm.loadModel([file],{
   n_ctx:768,n_batch:32,n_threads:1,n_gpu_layers:0
  });
  self.postMessage({type:'loaded',elapsedMs:Date.now()-started});
  self.postMessage({type:'stage',stage:'generating',
   message:role+': pre-elaborazione del prompt (CPU/WASM, attendendo il primo token)…'});
  await llm.createChatCompletion({
   messages:[
    {role:'system',content:system},
    {role:'user',content:user+' /no_think'}
   ],
   chat_template_kwargs:{enable_thinking:false},
   temperature:.1,top_p:.82,max_tokens:112,
   stream:true,
   onData:part=>{
    chunks++;
    const delta=part?.choices?.[0]?.delta;
    const token=String(delta?.content||delta?.reasoning_content||'');
    if(token){answer+=token;self.postMessage({type:'token',token});}
    if(part?.choices?.[0]?.finish_reason)self.postMessage({
     type:'finishReason',reason:String(part.choices[0].finish_reason)
    });
   }
  });
  if(!answer.trim())throw Error('Il modello non ha emesso testo: '+chunks+' eventi di streaming.');
  self.postMessage({type:'result',answer:answer.slice(0,3600),chunks,
   elapsedMs:Date.now()-started});
 }catch(error){
  self.postMessage({type:'error',message:preview(error)});
 }finally{
  if(llm){
   try{await llm.exit();}
   catch(error){forward('warn','Rilascio GGUF: '+preview(error));}
  }
  self.postMessage({type:'finished'});
  busy=false;
 }
};
