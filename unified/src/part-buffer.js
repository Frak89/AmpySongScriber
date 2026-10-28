/**
 * Rev8: durable incremental WAV parts in Android app-private files.
 * Every completed 10-second chunk is saved as a valid PCM16 WAV, with
 * manifest written afterwards. Final merging streams PCM payloads in order
 * without allocating the entire song in memory.
 * Android Data survives process crashes, not uninstall/clear storage.
 */
import {Filesystem,Directory,Encoding} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
import {Capacitor} from '@capacitor/core';
import JSZip from 'jszip';
import {encodeWav,validateWav} from './wav.js';

const ROOT='AmpySongScriber/parts',LAST=ROOT+'/last-session.json';
const native=()=>Capacitor.isNativePlatform();
function slug(str){return String(str).replace(/[^a-z0-9._-]+/gi,'_').slice(0,45)||'strumento';}
function b64(bytes){
 let str='';
 for(let i=0;i<bytes.length;i+=8192)str+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return btoa(str);
}
function bytesFromB64(str){
 const binary=atob(str);const data=new Uint8Array(binary.length);
 for(let i=0;i<data.length;i++)data[i]=binary.charCodeAt(i);
 return data;
}
function header(samples,rate=22050,channels=1){
 const data=samples*channels*2;
 if(!Number.isSafeInteger(data)||data>0xFFFFFF00)throw Error('WAV supera 4 GB');
 const ab=new ArrayBuffer(44),v=new DataView(ab);
 const str=(i,s)=>{for(let j=0;j<s.length;j++)v.setUint8(i+j,s.charCodeAt(j));};
 str(0,'RIFF');v.setUint32(4,36+data,true);str(8,'WAVE');str(12,'fmt ');
 v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,channels,true);
 v.setUint32(24,rate,true);v.setUint32(28,rate*channels*2,true);
 v.setUint16(32,channels*2,true);v.setUint16(34,16,true);str(36,'data');
 v.setUint32(40,data,true);return new Uint8Array(ab);
}
export function mergedWaveBytes(parts,rate=22050){
 // Pure builder for test and web preview. Android uses streaming merge instead.
 const n=parts.reduce((a,p)=>a+(p.byteLength-44)/2,0);
 const out=new Uint8Array(44+n*2);out.set(header(n,rate));
 let at=44;
 for(const p of parts){
  if(p.byteLength<44)throw Error('Parte WAV corrotta');
  out.set(p.subarray(44),at);at+=p.byteLength-44;
 }
 return out;
}
async function writeJSON(path,data){
 await Filesystem.writeFile({path,directory:Directory.Data,encoding:Encoding.UTF8,
  data:JSON.stringify(data),recursive:true});
}
async function readJSON(path){
 const result=await Filesystem.readFile({path,directory:Directory.Data,encoding:Encoding.UTF8});
 return JSON.parse(String(result.data));
}
export async function createPartBuffer(song,stem){
 const session={
  schema:1,
  id:new Date().toISOString().replace(/[-:.TZ]/g,'')+'_'+Math.floor(Math.random()*10000),
  song:String(song||'brano').slice(0,180),stem:String(stem),
  sampleRate:22050,channels:1,startedAt:new Date().toISOString(),
  parts:[],totalSamples:0,complete:false
 };
 if(native()){
  await Filesystem.mkdir({path:ROOT+'/'+session.id,directory:Directory.Data,recursive:true});
  await writeJSON(LAST,session);
 }
 const webParts=[];
 async function persist(){
  if(native())await writeJSON(LAST,session);
 }
 async function appendPart(buf){
  if(session.complete)throw Error('Sessione già completata');
  if(buf.sampleRate!==22050||buf.numberOfChannels!==1||buf.length===0)
   throw Error('Parte richiede audio mono a 22050 Hz');
  const partName='part'+String(session.parts.length+1).padStart(3,'0')+'.wav';
  const wave=encodeWav(buf);
  await validateWav(wave);
  const bytes=new Uint8Array(await wave.arrayBuffer());
  const data={name:partName,frames:buf.length,bytes:bytes.length,startSample:session.totalSamples};
  if(native()){
   const path=ROOT+'/'+session.id+'/'+partName;
   await Filesystem.writeFile({directory:Directory.Data,path,data:b64(bytes),recursive:true});
   const stat=await Filesystem.stat({directory:Directory.Data,path});
   if(stat.size!==bytes.length)throw Error('Parte scritta incompleta: '+partName);
  }else webParts.push(bytes);
  session.parts.push(data);session.totalSamples+=buf.length;
  await persist(); // manifest is committed AFTER part file is verified.
  return {part:data,session:sessionSummary()};
 }
 function sessionSummary(){return {...session,parts:session.parts.map(x=>({...x}))};}
 async function getPartBytes(i){
  const p=session.parts[i];
  if(!p)throw Error('Parte '+(i+1)+' mancante');
  if(!native())return webParts[i];
  const path=ROOT+'/'+session.id+'/'+p.name;
  const result=await Filesystem.readFile({path,directory:Directory.Data});
  const bytes=bytesFromB64(String(result.data));
  if(bytes.length!==p.bytes)throw Error('Parte '+p.name+' incompleta');
  return bytes;
 }
 async function joinToFile(){
  if(!session.parts.length)throw Error('Non ci sono parti da unire');
  const filename='AmpySongScriber_'+slug(session.song)+'_'+slug(session.stem)+'_cleaned.wav';
  if(!native()){
   const pieces=[];
   for(let i=0;i<session.parts.length;i++)pieces.push(await getPartBytes(i));
   return {filename,blob:new Blob([mergedWaveBytes(pieces)],{type:'audio/wav'})};
  }
  const temp='AmpySongScriber_merged_'+session.id+'.wav';
  const head=header(session.totalSamples,22050);
  await Filesystem.writeFile({path:temp,directory:Directory.Cache,data:b64(head),recursive:true});
  for(let i=0;i<session.parts.length;i++){
   const wave=await getPartBytes(i);
   await Filesystem.appendFile({path:temp,directory:Directory.Cache,data:b64(wave.subarray(44))});
  }
  const stat=await Filesystem.stat({path:temp,directory:Directory.Cache});
  const expected=44+session.totalSamples*2;
  if(stat.size!==expected)throw Error('WAV unito incompleto '+stat.size+' / '+expected);
  const file=await Filesystem.getUri({path:temp,directory:Directory.Cache});
  return {filename,uri:file.uri,bytes:expected};
 }
 async function shareFinal(){
  const final=await joinToFile();
  if(final.blob)return final;
  await Share.share({title:final.filename,files:[final.uri],dialogTitle:'Salva WAV completo'});
  return final;
 }
 async function zipParts(){
  const z=new JSZip();
  for(let i=0;i<session.parts.length;i++){
   z.file(session.parts[i].name,await getPartBytes(i));
  }
  z.file('manifest.json',JSON.stringify(sessionSummary(),null,2));
  return z.generateAsync({type:'blob',compression:'STORE'});
 }
 async function finish(){
  if(!session.parts.length)throw Error('Nessun blocco salvato');
  session.complete=true;session.completedAt=new Date().toISOString();
  await persist();return sessionSummary();
 }
 async function fullAudioBuffer(){
  if(!session.parts.length)throw Error('Nessuna parte disponibile');
  const total=session.totalSamples;
  const ctx=new OfflineAudioContext(1,total,22050);
  const buf=ctx.createBuffer(1,total,22050),data=buf.getChannelData(0);
  let offset=0;
  for(let i=0;i<session.parts.length;i++){
   const bytes=await getPartBytes(i);
   const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
   const frames=session.parts[i].frames;
   for(let j=0;j<frames;j++)data[offset+j]=view.getInt16(44+j*2,true)/32768;
   offset+=frames;
  }
  return buf;
 }
 return {appendPart,finish,sessionSummary,getPartBytes,joinToFile,shareFinal,zipParts,fullAudioBuffer};
}
export async function lastPartSession(){
 if(!native())return null;
 try{return await readJSON(LAST);}catch{return null;}
}
