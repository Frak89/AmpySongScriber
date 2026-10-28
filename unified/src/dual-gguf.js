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
import {createPartBuffer,reopenLastPartBuffer} from './part-buffer.js';
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
const SEGMENT_SEC=10;
const FRAME_RATE=22050;
function sliceMono(source,startFrame,count){
 const b=new AudioBuffer({numberOfChannels:1,length:count,sampleRate:FRAME_RATE});
 b.copyToChannel(source.getChannelData(0).subarray(startFrame,startFrame+count),0);
 return b;
}
function reviseNotes(draft,clean,proposals,stem){
 // Two GGUFs can ask for conservative rejection of artifacts, never invent notes.
 // A cleaned note must be supported acoustically by Basic Pitch itself.
 const raw=(clean||[]).filter(n=>Number.isFinite(n.pitch)&&Number.isFinite(n.start)&&n.duration>0);
 const maxReject=Math.min(.18,Math.max(.05,Number(proposals?.rejectShorterThan)||.055));
 const requireConfirmation=proposals?.suppressUnconfirmed===true;
 return raw.filter(n=>{
  if(n.duration<maxReject)return false;
  if(!requireConfirmation||n.duration>.20)return true;
  return draft.some(d=>d.pitch===n.pitch&&Math.abs(d.start-n.start)<.16);
 });
}
function isolateDraft(notes){
 return notes.slice(0,70).map((n,i)=>({
  index:i,midi:n.pitch,start:Number(n.start.toFixed(3)),duration:Number(n.duration.toFixed(3))
 }));
}
export function initDualGGUF({getSource,ensureSource,draftNotes,finishScore,exportFile,getSong,onResult}){
 const fileA=$('ggufAnalyst'),fileB=$('ggufReviewer'),button=$('ggufRun');
 const pause=$('ggufPause'),status=$('ggufStatus'),log=$('ggufLog'),
  download=$('ggufCleanWav'),partsDownload=$('ggufPartsZip'),
  report=$('ggufReport'),progress=$('ggufProgress');
 let busy=false,pauseRequested=false,partBuffer=null,lastReport=null;
 const say=text=>{status.textContent=text;};
 const logText=text=>{log.textContent=text;};
 function update(){
  button.disabled=busy||!fileValid(fileA.files?.[0])||!fileValid(fileB.files?.[0]);
  pause.disabled=!busy;
  if(!busy&&fileValid(fileA.files?.[0])&&fileValid(fileB.files?.[0])){
   say('GGUF 1 e GGUF 2 pronti. Verranno caricati uno alla volta per ogni blocco.');
  }
 }
 for(const f of [fileA,fileB])f.addEventListener('change',update);
 pause.onclick=()=>{
  if(!busy)return;
  pauseRequested=true;
  pause.disabled=true;
  say('⏸ Pausa richiesta: concludo il blocco corrente e salvo partN.wav prima di fermarmi.');
 };
 async function exportFinal(){
  if(!partBuffer)return;
  try{
   say('Unione progressiva dei partN.wav in un unico WAV PCM16…');
   const final=await partBuffer.shareFinal();
   if(final.blob)await exportFile(final.blob,final.filename);
   say('WAV finale unito: '+partBuffer.sessionSummary().parts.length+' blocchi, '+(partBuffer.sessionSummary().totalSamples/FRAME_RATE).toFixed(1)+' secondi.');
  }catch(e){say('Unione WAV fallita: '+e.message);}
 }
 download.onclick=exportFinal;
 partsDownload.onclick=async()=>{
  if(!partBuffer)return;
  partsDownload.disabled=true;
  try{
   say('Creo ZIP di part1.wav, part2.wav… con manifest.json…');
   const zip=await partBuffer.zipParts();
   await exportFile(zip,'AmpySongScriber_'+partBuffer.sessionSummary().stem+'_parts.zip');
   say('ZIP delle parti esportato.');
  }catch(e){say('ZIP delle parti non riuscito: '+e.message);}
  finally{partsDownload.disabled=false;}
 };
 report.onclick=async()=>{
  if(!lastReport)return;
  try{
   await exportFile(new Blob([JSON.stringify(lastReport,null,2)],{type:'application/json'}),
    'AmpySongScriber_DualGGUF_'+Date.now()+'.json');
   say('Rapporto della doppia IA esportato.');
  }catch(e){say('Rapporto non esportabile: '+e.message);}
 };
 async function recover(){
  try{
   const latest=await reopenLastPartBuffer();
   if(!latest)return;
   partBuffer=latest;
   const p=latest.sessionSummary();
   if(!p.parts.length)return;
   download.disabled=false;partsDownload.disabled=false;
   logText('Sessione recuperata: '+p.parts.length+' blocchi salvati ('+
    (p.totalSamples/FRAME_RATE).toFixed(1)+' secondi). Carica il brano originale per continuare.');
   say('File parziali recuperati dal telefono. Scaricabili anche senza rielaborare i blocchi precedenti.');
  }catch(e){say('Recupero parti non disponibile: '+e.message);}
 }
 recover();
 button.onclick=async()=>{
  if(busy)return;
  busy=true;pauseRequested=false;update();
  const stem=$('isolateInstrument').value;
  const firstFile=fileA.files?.[0],secondFile=fileB.files?.[0];
  const reportChunks=[];
  let processedParts=0;
  try{
   if(!fileValid(firstFile)||!fileValid(secondFile))
    throw Error('Seleziona due GGUF dalla cartella Download.');
   if(firstFile===secondFile)throw Error('Seleziona due file GGUF indipendenti.');
   say('Isolamento strumento selezionato in corso…');
   await ensureSource(stem);
   const source=getSource(stem);
   if(!source)throw Error('Non è stata prodotta una traccia dello strumento.');
   const context=new OfflineAudioContext(1,Math.ceil(source.duration*FRAME_RATE),FRAME_RATE);
   const sourceNode=context.createBufferSource();
   sourceNode.buffer=source;sourceNode.connect(context.destination);sourceNode.start();
   const mono=await context.startRendering();
   const totalFrames=mono.length;
   const partFrames=FRAME_RATE*SEGMENT_SEC;
   const totalParts=Math.ceil(totalFrames/partFrames);
   const existing=partBuffer?.sessionSummary();
   if(!partBuffer||existing.song!==getSong()||existing.stem!==stem||existing.complete||
       existing.totalSamples>totalFrames){
    partBuffer=await createPartBuffer(getSong(),stem);
   }
   const session=partBuffer.sessionSummary();
   processedParts=session.parts.length;
   const allNotes=session.parts.flatMap(p=>p.finalNotes||[]);
   if(processedParts>totalParts)throw Error('I file parziali superano la durata del brano');
   download.disabled=processedParts===0;
   partsDownload.disabled=processedParts===0;
   for(let chunk=processedParts;chunk<totalParts;chunk++){
    if(pauseRequested)break;
    const start=chunk*partFrames;
    const length=Math.min(partFrames,totalFrames-start);
    const segment=sliceMono(mono,start,length);
    const offset=start/FRAME_RATE;
    const marker='Blocco '+(chunk+1)+'/'+totalParts+' ('+offset.toFixed(0)+'–'+
      (offset+length/FRAME_RATE).toFixed(0)+' s)';
    say(marker+' · prima bozza delle note con Basic Pitch…');
    const draft=await draftNotes(segment,stem);
    const data={
      stem,offsetSeconds:Number(offset.toFixed(2)),
      measurement:measureAudio(segment),
      draftNotes:isolateDraft(draft),
      limits:restrictions(stem)
    };
    say(marker+' · GGUF 1 analizza la bozza dello spartito…');
    const analyst=await inference(firstFile,marker+' · GGUF 1',
      'Sei revisore 1 di spartiti musicali. Ricevi SOLO misure e note MIDI estratte da Basic Pitch, NON audio. Segnala gli errori probabili senza inventare note. Rispondi SOLO JSON: {"instrument":"guitar","suspectedIssue":"testo","noise":"low|medium|high","suggestion":"breve testo"}.',
      JSON.stringify(data),say);
    say(marker+' · GGUF 2 rivede la prima IA e i parametri DSP…');
    const reviewer=await inference(secondFile,marker+' · GGUF 2',
      'Sei revisore 2 di spartiti e parametri DSP. Ricevi note MIDI esistenti e analisi IA1, ma NON ascolti l audio. Non inventare né alterare altezze. Rispondi SOLO JSON: {"strength":0.25,"lowcut":50,"highcut":7000,"suppressUnconfirmed":false,"rejectShorterThan":0.06,"reason":"breve testo"}. Tutti i filtri saranno vincolati a range sicuri.',
      JSON.stringify({...data,analyst:analyst.parsed}),say);
    const params=bounds(reviewer.parsed,stem);
    say(marker+' · pulizia spettrale FFT e ricontrollo delle note…');
    const cleaned=await cleaningWorker(segment.getChannelData(0).slice(),params,p=>{
      say(marker+' · filtro FFT '+p+'%');
    });
    const output=new AudioBuffer({length:cleaned.length,numberOfChannels:1,sampleRate:FRAME_RATE});
    output.copyToChannel(cleaned,0);
    const cleanNotes=await draftNotes(output,stem);
    const accepted=reviseNotes(draft,cleanNotes,reviewer.parsed,stem);
    const timed=accepted.map(n=>({...n,start:Number((n.start+offset).toFixed(4))}));
    await partBuffer.appendPart(output,{
      draftNoteCount:draft.length,
      finalNoteCount:timed.length,
      finalNotes:timed,
      params
    });
    allNotes.push(...timed);
    processedParts++;
    const rec={
      part:'part'+String(chunk+1).padStart(3,'0')+'.wav',fromSec:offset,
      toSec:offset+length/FRAME_RATE,firstModel:firstFile.name,secondModel:secondFile.name,
      draftNotes:draft.length,reviewedNotes:timed.length,
      first:analyst.parsed,second:reviewer.parsed,dsp:params
    };
    reportChunks.push(rec);
    download.disabled=false;partsDownload.disabled=false;
    progress.value=Math.round(100*(chunk+1)/totalParts);
    logText('✓ '+processedParts+'/'+totalParts+' file WAV salvati\n'+JSON.stringify(rec,null,2));
    say('✓ '+marker+' salvato come '+rec.part+' · '+timed.length+' note. Blocco successivo…');
    await pausePromise();
   }
   const done=processedParts===totalParts;
   if(!done){
    say('⏸ In pausa dopo '+processedParts+' blocchi. I WAV part1, part2… restano salvati. Puoi scaricarli o riprendere.');
    return;
   }
   const completed=await partBuffer.finish();
   say('Unione WAV di '+completed.parts.length+' blocchi e generazione dello spartito completo…');
   const finalScore=await finishScore(allNotes,stem);
   if(finalScore===false)throw Error('Generazione spartito finale non riuscita. I WAV parziali sono conservati.');
   const report={
     createdAt:new Date().toISOString(),song:getSong(),instrument:stem,
     chunks:reportChunks,partCount:completed.parts.length,seconds:completed.totalSamples/FRAME_RATE,
     estimatedNotes:allNotes.length,firstGGUF:firstFile.name,secondGGUF:secondFile.name,
     explanation:'Ogni blocco è stato trascritto preliminarmente, analizzato da GGUF1, revisionato da GGUF2, ripulito con FFT e verificato con Basic Pitch. Note finali unite e esportabili.'
   };
   lastReport=report;
   report.disabled=false;
   logText(JSON.stringify(report,null,2));
   onResult?.(report);
   try{
    const stored=await saveAnalysis({
     question:'Spartito progressivo '+stem,
     answer:JSON.stringify({parts:report.partCount,notes:report.estimatedNotes}),
     song:getSong(),track:stem,model:firstFile.name+' + '+secondFile.name,status:'complete'
    });
    say('✓ '+report.partCount+' parti unite in WAV. Spartito completo pronto: '+allNotes.length+
     ' note. Rapporto salvato (#'+stored.id+'). Scarica WAV/MIDI/MusicXML/PDF.');
   }catch(e){
    say('✓ WAV e spartito completati. Archivio IA non disponibile: '+e.message+
      '. Esporta WAV/ZIP e spartito ora.');
   }
  }catch(e){
   const msg=String(e?.message||e);
   say('ERRORE dopo '+processedParts+' parti salvate: '+msg+
    '. Puoi comunque scaricare le parti completate e riprendere.');
   logText('Elaborazione parziale: '+msg);
  }finally{
   busy=false;pauseRequested=false;update();
  }
 };
 function pausePromise(){return new Promise(resolve=>setTimeout(resolve,0));}
 return {isBusy:()=>busy};
}
