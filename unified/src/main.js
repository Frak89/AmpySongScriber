import {loadDemucsModel,separateStems,extractStems} from './demucs-loader.js';
import {BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime} from '@spotify/basic-pitch';
import {Midi} from '@tonejs/midi';
import JSZip from 'jszip';
import {jsPDF} from 'jspdf';
import {Filesystem,Directory} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {Capacitor} from '@capacitor/core';

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
   const size=1024*1024;let first=true;
   for(let offset=0; offset<blob.size; offset+=size) {
     const bytes=new Uint8Array(await blob.slice(offset,offset+size).arrayBuffer());
     const data=toBase64(bytes);
     if(first){await Filesystem.writeFile({directory:Directory.Cache,path:temp,data,recursive:true});first=false;}
     else await Filesystem.appendFile({directory:Directory.Cache,path:temp,data});
   }
   if(first)await Filesystem.writeFile({directory:Directory.Cache,path:temp,data:''});
   const file=await Filesystem.getUri({directory:Directory.Cache,path:temp});
   await Share.share({title:'AmpySongScriber · '+name,text:'Salva o condividi '+name,url:file.uri,dialogTitle:'Salva il file'});
 } catch(e){setStatus('Esportazione nativa non riuscita: '+e.message);throw e;}
}
function wav(blob){
 const n=blob.length, ch=blob.numberOfChannels, rate=blob.sampleRate,bytes=44+n*ch*2;
 const arr=new ArrayBuffer(bytes),dv=new DataView(arr);let o=0;
 const chars=(s)=>{for(let i=0;i<s.length;i++)dv.setUint8(o++,s.charCodeAt(i))};
 const u32=(x)=>{dv.setUint32(o,x,true);o+=4};const u16=(x)=>{dv.setUint16(o,x,true);o+=2};
 chars('RIFF');u32(bytes-8);chars('WAVEfmt ');u32(16);u16(1);u16(ch);u32(rate);
 u32(rate*ch*2);u16(ch*2);u16(16);chars('data');u32(bytes-44);
 const tracks=Array.from({length:ch},(_,c)=>blob.getChannelData(c));
 for(let i=0;i<n;i++)for(let c=0;c<ch;c++){let x=Math.max(-1,Math.min(1,tracks[c][i]));dv.setInt16(o,x<0?x*32768:x*32767,true);o+=2;}
 return new Blob([arr],{type:'audio/wav'});
}
async function openFile(file) {
 if(!file)return;
 audioFile=file; stems={};currentMidi=null;currentNotes=[];
 btn('separate',true);btn('transcribe',true);btn('zipall',false);
 for(const k of ['pdf','xml','midi'])btn(k,false);
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
     finish(null,d.result);
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
    const audio=document.createElement('audio');audio.controls=true;audio.src=URL.createObjectURL(wav(buff));
    const controls=document.createElement('div');controls.className='actions';
    const dl=document.createElement('button');dl.className='secondary';dl.textContent='⬇ WAV';
    dl.onclick=()=>exportFile(wav(buff),slug(audioFile.name)+'_'+key+'.wav');
    const score=document.createElement('button');score.textContent='🎼 Spartito';score.className='secondary';
    score.onclick=()=>{$('trackselect').value=key;transcribe()};
    controls.append(dl,score);div.append(title,audio,controls);$('tracks').append(div);
    const opt=document.createElement('option');opt.value=key;opt.textContent=name;
    $('trackselect').append(opt);
  }
  btn('zipall',true);
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
   if(stems[key])zip.file(slug(audioFile.name)+'_'+key+'.wav',wav(stems[key]));
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
  const raw=noteFramesToTime(addPitchBendsToNoteEvents(contours,outputToNotesPoly(frames,onsets,.35,.3,7)));
  currentNotes=raw.filter(x=>x.pitchMidi>=21&&x.pitchMidi<=108&&x.durationSeconds>.045).map(n=>({pitch:n.pitchMidi,start:Math.max(0,n.startTimeSeconds),duration:n.durationSeconds,velocity:Math.min(1,Math.max(.1,n.amplitude||.7))})).sort((a,b)=>a.start-b.start);
  const midi=new Midi();midi.header.name=scoreTitle;midi.header.setTempo(120);
  const t=midi.addTrack();t.name=which;t.instrument.number=which==='bass'?33:which==='vocals'?53:0;
  for(const n of currentNotes)t.addNote({midi:n.pitch,time:n.start,duration:n.duration,velocity:n.velocity});
  currentMidi=midi;
  showScore(currentNotes,scoreTitle);for(const k of ['pdf','xml','midi'])btn(k,true);
  setStatus('Spartito generato: '+currentNotes.length+' note individuate. Esporta in MusicXML per correggerlo con MuseScore.');
 }catch(e){setStatus('Trascrizione non riuscita: '+(e?.message||e));console.error(e)}
 finally{$('midiProgress').style.display='none';btn('transcribe',true);busy=false;}
}
$('transcribe').onclick=transcribe;

