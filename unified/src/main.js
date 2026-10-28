import {STEM_LABELS,STEM_KEYS} from './demucs6-loader.js';
import {refineInstrumentNotes,noteRange} from './note-cleanup.js';
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
// Language GGUF removed from critical path: use trained music models directly.

const $=(id)=>document.getElementById(id);
const btn=(id,v)=>{$(id).disabled=!v};
let audioFile=null, audioBuffer=null, context=null, stems={},sourceUrl=null;
let currentMidi=null, currentNotes=[], currentMidiStem=null, scoreTitle='';
let latestInstrumentPredictions=[];
let activeStem=null;
let instrumentLabel='';
let instrumentPredictions=[];
let demucsWorker=null, separationStopper=null, separationTimer=null;
let separationStage='idle', separationProgress=0, separationStart=0;
const fmtElapsed=(s)=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const STEMS=STEM_KEYS.map(key=>[key,STEM_LABELS[key]]);
const shownStemName=key=>key==='other'&&instrumentLabel?'🎻 Possibile '+instrumentLabel+' (residuo misto)':STEM_LABELS[key]||key;
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
 audioFile=file; stems={};currentMidi=null;currentMidiStem=null;currentNotes=[];latestInstrumentPredictions=[];
 btn('separate',true);btn('transcribe',true);btn('zipall',false);btn('detectBpm',true);
 for(const k of ['pdf','xml','midi','preview'])btn(k,false);
 btn('wavSelected',false);
 btn('identify',false);$('instrumentResults').textContent='';instrumentLabel='';activeStem=null;
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

async function runDemucsInWorker(buf,stem){
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
    setStatus('Inizializzazione HTDemucs 6 strumenti offline (~136 MB) · '+fmtElapsed(elapsed)+'\nIl primo caricamento può essere molto lento sul Pixel 7 Pro. Questa fase non fornisce una percentuale reale.\nPuoi toccare Annulla per interrompere.');
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
  demucsWorker.postMessage({type:'separate',sampleRate:44100,stem,channels},channels.map(c=>c.buffer));
 });
}

