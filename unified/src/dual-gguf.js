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
import {initDebugConsole} from './debug-console.js';
import {startGGUFWorker} from './gguf-worker-controller.js';
import {downmixChannels,signalStats,preserveAudibility,completionState,normalizeQuietStem} from './audio-quality.js';
const $=id=>document.getElementById(id);
const MAX=1.5*1024*1024*1024;
export const isGenerativeGGUF=f=>Boolean(f&&/\.gguf$/i.test(f.name)
 &&f.size>=80*1024*1024&&f.size<=MAX
 &&!/embedding|embed[-_.]|rerank|reward[-_.]|clip[-_.]|projector/i.test(f.name));
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
export function inspectGGUFSelection(firstSelected,secondSelected,reuse){
 const second=secondSelected;
 const first=reuse?second:firstSelected;
 if(!second)return {ok:false,message:'GGUF 2 non selezionato. Tocca Seleziona GGUF 2 da Download e scegli Qwen3-0.6B-Q4_K_M.gguf. Il file non resta selezionato dopo la reinstallazione.'};
 if(!isGenerativeGGUF(second))return {ok:false,message:'GGUF 2 non valido: '+second.name+' ('+Math.round(second.size/1048576)+' MiB). Serve un modello generativo .gguf, non Embedding/Reranker.'};
 if(!reuse&&!first)return {ok:false,message:'GGUF 1 non selezionato. Scegli un secondo GGUF generativo oppure spunta Usa GGUF 2 anche per IA 1.'};
 if(!reuse&&!isGenerativeGGUF(first))return {ok:false,message:'GGUF 1 non valido: '+first.name+'. Un modello Embedding non genera le analisi. Attiva il riutilizzo di Qwen3 o scegli un modello chat.'};
 return {ok:true,first,second,reuse,message:reuse?
  'Modello Qwen3 selezionato: verrà eseguito due volte, in sequenza, nei ruoli IA 1 e IA 2.':
  'Due modelli GGUF generativi selezionati per le fasi IA 1 e IA 2.'};
}

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
// One GGUF at a time. A dedicated Worker can be forcibly terminated when
// llama.cpp hangs during prompt prefill (as measured on Android: 285s no token).
let activeInferenceController=null;
async function inference(file,role,system,user,onStatus,diag){
 if(!isGenerativeGGUF(file))throw Error(role+': serve un GGUF generativo valido');
 diag.stage(role+' · avvio IA isolata');
 diag.line('File: '+file.name+' · '+(file.size/1048576).toFixed(0)+' MiB; contesto 768, 1 thread, timeout primo token 50s');
 let workerTask=null;
 const started=Date.now();
 try{
  workerTask=startGGUFWorker({
   file,role,system,user,
   onStage:message=>{diag.stage(message);onStatus(message);},
   onToken:token=>diag.token(token),
   onLog:entry=>{
    if(entry.level==='error')diag.error(entry.text);
    else if(entry.level==='warn')diag.warn(entry.text);
    else diag.line(entry.text);
   }
  });
  activeInferenceController=workerTask;
  const result=await workerTask.promise;
  diag.flushToken();
  const answer=result.answer.trim();
  if(!answer)throw Error(role+': nessuna risposta generata (Worker terminato).');
  const parsed=extractJSON(answer);
  diag.line(role+': JSON ricevuto e verificato in '+((Date.now()-started)/1000).toFixed(1)+' s. Campi: '+Object.keys(parsed).slice(0,10).join(', '));
  return {parsed,raw:answer.slice(0,2500),chunks:result.chunks};
 }catch(error){
  diag.flushToken();
  diag.error(role+': '+String(error?.message||error));
  if(error.ggufTimedOut)diag.warn('TIMEOUT: il Worker è stato fermato; l IA non ha generato parametri. Possibile fallback DSP.');
  throw error;
 }finally{
  if(activeInferenceController===workerTask)activeInferenceController=null;
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
 return notes.slice(0,12).map((n,i)=>({
  index:i,midi:n.pitch,start:Number(n.start.toFixed(3)),duration:Number(n.duration.toFixed(3))
 }));
}
export function initDualGGUF({getSong,getDuration,getIsolatedChunk,draftNotes,finishScore,exportFile,onResult,getRoleMeta=()=>null,getRoleFile=async()=>null}){
 const fileA=$('ggufAnalyst'),fileB=$('ggufReviewer'),button=$('ggufRun');
 const pause=$('ggufPause'),status=$('ggufStatus'),log=$('ggufLog'),
  download=$('ggufCleanWav'),partialDownload=$('ggufPartialWav'),partsDownload=$('ggufPartsZip'),
  completionLabel=$('ggufCompletionLabel'),
  report=$('ggufReport'),progress=$('ggufProgress');
 let busy=false,pauseRequested=false,partBuffer=null,lastReport=null;
 const diag=initDebugConsole(exportFile);
 diag.setStopHandler(()=>{pauseRequested=true;activeInferenceController?.cancel();});
 const say=text=>{status.textContent=text;diag.line(text);};
 const logText=text=>{log.textContent=text;};
 function inspect(){
  return inspectGGUFSelection(getRoleMeta('first')||fileA.files?.[0],getRoleMeta('second')||fileB.files?.[0],reuseCheck.checked);
 }
 function updateCompletion(){
  const p=partBuffer?.sessionSummary();
  if(!p||!p.parts.length){
   download.disabled=true;partialDownload.disabled=true;
   completionLabel.textContent='Nessun blocco disponibile: il WAV finale richiede il 100% del brano originale.';
   return;
  }
  if(!p.expectedSamples){
   download.disabled=true;partialDownload.disabled=false;
   completionLabel.textContent='Durata originale ancora da verificare. Parti salvate: '+p.parts.length+
    '. Carica nuovamente il brano per abilitare l unione.';
   return;
  }
  const progress=completionState(p.totalSamples,p.expectedSamples);
  const seconds=x=>Math.floor(x/60)+':'+String(Math.floor(x%60)).padStart(2,'0');
  completionLabel.textContent='Elaborati '+seconds(progress.processedSeconds)+' su '+
   seconds(progress.expectedSeconds)+' ('+progress.percent+'%) · '+p.parts.length+
   ' blocchi · '+(p.complete?'SESSIONE FINALIZZATA':'ANCORA PARZIALE');
  download.disabled=!(progress.complete&&p.complete);
  partialDownload.disabled=p.parts.length===0||progress.complete;
 }
 function update(){
  // Critical UX: "Avvia" stays clickable so invalid/missing GGUFs can show
  // a clear diagnostic. Only an actual running job disables it.
  button.disabled=busy;
  pause.disabled=!busy;
 }
 const reuseCheck=$('ggufReuse');
 function onFilesChanged(){
  update();
  if(busy)return;
  const preflight=inspect();
  const text=preflight.ok?preflight.message:preflight.message;
  status.textContent=text;
  if(preflight.ok)diag.line('Modelli pronti: '+text);
  else diag.warn('Verifica modelli: '+text);
 }
 for(const f of [fileA,fileB])f.addEventListener('change',onFilesChanged);
 reuseCheck.addEventListener('change',onFilesChanged);
 update();
 onFilesChanged();
 pause.onclick=()=>{
  if(!busy)return;
  pauseRequested=true;
  pause.disabled=true;
  say('⏸ Pausa richiesta: concludo il blocco corrente e salvo partN.wav prima di fermarmi.');
 };
 async function exportFinal(){
  if(!partBuffer)return;
  updateCompletion();
  if(download.disabled){say('Il WAV finale non è disponibile: mancano blocchi. Scarica ZIP o WAV PARZIALE esplicito.');return;}
  try{
   say('Unione progressiva dei partN.wav in un unico WAV PCM16…');
   const final=await partBuffer.shareFinal();
   if(final.blob)await exportFile(final.blob,final.filename);
   say('WAV finale unito: '+partBuffer.sessionSummary().parts.length+' blocchi, '+(partBuffer.sessionSummary().totalSamples/FRAME_RATE).toFixed(1)+' secondi.');
  }catch(e){say('Unione WAV fallita: '+e.message);}
 }
 download.onclick=exportFinal;
 partialDownload.onclick=async()=>{
  if(!partBuffer)return;
  try{
   const s=partBuffer.sessionSummary();
   if(!s.expectedSamples)throw Error('Ricarica il brano originale per verificare quanto manca.');
   const output=await partBuffer.shareFinal({allowPartial:true});
   if(output.blob)await exportFile(output.blob,output.filename);
   say('WAV PARZIALE esportato: '+output.completion.processedSeconds.toFixed(1)+' di '+
    output.completion.expectedSeconds.toFixed(1)+' secondi. Non è il brano completo.');
  }catch(e){say('WAV parziale non esportabile: '+e.message);}
 };
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
   partsDownload.disabled=false;updateCompletion();
   logText('Sessione recuperata: '+p.parts.length+' blocchi salvati ('+
    (p.totalSamples/FRAME_RATE).toFixed(1)+' secondi). Carica il brano originale per continuare.');
   say('File parziali recuperati dal telefono. Scaricabili anche senza rielaborare i blocchi precedenti.');
  }catch(e){say('Recupero parti non disponibile: '+e.message);}
 }
 recover();
 button.onclick=async()=>{
  if(busy)return;
  busy=true;pauseRequested=false;diag.setActive(true);diag.stage('Avvio pipeline a blocchi da 10 s');update();
  const stem=$('isolateInstrument').value;
  const secondFile=getRoleMeta('second')||fileB.files?.[0],firstFile=$('ggufReuse').checked?secondFile:(getRoleMeta('first')||fileA.files?.[0]);
  const reportChunks=[];
  const timedOutModels=new Set(); // skip repeatedly stalled GGUFs across subsequent parts
  let processedParts=0;
  try{
   const preflight=inspect();
   if(!preflight.ok){
    diag.warn('PRE-AVVIO: '+preflight.message);
    throw Error(preflight.message);
   }
   diag.line('PRE-AVVIO OK: '+preflight.message);
   say('Lettura durata del brano. L isolamento verrà eseguito 10 secondi alla volta.');
   const duration=await getDuration();
   if(!Number.isFinite(duration)||duration<=0)throw Error('Durata audio non leggibile.');
   const totalFrames=Math.ceil(duration*FRAME_RATE);
   const partFrames=FRAME_RATE*SEGMENT_SEC;
   const totalParts=Math.ceil(totalFrames/partFrames);
   completionLabel.textContent='Durata originale '+duration.toFixed(1)+' s: attesi '+totalParts+' blocchi da 10 secondi.';
   const existing=partBuffer?.sessionSummary();
   if(!partBuffer||existing.song!==getSong()||existing.stem!==stem||existing.complete||
       existing.totalSamples>totalFrames){
    partBuffer=await createPartBuffer(getSong(),stem,null,totalFrames);
   }
   else if(!existing.expectedSamples){
    partBuffer=await createPartBuffer(getSong(),stem,existing,totalFrames);
   }
   const session=partBuffer.sessionSummary();
   if(session.expectedSamples!==totalFrames)
    throw Error('Il brano caricato non coincide con la sessione precedente. Salva lo ZIP e riparti da zero.');
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
   partsDownload.disabled=processedParts===0;
   updateCompletion();
   for(let chunk=processedParts;chunk<totalParts;chunk++){
    if(pauseRequested)break;
    const start=chunk*partFrames;
    const length=Math.min(partFrames,totalFrames-start);
    const offset=start/FRAME_RATE;
    say('Blocco '+(chunk+1)+'/'+totalParts+' · isolamento offline solo dei prossimi 10 secondi…');
    const isolated=await getIsolatedChunk(stem,offset,length/FRAME_RATE);
    if(!isolated)throw Error('Separazione dello strumento interrotta per il blocco '+(chunk+1));
    const resampler=new OfflineAudioContext(2,length,FRAME_RATE);
    const sourceNode=resampler.createBufferSource();
    sourceNode.buffer=isolated;sourceNode.connect(resampler.destination);sourceNode.start();
    const stereo=await resampler.startRendering();
    const mixed=downmixChannels(stereo.getChannelData(0),stereo.getChannelData(1));
    if(mixed.cancellation)diag.warn('Fase stereo→mono: cancellazione di fase! Uso il canale '+mixed.selected+' più udibile.');
    const segment=new AudioBuffer({numberOfChannels:1,length,sampleRate:FRAME_RATE});
    segment.copyToChannel(mixed.samples,0);
    const rawStats=signalStats(mixed.samples);
    diag.line('Audio isolato '+(chunk+1)+'/'+totalParts+': RMS '+rawStats.db.toFixed(1)+' dBFS; picco '+rawStats.peak.toFixed(5));
    if(rawStats.peak<.00012)diag.warn('La traccia isolata di questo blocco è quasi muta: il DSP non può inventare un basso assente.');
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
    let analyst;
    try{
     if(timedOutModels.has(firstFile.name))throw Object.assign(new Error('GGUF già bloccato in un blocco precedente: salto IA1 per non perdere altro tempo.'),{ggufTimedOut:true});
     analyst=await inference((await getRoleFile($('ggufReuse').checked?'second':'first'))||firstFile,marker+' · GGUF 1',
      'Sei revisore 1 di spartiti musicali. Ricevi SOLO misure e note MIDI estratte da Basic Pitch, NON audio. Segnala gli errori probabili senza inventare note. Rispondi SOLO JSON: {"instrument":"guitar","suspectedIssue":"testo","noise":"low|medium|high","suggestion":"breve testo"}.',
      JSON.stringify(data),say,diag);
    }catch(error){
     if(error?.ggufTimedOut)timedOutModels.add(firstFile.name);
     if(error?.userCancelled||pauseRequested||!$('ggufSafeFallback').checked)throw error;
     analyst={parsed:{instrument:stem,noise:'unknown',suggestion:'Analisi IA1 non riuscita, preservare le note originali'},
      skipped:true,error:String(error.message||error)};
     say('ATTENZIONE: GGUF 1 non ha risposto. Continuo con dati musicali verificabili, senza attribuirgli un analisi inesistente.');
    }
    say(marker+' · GGUF 2 rivede la prima IA e i parametri DSP…');
    let reviewer;
    try{
     if(timedOutModels.has(secondFile.name))throw Object.assign(new Error('GGUF già bloccato: salto IA2 e uso DSP conservativo.'),{ggufTimedOut:true});
     reviewer=await inference((await getRoleFile('second'))||secondFile,marker+' · GGUF 2',
      'Sei revisore 2 di spartiti e parametri DSP. Ricevi note MIDI esistenti e analisi IA1, ma NON ascolti l audio. Non inventare né alterare altezze. Rispondi SOLO JSON: {"strength":0.25,"lowcut":50,"highcut":7000,"suppressUnconfirmed":false,"rejectShorterThan":0.06,"reason":"breve testo"}. Tutti i filtri saranno vincolati a range sicuri.',
      JSON.stringify({...data,analyst:analyst.parsed}),say,diag);
    }catch(error){
     if(error?.ggufTimedOut)timedOutModels.add(secondFile.name);
     if(error?.userCancelled||pauseRequested||!$('ggufSafeFallback').checked)throw error;
     reviewer={parsed:{strength:.12,lowcut:restrictions(stem).defaultLow,
        highcut:restrictions(stem).defaultHigh,suppressUnconfirmed:false,
        rejectShorterThan:.055,reason:'DSP conservativo di fallback; GGUF2 non riuscito'},
       skipped:true,error:String(error.message||error)};
     say('ATTENZIONE: GGUF 2 non ha risposto. Pulizia FFT conservativa dichiarata come fallback.');
    }
    const params=bounds(reviewer.parsed,stem);
    say(marker+' · pulizia spettrale FFT e ricontrollo delle note…');
    const cleaned=await cleaningWorker(segment.getChannelData(0).slice(),params,p=>{
      say(marker+' · filtro FFT '+p+'%');
    });
    const health=preserveAudibility(mixed.samples,cleaned,{maxGain:2.5});
    if(health.bypassed)diag.warn('DSP attenuava eccessivamente il segnale: audio originale isolato preservato al posto del filtrato.');
    else diag.line('DSP: guadagno conservativo '+health.gain.toFixed(2)+'×; RMS '+health.after.db.toFixed(1)+' dBFS.');
    const normalized=normalizeQuietStem(health.samples);
    if(normalized.boosted)diag.line('Normalizzazione stem udibile: '+normalized.gain.toFixed(2)+'×, picco '+normalized.after.peak.toFixed(3));
    if(normalized.inaudible)diag.warn('Stem quasi muto: nessun guadagno applicato a campioni sotto soglia. Controllare separazione e strumento selezionato.');
    const output=new AudioBuffer({length:normalized.samples.length,numberOfChannels:1,sampleRate:FRAME_RATE});
    output.copyToChannel(normalized.samples,0);
    const cleanNotes=await draftNotes(output,stem);
    const accepted=reviseNotes(draft,cleanNotes,reviewer.parsed,stem);
    const timed=accepted.map(n=>({...n,start:Number((n.start+offset).toFixed(4))}));
    await partBuffer.appendPart(output,{
      draftNoteCount:draft.length,
      draftNotes:draft,
      finalNoteCount:timed.length,
      finalNotes:timed,
      analysis:{...analyst.parsed,modelWorked:!analyst.skipped,error:analyst.error||null},
      review:{...reviewer.parsed,modelWorked:!reviewer.skipped,error:reviewer.error||null},
      firstModel:firstFile.name,
      secondModel:secondFile.name,
      params:{...params,normalizedGain:normalized.gain,inaudible:normalized.inaudible,stereoCancellation:mixed.cancellation}
    });
    allNotes.push(...timed);
    processedParts++;
    const rec={
      part:'part'+String(chunk+1).padStart(3,'0')+'.wav',fromSec:offset,
      toSec:offset+length/FRAME_RATE,firstModel:firstFile.name,secondModel:secondFile.name,
      draftNotes:draft.length,reviewedNotes:timed.length,
      first:{...analyst.parsed,worked:!analyst.skipped},second:{...reviewer.parsed,worked:!reviewer.skipped},dsp:params
    };
    reportChunks.push(rec);
    partsDownload.disabled=false;updateCompletion();
    progress.value=Math.round(100*(chunk+1)/totalParts);
    logText('✓ '+processedParts+'/'+totalParts+' file WAV salvati\n'+JSON.stringify(rec,null,2));
    say('✓ '+marker+' salvato come '+rec.part+' · '+timed.length+' note. Durata '+
      (partBuffer.sessionSummary().totalSamples/FRAME_RATE).toFixed(1)+' / '+duration.toFixed(1)+' s. Blocco successivo…');
    await pausePromise();
   }
   const done=processedParts===totalParts;
   if(!done){
    updateCompletion();
    say('⏸ In pausa dopo '+processedParts+' blocchi. I WAV part1, part2… restano salvati. Puoi scaricarli o riprendere.');
    return;
   }
   const completed=await partBuffer.finish();
   updateCompletion();
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
   busy=false;pauseRequested=false;diag.setActive(false);update();
  }
 };
 function pausePromise(){return new Promise(resolve=>setTimeout(resolve,0));}
 return {isBusy:()=>busy,refreshModels:onFilesChanged};
}