// Minimal, interoperable notation renderer: 4/4, tempo 120, quarter-beat quantization.
// Complex polyphony can be edited in MuseScore via the exported MusicXML.
function letter(p){const k=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];return k[(p%12+12)%12]+(Math.floor(p/12)-1)}
const noteNames=['C','C','D','D','E','F','F','G','G','A','A','B'];
const altered=[0,1,0,1,0,0,1,0,1,0,1,0];
function roundedNotes(notes){
 const grid=new Map();for(const n of notes){
  const beat=Math.round(n.start*8)/4; // 120bpm; half-quarter grid
  if(!grid.has(beat))grid.set(beat,[]);
  grid.get(beat).push(n);
 }
 return grid;
}
function drawPage(notes,title,page,totalPages){
 const c=document.createElement('canvas');const W=1200,H=1640;c.width=W;c.height=H;
 const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,W,H);x.fillStyle='#101010';
 x.font='bold 31px sans-serif';x.fillText(title.slice(0,62),64,75);
 x.font='17px sans-serif';x.fillText('AmpySongScriber · trascrizione automatica · 4/4 · ♩ = 120',65,112);
 const beatsPerPage=32, section=page*beatsPerPage;
 const grid=roundedNotes(notes);
 const bass=$('trackselect').value==='bass',base=bass?43:64;
 for(let line=0;line<8;line++){
  const top=190+line*170, left=75,right=1130; x.strokeStyle='#171717';x.lineWidth=1.8;
  for(let s=0;s<5;s++){x.beginPath();x.moveTo(left,top+s*12);x.lineTo(right,top+s*12);x.stroke()}
  x.font='58px serif';x.fillText(bass?'𝄢':'𝄞',left+7,top+45);
  const startBeat=section+line*4;
  for(let b=0;b<4;b++){
   if(b>0){const sx=left+85+b*245;x.beginPath();x.moveTo(sx,top);x.lineTo(sx,top+48);x.stroke();}
   const at=startBeat+b;
   const group=[...(grid.get(at)||[])].sort((a,b)=>a.pitch-b.pitch);
   const xx=left+136+b*245;
   if(!group.length){x.font='25px serif';x.fillText('𝄽',xx,top+29);continue}
   for(const n of group.slice(0,5)){
    // Staff steps computed diatonically from E4 (treble) or G2 (bass).
    const oct=Math.floor(n.pitch/12)-1,diat=[0,0,1,1,2,3,3,4,4,5,5,6][n.pitch%12];
    const staff=((oct-(bass?2:4))*7+diat-(bass?4:2));
    const y=top+48-staff*6;
    x.save();x.translate(xx,y);x.rotate(-.3);x.beginPath();x.ellipse(0,0,10,7,0,0,Math.PI*2);x.fill();x.restore();
    x.beginPath();x.moveTo(xx+9,y);x.lineTo(xx+9,y-40);x.stroke();
    if(altered[n.pitch%12]){x.font='20px serif';x.fillText('♯',xx-24,y+5)}
    if(staff<0){for(let ly=-2;ly>=staff;ly-=2){const q=top+48-ly*6;x.beginPath();x.moveTo(xx-16,q);x.lineTo(xx+16,q);x.stroke()}}
    if(staff>8){for(let ly=10;ly<=staff;ly+=2){const q=top+48-ly*6;x.beginPath();x.moveTo(xx-16,q);x.lineTo(xx+16,q);x.stroke()}}
   }
  }
 }
 x.font='16px sans-serif';x.fillText('Pagina '+(page+1)+' / '+totalPages+' · revisione consigliata in MuseScore',64,1585);
 return c;
}
let sheetCanvases=[];
function showScore(notes,title){
 $('score').replaceChildren();const maxSec=Math.max(0,...notes.map(n=>n.start+n.duration));
 const count=Math.max(1,Math.min(100,Math.ceil(maxSec/16)));
 sheetCanvases=[];
 for(let p=0;p<count;p++){const c=drawPage(notes,title,p,count);sheetCanvases.push(c);$('score').append(c)}
 $('score').style.display='block';
}
$('midi').onclick=()=>{if(currentMidi)exportFile(new Blob([currentMidi.toArray()],{type:'audio/midi'}),slug(audioFile.name)+'_'+$('trackselect').value+'.mid')};
$('pdf').onclick=async()=>{
 if(!sheetCanvases.length)return;
 const pdf=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
 for(let i=0;i<sheetCanvases.length;i++){
  if(i)pdf.addPage();pdf.addImage(sheetCanvases[i].toDataURL('image/jpeg',.82),'JPEG',0,0,210,287);
 }
 await exportFile(pdf.output('blob'),slug(audioFile.name)+'_'+$('trackselect').value+'.pdf');
};
function esc(s){return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
function musicXML(){
 const notes=currentNotes, duration=Math.max(1,Math.ceil(Math.max(0,...notes.map(n=>n.start+n.duration))/2));
 const by=roundedNotes(notes), part=[];
 // Quarter notes per beat and 4 beats per measure: chords grouped by beats.
 for(let measure=0;measure<duration;measure++){
  let content='<measure number="'+(measure+1)+'">';
  if(measure===0){content+='<attributes><divisions>480</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>'+($('trackselect').value==='bass'?'F':'G')+'</sign><line>'+($('trackselect').value==='bass'?'4':'2')+'</line></clef></attributes>'}
  for(let beat=0;beat<4;beat++){
   const bucket=[...(by.get(measure*4+beat)||[])].sort((a,b)=>a.pitch-b.pitch);
   if(!bucket.length){content+='<note><rest/><duration>480</duration><type>quarter</type></note>';continue}
   for(let i=0;i<Math.min(8,bucket.length);i++){
    const pitch=bucket[i].pitch,pitchClass=pitch%12,oct=Math.floor(pitch/12)-1;
    content+='<note>'+(i?'<chord/>':'')+'<pitch><step>'+noteNames[pitchClass]+'</step>'+(altered[pitchClass]?'<alter>1</alter>':'')+'<octave>'+oct+'</octave></pitch><duration>480</duration><type>quarter</type></note>';
   }
  }
  content+='</measure>';part.push(content);
 }
 return '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE score-partwise  PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>'+esc(scoreTitle)+'</work-title></work><movement-title>'+esc(scoreTitle)+'</movement-title><identification><creator type="software">AmpySongScriber · MuseScore compatible</creator></identification><defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults><part-list><score-part id="P1"><part-name>'+esc($('trackselect').selectedOptions[0]?.textContent||'Strumento')+'</part-name><part-abbreviation>Inst.</part-abbreviation><score-instrument id="I1"><instrument-name>Instrument</instrument-name></score-instrument></score-part></part-list><part id="P1">'+part.join('')+'</part></score-partwise>';
}
$('xml').onclick=()=>exportFile(new Blob([musicXML()],{type:'application/vnd.recordare.musicxml+xml'}),slug(audioFile.name)+'_'+$('trackselect').value+'.musicxml');
