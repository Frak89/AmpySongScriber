/**
 * Offline separation worker, Rev9. Selects tested 4-stem compatibility mode
 * for bass/drums/vocals/residual, and experimental 6-stem for guitar/piano.
 * If six-stem initialization fails for a shared stem, fallback to four-stem.
 */
import {loadDemucs6,isolateStem} from './demucs6-loader.js';
import {loadDemucsModel,separateLegacySingleStem} from './demucs-loader.js';
let six=null,four=null,running=false;

function errorText(e){
 return e instanceof Error?(e.stack||e.message):
  e===undefined?'errore ONNX senza dettagli':String(e);
}
async function runFour(audio,stem,onProgress){
 if(!['bass','drums','vocals','other'].includes(stem))
  throw Error('Il modello a 4 tracce non sa isolare '+stem+' come strumento singolo.');
 if(!four){
  self.postMessage({type:'status',stage:'model',message:'Carico HTDemucs 4 tracce: modalità compatibile…'});
  four=await loadDemucsModel(m=>self.postMessage({type:'modelProgress',...m}));
 }
 self.postMessage({type:'status',stage:'separating',message:'Separazione '+stem+' con modello 4 tracce compatibile…'});
 return separateLegacySingleStem(four,audio,stem,onProgress);
}
self.onmessage=async event=>{
 if(event.data?.type!=='separate'||running)return;
 running=true;
 const {channels,sampleRate,stem,mode='auto'}=event.data;
 try{
  if(channels?.length!==2||sampleRate!==44100)
   throw Error('Audio stereo 44.100 Hz richiesto');
  const source={length:channels[0].length,numberOfChannels:2,sampleRate:44100,
   getChannelData:i=>channels[i]};
  const progress=p=>self.postMessage({type:'progress',...p});
  const legacyStems=['bass','drums','vocals','other'];
  const useLegacy=mode==='compatible'||(mode==='auto'&&legacyStems.includes(stem));
  let result,engine;
  if(useLegacy){
   result=await runFour(source,stem,progress);
   engine='HTDemucs4 compatibile';
  }else{
   try{
    if(!six){
     self.postMessage({type:'status',stage:'model',message:'Carico HTDemucs 6s (sperimentale, molta RAM)…'});
     six=await loadDemucs6(m=>self.postMessage({type:'modelProgress',...m}));
    }
    self.postMessage({type:'status',stage:'separating',message:'Isolamento '+stem+' con HTDemucs 6s…'});
    result=await isolateStem(six,source,stem,progress);
    engine='HTDemucs6s';
   }catch(e){
    self.postMessage({type:'status',stage:'model',
     message:'6s fallito: '+errorText(e)+'. Verifico fallback 4 tracce…'});
    if(!legacyStems.includes(stem))throw Error(
     '6s non inizializzabile: '+errorText(e)+
     '. Il fallback non separa chitarra/pianoforte individualmente. Prova Basso o il residuo.');
    result=await runFour(source,stem,progress);
    engine='HTDemucs4 fallback';
   }
  }
  result.engine=engine;
  self.postMessage({type:'done',result},result.channels.map(x=>x.buffer));
 }catch(e){
  self.postMessage({type:'error',message:errorText(e)});
 }finally{running=false;}
};