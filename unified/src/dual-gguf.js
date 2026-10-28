/**
 * Two offline GGUFs, SEQUENTIALLY, never held in memory together:
 * (1) analysis of measured audio features
 * (2) independent review and bounded DSP parameter proposal
 * -> FFT.js spectral cleaner -> Basic Pitch -> MusicXML/PDF.
 *
 * GGUFs are text models, do NOT receive waveform audio. Cleaned PCM is
 * produced by actual DSP. No cloud access. No silent fallback if GGUF fails.
 */
import {saveAnalysis} from './qwen-history.js';
const $=id=>document.getElementById(id);
const MAX=1.5*1024*1024*1024;
const fileValid=f=>f&&/\.gguf$/i.test(f.name)&&f.size>=80*1024*1024&&f.size<=MAX;
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const DB=Object.freeze({
  bass:{lowcut:[30,85],highcut:[1800,6500],defaultLow:36,defaultHigh:5000},
  guitar:{lowcut:[45,150],highcut:[3500,9500],defaultLow:70,defaultHigh:8500},
  piano:{lowcut:[23,110],highcut:[3200,10000],defaultLow:35,defaultHigh:9000},
  vocals:{lowcut:[50,170],highcut:[3200,9500],defaultLow:85,defaultHigh:8400},
  drums:{lowcut:[22,95],highcut:[5000,10500],defaultLow:45,defaultHigh:10000},
  other:{lowcut:[20,120],highcut:[3800,10300],defaultLow:50,defaultHigh:9000}
});
function restrictions(stem){
 return DB[stem]||DB.other;
}
export function bounds(raw,stem){
 const r=restrictions(stem),d=raw||{};
 const cl=(val,min,max,fallback)=>{
  const f=Number(val);
  return Number.isFinite(f)?Math.max(min,Math.min(max,f)):fallback;
 };
 return {
  strength:cl(d.strength,0,.7,.3),
  lowcut:cl(d.lowcut,r.lowcut[0],r.lowcut[1],r.defaultLow),
  highcut:cl(d.highcut,r.highcut[0],r.highcut[1],r.defaultHigh)
 };
}
export function extractJSON(text){
 const str=String(text||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
 const lo=str.indexOf('{'),hi=str.lastIndexOf('}');
 if(lo<0||hi<=lo)throw Error('Il GGUF non ha generato JSON interpretabile; prova un altro modello che segua le istruzioni.');
 let obj;
 try{obj=JSON.parse(str.slice(lo,hi+1));}
 catch(e){throw Error('JSON GGUF non valido: '+e.message);}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('JSON IA non valido');
 return obj;
}
export function measureAudio(buf){
 const data=buf.getChannelData(0);
 const duration=buf.duration;
 const frame=1024,step=3072;
 const rmsList=[];
 let peak=0, sum=0,count=0,zc=0,prev=0;
 for(let i=0;i<data.length;i+=step){
  let frameSum=0,n=0;
  for(let j=i;j<Math.min(i+frame,data.length);j++){
   const x=data[j];
   peak=Math.max(peak,Math.abs(x));
   sum+=x*x;count++;frameSum+=x*x;n++;
   if(j>0&&x*prev<0)zc++;
   prev=x;
  }
  if(n>0)rmsList.push(Math.sqrt(frameSum/n));
 }
 rmsList.sort((a,b)=>a-b);
 const rms=Math.sqrt(sum/Math.max(1,count));
 const percentile=q=>rmsList[Math.min(rmsList.length-1,Math.floor((rmsList.length-1)*q))]||0;
 const db=x=>Number((20*Math.log10(Math.max(1e-7,x))).toFixed(1));
 return {
  durationSec:Number(duration.toFixed(2)),
  sampleRate:buf.sampleRate,
  rmsDb:db(rms),
  peakDb:db(peak),
  quietFrameDb:db(percentile(.2)),
  loudFrameDb:db(percentile(.8)),
  sampledZeroCrossRatio:Number((zc/Math.max(1,count)).toFixed(3))
 };
}
async function inference(file,role,system,user,onStatus){
 if(!fileValid(file))throw Error(role+': file GGUF non selezionato o dimensione non valida');
 let llm=null;
 try{
  const {Wllama}=await import('@wllama/wllama/esm/index.js');
  llm=new Wllama({default:'/wllama/wllama.wasm'},{allowOffline:true});
  onStatus(role+': caricamento di '+file.name+' dalla cartella Download…');
  await llm.loadModel([file],{n_ctx:1536,n_batch:128,n_threads:1,n_gpu_layers:0});
  onStatus(role+': modello pronto. Generazione dei parametri…');
  const generated=await llm.createChatCompletion({
   messages:[{role:'system',content:system},{role:'user',content:user+' /no_think'}],
   temperature:.12,top_p:.85,max_tokens:230,stream:false
  });
  const answer=String(generated?.choices?.[0]?.message?.content||'');
  if(!answer.trim())throw Error(role+': il modello non ha restituito alcuna risposta.');
  return {parsed:extractJSON(answer),raw:answer.slice(0,2000)};
 }catch(e){
  throw Error(role+' non disponibile: '+String(e?.message||e)+'. Alcuni GGUF non sono compatibili con la memoria WebView del telefono.');
 }finally{
  if(llm){
   onStatus(role+': rilascio memoria prima della fase successiva…');
   try{await llm.exit()}catch(e){onStatus(role+': impossibile rilasciare completamente il modello: '+e.message);}
  }
  await pause();
 }
}
function cleaningWorker(input,params,onProgress){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./audio-cleaner-worker.js',import.meta.url),{type:'module'});
  let complete=false;
  const finish=(err,output)=>{
   if(complete)return;
   complete=true;worker.terminate();
   err?reject(err):resolve(output);
  };
  worker.onerror=e=>finish(new Error('Pulizia FFT non riuscita: '+(e.message||'Worker')));
  worker.onmessage=e=>{
   const d=e.data;
   if(d?.type==='progress')onProgress?.(d.percent);
   else if(d?.type==='error')finish(new Error(d.message));
   else if(d?.type==='done')finish(null,d.samples);
  };
  worker.postMessage({type:'clean',samples:input,params},[input.buffer]);
 });
}
export function initDualGGUF({getSource,ensureSource,transcribe,exportFile,getSong,onResult}){
 const fileA=$('ggufAnalyst'),fileB=$('ggufReviewer'),button=$('ggufRun');
 const status=$('ggufStatus'),log=$('ggufLog'),download=$('ggufCleanWav'),report=$('ggufReport');
 let busy=false,cleanedBuffer=null,lastReport=null;
 const say=text=>{status.textContent=text;};
 const logText=text=>{log.textContent=text;};
 function update(){
  button.disabled=busy||!fileValid(fileA.files?.[0])||!fileValid(fileB.files?.[0]);
  if(!busy&&fileValid(fileA.files?.[0])&&fileValid(fileB.files?.[0])){
   say('Entrambi i GGUF selezionati. Primo modello → secondo modello → FFT → spartito.');
  }
 }
 for(const f of [fileA,fileB])f.addEventListener('change',update);
 button.onclick=async()=>{
  if(busy)return;
  busy=true;update();download.disabled=true;report.disabled=true;
  cleanedBuffer=null;lastReport=null;
  const stem=$('isolateInstrument').value;
  const firstFile=fileA.files?.[0],secondFile=fileB.files?.[0];
  try{
   if(!fileValid(firstFile)||!fileValid(secondFile))throw Error('Seleziona due file GGUF dalla cartella Download.');
   if(firstFile===secondFile)throw Error('Seleziona due file GGUF separati.');
   say('Fase 0/4: isolo la sorgente strumentale…');
   await ensureSource(stem);
   const source=getSource(stem);
   if(!source)throw Error('La separazione non è riuscita: nessun WAV isolato.');
   const off=new OfflineAudioContext(1,Math.ceil(source.duration*22050),22050);
   const node=off.createBufferSource();node.buffer=source;node.connect(off.destination);node.start();
   const mono=await off.startRendering();
   const features=measureAudio(mono);
   const r=restrictions(stem);
   const data={stem,features,source:getSong(),limits:r};
   const analyst=await inference(firstFile,'GGUF 1 - Analisi',
    'Sei una IA per l analisi musicale. Non puoi ascoltare il WAV: puoi usare solo le MISURE NUMERICHE fornite. Rispondi SOLO con un oggetto JSON: {"instrument":"bass","noise":"low/medium/high","suggestion":"breve ragione"} senza markdown. Non inventare note.',
    JSON.stringify(data),say);
   say('Fase 2/4: carico GGUF 2 per revisione e pulizia…');
   const reviewer=await inference(secondFile,'GGUF 2 - Revisione',
    'Sei un revisore tecnico DSP musicale. Hai misure numeriche e analisi di un altro LLM, ma NON ascolti WAV. Rispondi SOLO con JSON {"strength":0.25,"lowcut":40,"highcut":6000,"reason":"testo breve"}. strength da 0 a 0.7. Mantieni armoniche musicali, rimuovi solo rumore debole; non inventare note.',
    JSON.stringify({...data,firstAnalysis:analyst.parsed}),say);
   const params=bounds(reviewer.parsed,stem);
   say('Fase 3/4: il motore DSP pulisce realmente il suono residuo…');
   const cleaned=await cleaningWorker(mono.getChannelData(0).slice(),params,p=>
    say('Pulizia FFT del WAV: '+p+'%'));
   const buf=new AudioBuffer({length:cleaned.length,sampleRate:22050,numberOfChannels:1});
   buf.copyToChannel(cleaned,0);
   cleanedBuffer=buf;
   say('Fase 4/4: Basic Pitch trascrive la traccia pulita e genera il solo spartito scelto…');
   const transcribed=await transcribe(buf,stem);
   if(transcribed===false)throw Error('La trascrizione non è riuscita: controlla le note prima di esportare.');
   const record={
    when:new Date().toISOString(),instrument:stem,source:getSong(),
    firstModel:firstFile.name,secondModel:secondFile.name,
    measurements:features,analysis:analyst.parsed,review:reviewer.parsed,
    appliedDSP:params,notesEstimated:transcribed?.noteCount||null,
    explanation:'GGUF1 e GGUF2 hanno analizzato dati numerici; il filtro FFT ha elaborato l audio; Basic Pitch ha estratto le note.'
   };
   lastReport=record;
   download.disabled=false;report.disabled=false;
   logText(JSON.stringify(record,null,2));
   say('✓ Catena completata: GGUF1 → GGUF2 → pulizia WAV → Basic Pitch → MusicXML/PDF. Usa i pulsanti di download.');
   onResult?.(record);
   try{
    const result=await saveAnalysis({
     question:'Doppia IA su '+stem,
     answer:JSON.stringify(record),song:getSong(),track:stem,
     model:firstFile.name+' + '+secondFile.name,status:'complete'
    });
    say('✓ Risultato registrato localmente (id '+result.id+'). Puoi anche esportare il rapporto JSON.');
   }catch(e){say('Elaborazione completata, ma archivio locale non disponibile: '+e.message+'. Esporta il rapporto JSON.');}
  }catch(e){
   const msg=String(e?.message||e);
   say('ERRORE: '+msg);
   logText('Fase non completata: '+msg);
  }finally{busy=false;update();}
 };
 download.onclick=async()=>{
  if(!cleanedBuffer)return;
  try{
   const {encodeWav,validateWav}=await import('./wav.js');
   const blob=encodeWav(cleanedBuffer);await validateWav(blob);
   await exportFile(blob,'AmpySongScriber_'+$('isolateInstrument').value+'_cleaned.wav');
  }catch(e){say('Errore download WAV pulito: '+e.message);}
 };
 report.onclick=async()=>{
  if(!lastReport)return;
  try{
   await exportFile(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}),
    'AmpySongScriber_DualGGUF_'+Date.now()+'.json');
  }catch(e){say('Errore esportazione rapporto: '+e.message);}
 };
 return {isBusy:()=>busy};
}
