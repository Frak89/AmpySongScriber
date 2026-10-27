// Dedicated worker for memory-heavy 4-stem inference. Keeps Android WebView UI responsive.
// AudioBuffer and AudioContext are not available in workers; use lightweight stereo buffer view.
import {loadDemucsModel, separateStems} from './demucs-loader.js';

let session=null;
let running=false;

self.onmessage=async (event)=>{
 if(event.data?.type!=='separate'||running)return;
 running=true;
 const {channels,sampleRate}=event.data;
 try{
  if(channels.length!==2||sampleRate!==44100)throw Error('HTDemucs requires 44.1 kHz stereo. Input conversion failed.');
  self.postMessage({type:'status',stage:'model',message:'Apertura modello locale HTDemucs (181 MB)…'});
  if(!session){
    session=await loadDemucsModel((m)=>{
      self.postMessage({type:'modelProgress',stage:m.stage,percent:m.percent});
    });
  }
  self.postMessage({type:'status',stage:'separating',message:'Modello pronto; separazione audio in corso'});
  const buf={
    numberOfChannels:2,
    length:channels[0].length,
    getChannelData:(i)=>channels[i]
  };
  const result=await separateStems(session,buf,44100,(progress)=>{
    self.postMessage({type:'progress',...progress});
  });
  // Transfer stems, not clone hundreds of MB of Float32Arrays.
  const transfers=result.stemData.flat().map(a=>a.buffer);
  self.postMessage({type:'done',result},transfers);
 }catch(error){
  self.postMessage({type:'error',message:String(error?.message||error),stack:String(error?.stack||'')});
 }finally{
  running=false;
 }
};
