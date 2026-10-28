// Rev7 dedicated worker: true 6-source model, single selected stem returned
// to the UI to avoid allocating six complete WAV outputs in memory.
import {loadDemucs6,isolateStem} from './demucs6-loader.js';
let session=null,running=false;
self.onmessage=async e=>{
 if(e.data?.type!=='separate'||running)return;
 running=true;
 const {channels,sampleRate,stem}=e.data;
 try{
  if(channels?.length!==2||sampleRate!==44100)throw Error('Audio 44.1 kHz stereo richiesto');
  self.postMessage({type:'status',stage:'model',message:'Inizializzo HTDemucs-6s locale (pesi ~136 MB)…'});
  if(!session)session=await loadDemucs6(m=>self.postMessage({type:'modelProgress',...m}));
  self.postMessage({type:'status',stage:'separating',message:'Isolamento: '+stem});
  const audio={
   length:channels[0].length,numberOfChannels:2,sampleRate:44100,
   getChannelData:i=>channels[i]
  };
  const result=await isolateStem(session,audio,stem,p=>self.postMessage({type:'progress',...p}));
  self.postMessage({type:'done',result},result.channels.map(x=>x.buffer));
 }catch(error){
  self.postMessage({type:'error',message:String(error?.message||error),stack:String(error?.stack||'')});
 }finally{running=false;}
};
