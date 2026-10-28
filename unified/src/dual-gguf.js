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
export const isGenerativeGGUF=f=>Boolean(f&&/\.gguf$/i.test(f.name)
 &&f.size>=80*1024*1024&&f.size<=MAX
 &&!/embedding|embed[-_.]|rerank|reward[-_.]|clip[-_.]|projector/i.test(f.name));
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
 if(!isGenerativeGGUF(file))throw Error(role+': file GGUF non selezionato o dimensione non valida');
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
export function initDualGGUF({getSong,getDuration,getIsolatedChunk,draftNotes,finishScore,exportFile,onResult}){
 const fileA=$('ggufAnalyst'),fileB=$('ggufReviewer'),button=$('ggufRun');
 const pause=$('ggufPause'),status=$('ggufStatus'),log=$('ggufLog'),
  download=$('ggufCleanWav'),partsDownload=$('ggufPartsZip'),
  report=$('ggufReport'),progress=$('ggufProgress');
 let busy=false,pauseRequested=false,partBuffer=null,lastReport=null;
 const say=text=>{status.textContent=text;};
 const logText=text=>{log.textContent=text;};
 function update(){
  const reuse=$('ggufReuse').checked;
  const first=reuse?fileB.files?.[0]:fileA.files?.[0];
  const second=fileB.files?.[0];
  button.disabled=busy||!isGenerativeGGUF(first)||!isGenerativeGGUF(second);
  pause.disabled=!busy;
 }
 const reuseCheck=$('ggufReuse');
 for(const f of [fileA,fileB])f.addEventListener('change',update);
 reuseCheck.addEventListener('change',update);
 // Reject embedding GGUF early, before opening WASM or any audio worker.
 function warnInvalid(){
  if(fileA.files?.[0]&&!isGenerativeGGUF(fileA.files[0])&&!reuseCheck.checked)
   say('GGUF 1 non generativo (Embedding/Reranker): scegli un GGUF di chat, oppure abilita il riuso di Qwen3.');
  else if(fileB.files?.[0]&&!isGenerativeGGUF(fileB.files[0]))
   say('GGUF 2 non generativo: serve Qwen3-0.6B-Q4_K_M.gguf o equivalente chat.');
  else if(!busy&&!button.disabled)
   say(reuseCheck.checked?'Qwen3 verrà usato per entrambi i ruoli, caricandolo due volte in sequenza.':
       'Due modelli generativi pronti: IA 1 poi IA 2.');
 }
 for(const f of [fileA,fileB])f.addEventListener('change',warnInvalid);
 reuseCheck.addEventListener('change',warnInvalid);
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
  const secondFile=fileB.files?.[0],firstFile=$('ggufReuse').checked?secondFile:fileA.files?.[0];
  const reportChunks=[];
  let processedParts=0;
  try{
   if(!isGenerativeGGUF(firstFile)||!isGenerativeGGUF(secondFile))
    throw Error('Serve un GGUF GENERATIVO. Il file Ace-Qwen3-Embedding non produce risposte di chat. Usa Qwen3-0.6B-Q4_K_M.gguf anche in entrambe le fasi.');
   say('Lettura durata del brano. L isolamento verrà eseguito 10 secondi alla volta.');
   const duration=await getDuration();
   if(!Number.isFinite(duration)||duration<=0)throw Error('Durata audio non leggibile.');
   const totalFrames=Math.ceil(duration*FRAME_RATE);
   const partFrames=FRAME_RATE*SEGMENT_SEC;
   const totalParts=Math.ceil(totalFrames/partFrames);
   const existing=partBuffer?.sessionSummary();
   if(!partBuffer||existing.song!==getSong()||existing.stem!==stem||existing.complete||
       existing.totalSamples>totalFrames){
    partBuffer=await createPartBuffer(getSong(),stem);
   }
   const session=partBuffer.sessionSummary();
   processedParts=session.parts.length;
   reportChunks.push(...session.parts.map(p=>({
    part:p.name,fromSec:p.startSample/FRAME_RATE,
    toSec:(p.startSample+p.frames)/FRAME_RATE,
    firstModel:p.firstModel,secondModel:p.secondModel,
    draftNotes:p.draftNoteCount,reviewedNotes:p.finalNoteCount,
    first:p.analysis,second:p.review,dsp:p.params
   })));
   const allNotes=session.parts.flatMap(p=>p.finalNotes||[]);
   if(processedParts>totalParts)throw Error('I file parziali superano la durata del brano');
   download.disabled=processedParts===0;
   partsDownload.disabled=processedParts===0;
   for(let chunk=processedParts;chunk<totalParts;chunk++){
    if(pauseRequested)break;
    const start=chunk*partFrames;
    const length=Math.min(partFrames,totalFrames-start);
    const offset=start/FRAME_RATE;
    say('Blocco '+(chunk+1)+'/'+totalParts+' · isolamento offline solo dei prossimi 10 secondi…');
    const isolated=await getIsolatedChunk(stem,offset,length/FRAME_RATE);
    if(!isolated)throw Error('Separazione dello strumento interrotta per il blocco '+(chunk+1));
    const resampler=new OfflineAudioContext(1,length,FRAME_RATE);
    const sourceNode=resampler.createBufferSource();
    sourceNode.buffer=isolated;sourceNode.connect(resampler.destination);sourceNode.start();
    const segment=await resampler.startRendering();
    // Heavy isolation model has been released before loading either GGUF.
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
      draftNotes:draft,
      finalNoteCount:timed.length,
      finalNotes:timed,
      analysis:analyst.parsed,
      review:reviewer.parsed,
      firstModel:firstFile.name,
      secondModel:secondFile.name,
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
   say('Unione automatica del WAV finale da '+completed.parts.length+' blocchi…');
   let merged=null;
   try{
    merged=await partBuffer.joinToFile();
    say('WAV finale già unito e verificato ('+Math.round((merged.bytes||merged.blob?.size||0)/1024)+' KiB). Creo lo spartito…');
   }catch(err){
    say('Le parti WAV sono integre, ma la prima unione è fallita: '+err.message+'. Puoi riprovare da Unisci e salva WAV finale.');
   }
   const finalScore=await finishScore(allNotes,stem);
   if(finalScore===false)throw Error('Generazione spartito finale non riuscita. I WAV parziali sono conservati.');
   const report={
     createdAt:new Date().toISOString(),song:getSong(),instrument:stem,
     chunks:reportChunks,partCount:completed.parts.length,seconds:completed.totalSamples/FRAME_RATE,
     finalWavBytes:merged?.bytes||merged?.blob?.size||null,
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