function makeStemBuffer(result){
 const b=context.createBuffer(2,result.length,44100);
 for(let c=0;c<2;c++)b.getChannelData(c).set(result.channels[c]);
 return b;
}
function renderStem(){
 $('tracks').replaceChildren();
 $('trackselect').innerHTML='<option value="original">Brano originale (non separato)</option>';
 for(const [key,name] of STEMS){
  const buff=stems[key];if(!buff)continue;
  const div=document.createElement('div');div.className='track';
  const title=document.createElement('strong');title.dataset.stemName=key;
  title.textContent=shownStemName(key);
  const audio=document.createElement('audio');audio.controls=true;audio.preload='none';
  const controls=document.createElement('div');controls.className='actions';
  const listen=document.createElement('button');listen.className='secondary';listen.textContent='▶ Ascolta';
  listen.onclick=async()=>{
   if(!audio.src){
    listen.disabled=true;listen.textContent='WAV in preparazione…';
    try{const encoded=encodeWav(buff);await validateWav(encoded);audio.src=URL.createObjectURL(encoded);}
    catch(e){setStatus('Errore ascolto: '+e.message);}
    finally{listen.disabled=false;listen.textContent='▶ Ascolta';}
   }
   if(audio.src)await audio.play().catch(e=>setStatus('Riproduzione non disponibile: '+e.message));
  };
  const download=document.createElement('button');download.textContent='⬇ WAV';download.className='secondary';
  download.onclick=()=>exportWav(buff,slug(audioFile.name)+'_'+key+'.wav');
  const score=document.createElement('button');score.textContent='🎼 Spartito '+(key==='other'?'(stimato)':'singolo');
  score.onclick=async()=>{$('trackselect').value=key;await transcribe();};
  const midi=document.createElement('button');midi.textContent='⬇ MIDI';midi.className='secondary';
  midi.onclick=()=>downloadForStem(key,'midi');
  const xml=document.createElement('button');xml.textContent='⬇ MusicXML';xml.className='secondary';
  xml.onclick=()=>downloadForStem(key,'xml');
  const pdf=document.createElement('button');pdf.textContent='⬇ PDF';pdf.className='secondary';
  pdf.onclick=()=>downloadForStem(key,'pdf');
  controls.append(listen,download,score,midi,xml,pdf);
  div.append(title,audio,controls);$('tracks').append(div);
  const opt=document.createElement('option');opt.value=key;opt.textContent=shownStemName(key);
  $('trackselect').append(opt);
 }
 if(activeStem && stems[activeStem])$('trackselect').value=activeStem;
 btn('wavSelected',Boolean(stems[activeStem]));
}
async function downloadForStem(key,format){
 const btnId=format==='xml'?'xml':format;
 if(!stems[key])return;
 if(!currentMidi||currentMidiStem!==key){
  $('trackselect').value=key;
  await transcribe();
 }
 if(!currentMidi||currentMidiStem!==key){
  setStatus('Impossibile esportare: trascrizione dello strumento non disponibile.');
  return;
 }
 if(!$(btnId).disabled)$(btnId).click();
}
async function separate(){
 if(busy)return;busy=true;btn('separate',false);
 try{
  const stem=$('isolateInstrument').value;
  if(!STEM_KEYS.includes(stem))throw Error('Seleziona uno strumento valido');
  setStatus('Decodifica audio in corso…');progress('progress',2);
  const buf=await decodeAudio();
  if(buf.sampleRate!==44100||buf.numberOfChannels!==2)
   throw Error('Conversione 44.100 Hz stereo non riuscita');
  const result=await runDemucsInWorker(buf,stem);
  // Keep only one isolated instrument at a time to avoid out-of-memory on mobile.
  stems={[stem]:makeStemBuffer(result)};
  activeStem=stem;currentMidi=null;currentNotes=[];currentMidiStem=null;
  instrumentLabel='';instrumentPredictions=[];latestInstrumentPredictions=[];
  for(const k of ['pdf','xml','midi','preview'])btn(k,false);
  renderStem();
  btn('zipall',true);
  btn('identify',stem==='other');
  setStatus(shownStemName(stem)+' isolato offline. Puoi ascoltarlo o scaricare il WAV, oppure generare MIDI/MusicXML/PDF.');
  if(stem==='other')await identifyResidual();
 }catch(e){
  setStatus('Separazione interrotta: '+String(e?.message||e)+'. Prova un estratto breve o libera memoria: il modello 6s richiede molta RAM.');console.error(e);
 }finally{
  if(separationTimer){clearInterval(separationTimer);separationTimer=null;}
  $('cancel').hidden=true;$('progress').style.display='none';
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
  currentNotes=[];currentMidi=null;currentMidiStem=null;scoreTitle=slug(audioFile.name)+' · '+shownStemName(which);
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
  currentNotes=refineInstrumentNotes(raw,which);
  if(!currentNotes.length)throw Error('Nessuna nota affidabile trovata per '+shownStemName(which)+'. Cambia sensibilità e riprova.');
  setStatus('Note verificate per '+shownStemName(which)+': '+currentNotes.length+'. Gamma musicale '+noteRange(which)+'.');
  const bpm=Math.max(40,Math.min(240,Number($('tempo').value)||120));
  const midi=new Midi();midi.header.name=scoreTitle;midi.header.setTempo(bpm);
  const t=midi.addTrack();t.name=which;t.instrument.number=which==='bass'?33:which==='vocals'?53:0;
  for(const n of currentNotes)t.addNote({midi:n.pitch,time:n.start,duration:n.duration,velocity:n.velocity});
  currentMidi=midi;currentMidiStem=which;
  await showAccurateScore();for(const k of ['pdf','xml','midi','preview'])btn(k,true);
  setStatus('Spartito MusicXML generato: '+currentNotes.length+' note · '+bpm+' BPM. Esporta PDF e MusicXML oppure modifica tempo/soglia per migliorare il risultato.');
 }catch(e){setStatus('Trascrizione non riuscita: '+(e?.message||e));console.error(e)}
 finally{$('midiProgress').style.display='none';btn('transcribe',true);busy=false;}
}
$('transcribe').onclick=transcribe;

$('detectBpm').onclick=async()=>{
 if(!audioFile)return;
 btn('detectBpm',false);
 try{
  setStatus('Analisi offline del tempo musicale (estratto di massimo 30 secondi)…');
  const buf=await decodeAudio();
  const n=Math.min(buf.length,buf.sampleRate*30);
  const mono=context.createBuffer(1,n,buf.sampleRate);
  const target=mono.getChannelData(0);
  const source=Array.from({length:buf.numberOfChannels},(_,i)=>buf.getChannelData(i));
  for(let i=0;i<n;i++){
   let sum=0;for(const ch of source)sum+=ch[i];target[i]=sum/source.length;
  }
  const {analyze}=await import('web-audio-beat-detector');
  const result=await analyze(mono);
  if(!Number.isFinite(result)||result<40||result>240)throw Error('BPM non rilevabile con affidabilità');
  $('tempo').value=String(Math.round(result));
  setStatus('BPM stimato: '+Math.round(result)+'. Se la battuta è sbagliata, correggilo manualmente e premi Anteprima MusicXML.');
 }catch(e){setStatus('Rilevamento BPM non riuscito: '+String(e?.message||e)+'. Imposta il tempo manualmente.');}
 finally{btn('detectBpm',true);}
};


