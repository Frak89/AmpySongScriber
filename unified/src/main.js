import {loadDemucsModel,separateStems,extractStems} from './demucs-loader.js';
import {BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime} from '@spotify/basic-pitch';
import {Midi} from '@tonejs/midi';
import JSZip from 'jszip';
import {jsPDF} from 'jspdf';
import {Filesystem,Directory} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {Capacitor} from '@capacitor/core';
import {encodeWav,validateWav} from './wav.js';
import {createMusicXML} from './notation.js';
import {recognizeInstruments} from './instrument-ai.js';

const $=(id)=>document.getElementById(id);
const btn=(id,v)=>{$(id).disabled=!v};
let audioFile=null, audioBuffer=null, context=null, stems={},sourceUrl=null;
let currentMidi=null, currentNotes=[], selectedStem='', scoreTitle='';
let demucsWorker=null, separationStopper=null, separationTimer=null;
let separationStage='idle', separationProgress=0, separationStart=0;
const fmtElapsed=(s)=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const STEMS=[['vocals','🎙️ Voce'],['drums','🥁 Batteria'],['bass','🎸 Basso'],['other','🎹 Altri strumenti']];
const setStatus=(s)=>{$('status').textContent=s};
const fmt=(x)=>(x/1048576).toFixed(1)+' MB';
const slug=(s)=>s.replace(/\.[^.]+$/,'').replace(/[^a-z0-9._-]+/gi,'_').slice(0,85)||'AmpySongScriber';
const sleep=()=>new Promise(r=>setTimeout(r,0));
function downloadBrowser(blob,name){
 const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;
 document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),90000);
}
function toBase64(bytes) {
 let str='';for(let i=0;i<bytes.length;i+=8192){str+=String.fromCharCode(...bytes.subarray(i,i+8192));}
 return btoa(str);
}
async function exportFile(blob,name){
 if (!Capacitor.isNativePlatform()){downloadBrowser(blob,name);return;}
 try {
   // Chunked writes prevent materializing a 100+ MB base64 string on Android.
   const temp='ampy_'+Date.now()+'_'+name.replace(/[^a-z0-9._-]+/gi,'_');
   const size=3*256*1024;let first=true;
   for(let offset=0; offset<blob.size; offset+=size) {
     const bytes=new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer());
     const data=toBase64(bytes);
     if(first){await Filesystem.writeFile({directory:Directory.Cache,path:temp,data,recursive:true});first=false;}
     else await Filesystem.appendFile({directory:Directory.Cache,path:temp,data});
   }
   if(first)await Filesystem.writeFile({directory:Directory.Cache,path:temp,data:''});
   const stat=await Filesystem.stat({directory:Directory.Cache,path:temp});
   if(stat.size!==blob.size)throw new Error('File esportato incompleto: '+stat.size+' byte invece di '+blob.size);
   const file=await Filesystem.getUri({directory:Directory.Cache,path:temp});
   if(!file.uri)throw new Error('Percorso file non disponibile');
   // Share as a real file attachment (not as a text URL). Android uses the
   // FileProvider and the file extension to expose a compatible MIME type.
   await Share.share({title:'AmpySongScriber · '+name,files:[file.uri],dialogTitle:'Salva o condividi il file'});
 } catch(e){setStatus('Esportazione nativa non riuscita: '+e.message);throw e;}
}
function wav(audioBuffer){return encodeWav(audioBuffer);}
async function exportWav(buf,filename){
 const encoded=encodeWav(buf);
 await validateWav(encoded);
 return exportFile(encoded,filename);
}
async function openFile(file) {
 if(!file)return;
 audioFile=file; stems={};currentMidi=null;currentNotes=[];
 btn('separate',true);btn('transcribe',true);btn('zipall',false);
 for(const k of ['pdf','xml','midi','preview'])btn(k,false);
 btn('identify',false);$('instrumentResults').textContent='';
 $('score').style.display='none';$('tracks').replaceChildren();
 $('trackselect').innerHTML='<option value="original">Brano originale</option>';
 $('filename').textContent=file.name+' · '+fmt(file.size);
 if(sourceUrl)URL.revokeObjectURL(sourceUrl);
 sourceUrl=URL.createObjectURL(file);$('original').src=sourceUrl;$('original').style.display='block';
 audioBuffer=null;
 setStatus('Pronto. Modello IA integrato: separa o trascrivi direttamente.');
}
$('audiofile').addEventListener('change',e=>openFile(e.target.files?.[0]));
async function decodeAudio() {
 if(audioBuffer)return audioBuffer;
 if(!audioFile)throw new Error('Scegli prima una canzone.');
 context=context||new AudioContext();
 const buf=await context.decodeAudioData(await audioFile.arrayBuffer());
 if(buf.sampleRate===44100&&buf.numberOfChannels===2){audioBuffer=buf;return buf;}
 const off=new OfflineAudioContext(2,Math.ceil(buf.duration*44100),44100);
 const source=off.createBufferSource();source.buffer=buf;
 if(buf.numberOfChannels===1){/* Web Audio duplicates mono through stereo destination */}
 source.connect(off.destination);source.start();
 audioBuffer=await off.startRendering();return audioBuffer;
}
const progress=(id,p)=>{$(id).style.display='block';$(id).value=Math.max(0,Math.min(100,p))};
function safeHTML(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
let busy=false;
function terminateDemucsWorker(){
 if(demucsWorker){demucsWorker.terminate();demucsWorker=null;}
 if(separationTimer){clearInterval(separationTimer);separationTimer=null;}
}
function cancelSeparation(){
 if(separationStopper)separationStopper(new Error('Elaborazione annullata.'));
 terminateDemucsWorker();
 separationStopper=null;
 $('cancel').hidden=true;
 $('progress').style.display='none';
 setStatus('Operazione annullata. Modello scaricato dalla RAM.');
}
$('cancel').addEventListener('click',cancelSeparation);

async function runDemucsInWorker(buf){
 // Transfer copies: WebAudio owns its data; detaching those buffers would break playback.
 const channels=[buf.getChannelData(0).slice(),buf.getChannelData(1).slice()];
 terminateDemucsWorker();
 demucsWorker=new Worker(new URL('./demucs-worker.js',import.meta.url),{type:'module'});
 separationStage='model';
 separationProgress=0;
 separationStart=Date.now();
 $('cancel').hidden=false;
 $('progress').removeAttribute('value'); // indeterminate - model compilation exposes no reliable progress API
 $('progress').style.display='block';
 separationTimer=setInterval(()=>{
  const elapsed=Math.round((Date.now()-separationStart)/1000);
  if(separationStage==='model'){
    setStatus('Inizializzazione HTDemucs offline (181 MB) · '+fmtElapsed(elapsed)+'\nIl primo caricamento può essere molto lento sul Pixel 7 Pro. Questa fase non fornisce una percentuale reale.\nPuoi toccare Annulla per interrompere.');
  }else if(separationStage==='separating'){
    setStatus('Separazione audio in corso · '+separationProgress+'% · tempo trascorso '+fmtElapsed(elapsed));
  }
 },1000);
 return await new Promise((resolve,reject)=>{
  let finished=false;
  const finish=(err,result)=>{
   if(finished)return;
   finished=true;
   separationStopper=null;
   if(separationTimer){clearInterval(separationTimer);separationTimer=null;}
   if(err){terminateDemucsWorker();reject(err);}
   else resolve(result);
  };
  separationStopper=(error)=>finish(error);
  demucsWorker.onerror=(e)=>finish(new Error('Worker IA interrotto: '+(e.message||'errore di memoria o WebView')));
  demucsWorker.onmessageerror=()=>finish(new Error('Memoria insufficiente per trasferire i dati IA'));
  demucsWorker.onmessage=(e)=>{
   const d=e.data;
   if(d.type==='status'){
     separationStage=d.stage;
     if(d.stage==='separating'){progress('progress',12);setStatus('Modello pronto: separazione in corso…');}
     else setStatus(d.message);
   }else if(d.type==='modelProgress'){
     if(d.stage==='ready')setStatus('Modello inizializzato.');
   }else if(d.type==='progress'){
     separationStage='separating';
     separationProgress=Math.round(d.percent);
     progress('progress',Math.round(12+d.percent*.88));
     setStatus('Elaborazione blocco '+d.chunk+'/'+d.total+' · '+d.percent+'%');
   }else if(d.type==='error'){
     finish(new Error(d.message));
   }else if(d.type==='done'){
     terminateDemucsWorker();finish(null,d.result);
   }
  };
  demucsWorker.postMessage({type:'separate',sampleRate:44100,channels},channels.map(c=>c.buffer));
 });
}

async function separate(){
 if(busy)return;busy=true;btn('separate',false);
 try {
  setStatus('Decodifica audio in corso…');progress('progress',2);
  const buf=await decodeAudio();
  if(buf.sampleRate!==44100||buf.numberOfChannels!==2)
    throw new Error('Conversione a 44.100 Hz stereo non riuscita');
  const result=await runDemucsInWorker(buf);
  stems=extractStems(result,44100,context);
  $('tracks').replaceChildren();
  $('trackselect').innerHTML='<option value="original">Brano originale</option>';
  for(const [key,name] of STEMS){
    const buff=stems[key];if(!buff)continue;
    const div=document.createElement('div');div.className='track';
    const title=document.createElement('strong');title.textContent=name;
    const audio=document.createElement('audio');audio.controls=true;audio.preload='none';
    const listen=document.createElement('button');listen.className='secondary';listen.textContent='▶ Ascolta';
    listen.onclick=async()=>{
      if(!audio.src){
        listen.disabled=true;listen.textContent='Preparazione WAV…';
        try{
          const encoded=encodeWav(buff);await validateWav(encoded);
          audio.src=URL.createObjectURL(encoded);
          listen.textContent='▶ Ascolta';
        }catch(e){setStatus('Errore audio: '+String(e?.message||e));}
        finally{listen.disabled=false;}
      }
      if(audio.src)await audio.play().catch(e=>setStatus('Riproduzione audio non riuscita: '+e.message));
    };
    const controls=document.createElement('div');controls.className='actions';
    const dl=document.createElement('button');dl.className='secondary';dl.textContent='⬇ WAV';
    dl.onclick=()=>exportWav(buff,slug(audioFile.name)+'_'+key+'.wav');
    const score=document.createElement('button');score.textContent='🎼 Spartito';score.className='secondary';
    score.onclick=()=>{$('trackselect').value=key;transcribe()};
    controls.append(listen,dl,score);div.append(title,audio,controls);$('tracks').append(div);
    const opt=document.createElement('option');opt.value=key;opt.textContent=name;
    $('trackselect').append(opt);
  }
  btn('zipall',true);btn('identify',Boolean(stems.other));
  setStatus('Tracce estratte: voce, batteria, basso e altri strumenti. Elaborazione locale completata.');
 }catch(e){
  setStatus('Separazione interrotta: '+(e?.message||e)+'. Se fallisce ancora durante il caricamento, il modello HTDemucs potrebbe esaurire la memoria del WebView.');console.error(e);
 }finally{
  if(separationTimer){clearInterval(separationTimer);separationTimer=null;}
  $('cancel').hidden=true;
  $('progress').style.display='none';
  busy=false;btn('separate',true);
 }
}
$('separate').onclick=separate;
$('zipall').onclick=async()=>{
 if(!Object.keys(stems).length)return;
 btn('zipall',false);setStatus('Preparazione ZIP audio (richiede spazio e RAM)...');
 try{
  const zip=new JSZip();for(const [key] of STEMS){
   if(stems[key]){
     const b=encodeWav(stems[key]);await validateWav(b);
     zip.file(slug(audioFile.name)+'_'+key+'.wav',b);
   }
   await sleep();
  }
  const blob=await zip.generateAsync({type:'blob',compression:'STORE'},meta=>setStatus('Creazione ZIP '+Math.round(meta.percent)+'%'));
  await exportFile(blob,slug(audioFile.name)+'_stems.zip');
  setStatus('Tracce esportate.');
 }catch(e){setStatus('Errore ZIP: '+e.message)}
 finally{btn('zipall',true)}
};
async function transcribe(){
 if(busy)return;busy=true;btn('transcribe',false);
 try{
  const which=$('trackselect').value;
  if(which==='drums')setStatus('La trascrizione della batteria con Basic Pitch è indicativa, non una notazione ritmica dedicata.');
  const buf=which==='original'?await decodeAudio():stems[which];
  if(!buf)throw new Error('Traccia non ancora disponibile. Separa prima l’audio.');
  currentNotes=[];currentMidi=null;scoreTitle=slug(audioFile.name)+' · '+(STEMS.find(x=>x[0]===which)?.[1]||'Brano');
  setStatus('Carico Basic Pitch, IA locale per riconoscere le note...');progress('midiProgress',5);
  const pitch=new BasicPitch('/basic-pitch/model.json');
  const frames=[],onsets=[],contours=[];
  // Basic Pitch requires exactly 22,050 Hz mono. Demucs uses 44,100 Hz stereo.
  // Resample using the browser's offline audio converter, regardless of input format.
  setStatus('Conversione automatica a 22.050 Hz mono per Basic Pitch…');
  const offline=new OfflineAudioContext(1,Math.max(1,Math.ceil(buf.duration*22050)),22050);
  const src=offline.createBufferSource();src.buffer=buf;src.connect(offline.destination);src.start();
  const pitchBuffer=await offline.startRendering();
  if(pitchBuffer.sampleRate!==22050||pitchBuffer.numberOfChannels!==1)throw new Error('Resampling per Basic Pitch non riuscito');
  setStatus('Trascrizione delle note a 22.050 Hz…');
  await pitch.evaluateModel(pitchBuffer,(f,o,c)=>{frames.push(...f);onsets.push(...o);contours.push(...c)},p=>{progress('midiProgress',Math.round(p*100));setStatus('Trascrizione note · '+Math.round(p*100)+'%')});
  const threshold=Math.max(.1,Math.min(.8,Number($('noteThreshold').value)||.32));
  const raw=noteFramesToTime(addPitchBendsToNoteEvents(contours,outputToNotesPoly(frames,onsets,threshold,threshold,Number($('minimumNote').value)||7)));
  currentNotes=raw.filter(x=>x.pitchMidi>=21&&x.pitchMidi<=108&&x.durationSeconds>.045).map(n=>({pitch:n.pitchMidi,start:Math.max(0,n.startTimeSeconds),duration:n.durationSeconds,velocity:Math.min(1,Math.max(.1,n.amplitude||.7))})).sort((a,b)=>a.start-b.start);
  const bpm=Math.max(40,Math.min(240,Number($('tempo').value)||120));
  const midi=new Midi();midi.header.name=scoreTitle;midi.header.setTempo(bpm);
  const t=midi.addTrack();t.name=which;t.instrument.number=which==='bass'?33:which==='vocals'?53:0;
  for(const n of currentNotes)t.addNote({midi:n.pitch,time:n.start,duration:n.duration,velocity:n.velocity});
  currentMidi=midi;
  await showAccurateScore();for(const k of ['pdf','xml','midi','preview'])btn(k,true);
  setStatus('Spartito MusicXML generato: '+currentNotes.length+' note · '+bpm+' BPM. Esporta PDF e MusicXML oppure modifica tempo/soglia per migliorare il risultato.');
 }catch(e){setStatus('Trascrizione non riuscita: '+(e?.message||e));console.error(e)}
 finally{$('midiProgress').style.display='none';btn('transcribe',true);busy=false;}
}
$('transcribe').onclick=transcribe;

// Render MusicXML locally with OpenSheetMusicDisplay, not an approximate custom
// staff. Export PDF by capturing each OSMD canvas page.
let scoreCanvases=[];
function notationOptions(){
 return {
  title:scoreTitle,
  instrument:$('trackselect').selectedOptions[0]?.textContent||'Strumento',
  bpm:Number($('tempo').value)||120,
  grid:Number($('quantization').value)||120,
  bass:$('trackselect').value==='bass'
 };
}
function musicXML(){
 if(!currentNotes.length)throw Error('Nessuna nota trascritta');
 return createMusicXML(currentNotes,notationOptions());
}
async function showAccurateScore(){
 const host=$('score');
 host.replaceChildren();
 host.style.display='block';
 scoreCanvases=[];
 const {OpenSheetMusicDisplay}=await import('opensheetmusicdisplay');
 const xml=musicXML();
 const renderer=new OpenSheetMusicDisplay(host,{
  autoResize:false,backend:'canvas',drawTitle:true,drawComposer:false,
  pageFormat:'A4',renderSingleHorizontalStaffline:false
 });
 await renderer.load(xml);
 renderer.Zoom=.8;
 renderer.render();
 scoreCanvases=Array.from(host.querySelectorAll('canvas'));
 if(!scoreCanvases.length)throw Error('Il motore spartiti non ha generato alcuna pagina.');
}
$('preview').onclick=async()=>{
 if(!currentNotes.length)return;
 btn('preview',false);
 try{await showAccurateScore();setStatus('Spartito aggiornato con tempo e divisione selezionati.');}
 catch(e){setStatus('Impossibile disegnare spartito: '+e.message);}
 finally{btn('preview',true);}
};
$('xml').onclick=async()=>{
 try{await exportFile(new Blob([musicXML()],{type:'application/vnd.recordare.musicxml+xml'}),slug(audioFile.name)+'_'+$('trackselect').value+'.musicxml');}
 catch(e){setStatus('Esportazione MusicXML fallita: '+e.message);}
};
$('midi').onclick=async()=>{
 try{if(!currentMidi)return;await exportFile(new Blob([currentMidi.toArray()],{type:'audio/midi'}),slug(audioFile.name)+'_'+$('trackselect').value+'.mid');}
 catch(e){setStatus('Esportazione MIDI fallita: '+e.message);}
};
$('pdf').onclick=async()=>{
 if(!currentNotes.length)return;
 btn('pdf',false);
 try{
  // Always recalculate PDF from the same MusicXML used by MuseScore.
  await showAccurateScore();
  const pdf=new jsPDF({unit:'mm',format:'a4',compress:true});
  for(let i=0;i<scoreCanvases.length;i++){
   if(i)pdf.addPage('a4');
   const canvas=scoreCanvases[i];
   const ratio=Math.min(210/canvas.width,297/canvas.height);
   const width=canvas.width*ratio,height=canvas.height*ratio;
   const png=canvas.toDataURL('image/png');
   pdf.addImage(png,'PNG',(210-width)/2,0,width,height,undefined,'FAST');
  }
  await exportFile(pdf.output('blob'),slug(audioFile.name)+'_'+$('trackselect').value+'.pdf');
  setStatus('PDF dello spartito esportato: '+scoreCanvases.length+' pagine.');
 }catch(e){setStatus('Esportazione PDF fallita: '+e.message);console.error(e);}
 finally{btn('pdf',true);}
};
$('identify').onclick=async()=>{
 if(!stems.other)return;
 btn('identify',false);
 const area=$('instrumentResults');area.textContent='Analisi IA locale in corso…';
 try{
  const candidates=await recognizeInstruments(stems.other,s=>area.textContent=s);
  area.replaceChildren();
  const title=document.createElement('strong');title.textContent='Strumenti probabili in “Altri”';area.append(title);
  const list=document.createElement('ol');
  for(const c of candidates){
   const li=document.createElement('li');
   li.textContent=c.name+' · affinità '+Math.round(c.score*100)+'%'+(c.weak?' (bassa confidenza)':'');
   list.append(li);
  }
  area.append(list);
  const note=document.createElement('p');note.className='sub';
  note.textContent='YAMNet rileva timbri probabili, non separa ulteriormente i singoli strumenti. I punteggi non rappresentano probabilità certe.';
  area.append(note);
 }catch(e){
  area.textContent='Classificazione IA non disponibile: '+String(e?.message||e);
 }finally{btn('identify',true);}
};