// Professional offline score: OpenSheetMusicDisplay's SVG page renderer.
// SVG keeps note heads, clefs and staff rules sharp at any zoom and on paper.
// A4 portrait with consistent margins; PDF uses the same MusicXML as preview.
let scoreSVGPages=[];
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
 scoreSVGPages=[];
 const {OpenSheetMusicDisplay}=await import('opensheetmusicdisplay');
 const xml=musicXML();
 // Render at a fixed print-like width, independent of phone screen dimensions.
 // OSMD can otherwise compress measures into a narrow mobile view.
 host.style.width='794px';
 host.style.maxWidth='none';
 const renderer=new OpenSheetMusicDisplay(host,{
  autoResize:false,
  backend:'svg',
  drawTitle:true,
  drawComposer:false,
  pageFormat:'A4_P',
  renderSingleHorizontalStaffline:false
 });
 await renderer.load(xml);
 renderer.Zoom=0.82;
 renderer.render();
 scoreSVGPages=Array.from(host.querySelectorAll('svg')).filter(svg=>
   svg.querySelector('path,line,g') && (svg.getAttribute('width')||svg.viewBox?.baseVal?.width));
 if(!scoreSVGPages.length)throw Error('Nessuna pagina SVG generata dal motore spartiti.');
 // Let the preview scroll horizontally on small screens without distorting notes.
 host.style.width='100%';
 host.style.overflowX='auto';
}
function svgDimensions(svg){
 const vb=svg.viewBox?.baseVal;
 const width=vb?.width||parseFloat(svg.getAttribute('width'))||794;
 const height=vb?.height||parseFloat(svg.getAttribute('height'))||1123;
 if(!(width>0&&height>0))throw Error('Dimensioni della pagina non valide');
 return {width,height};
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
  setStatus('Impaginazione vettoriale MusicXML su fogli A4…');
  // Load the SVG-to-PDF converter only when requested.
  await import('svg2pdf.js');
  await showAccurateScore();
  const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true,precision:12});
  pdf.setProperties({
   title:scoreTitle,subject:'Spartito da trascrizione automatica',
   author:'AmpySongScriber',creator:'AmpySongScriber + OpenSheetMusicDisplay'
  });
  const pageWidth=210,pageHeight=297;
  const left=14,right=14,top=17,bottom=16;
  const availW=pageWidth-left-right,availH=pageHeight-top-bottom;
  const cleanName=String(scoreTitle||'Spartito').replace(/[^\x20-\x7E]/g,' ').slice(0,65);
  for(let i=0;i<scoreSVGPages.length;i++){
   if(i)pdf.addPage('a4','portrait');
   const svg=scoreSVGPages[i];
   const {width,height}=svgDimensions(svg);
   const scale=Math.min(availW/width,availH/height);
   const drawW=width*scale,drawH=height*scale;
   const x=left+(availW-drawW)/2;
   // preserve aspect ratio: never squash pentagrams to page dimensions
   await pdf.svg(svg,{x,y:top,width:drawW,height:drawH});
   // Subtle footer stays outside the music area
   pdf.setDrawColor(205);pdf.setLineWidth(.2);
   pdf.line(left,pageHeight-12,pageWidth-right,pageHeight-12);
   pdf.setTextColor(105);pdf.setFont('helvetica','normal');pdf.setFontSize(8);
   pdf.text('AmpySongScriber  |  '+cleanName,left,pageHeight-8);
   pdf.text((i+1)+' / '+scoreSVGPages.length,pageWidth-right,pageHeight-8,{align:'right'});
  }
  const blob=pdf.output('blob');
  if(blob.size<2000)throw Error('PDF vettoriale incompleto');
  await exportFile(blob,slug(audioFile.name)+'_'+$('trackselect').value+'.pdf');
  setStatus('PDF vettoriale A4 esportato: '+scoreSVGPages.length+' pagine, margini uniformi, note nitide.');
 }catch(e){
  setStatus('PDF non riuscito: '+e.message+'. Prova a esportare MusicXML per completare l’impaginazione in MuseScore.');
  console.error('Vector score export',e);
 }finally{btn('pdf',true);}
};
$('identify').onclick=async()=>{
 if(!stems.other)return;
 btn('identify',false);
 const area=$('instrumentResults');area.textContent='Analisi IA locale in corso…';
 try{
  const candidates=await recognizeInstruments(stems.other,s=>area.textContent=s);
  latestInstrumentPredictions=candidates;
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


