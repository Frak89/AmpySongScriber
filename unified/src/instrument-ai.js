/**
 * YAMNet on-device music instrument classification (AudioSet 521 categories).
 * The model and weights are bundled during Android builds, no network or account.
 * © Google YAMNet authors Apache-2.0; source model from abulhawa/miccheck.
 * Predictions are associations, not evidence that an instrument was perfectly isolated.
 */
import * as tf from '@tensorflow/tfjs';

let modelPromise=null, labelsPromise=null;
const TARGET_RATE=16000;
const MUSICAL_IDS=new Set([
  134,135,136,137,138,139,142,143,144,145,146,147,148,149,150,151,152,153,155,
  156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,
  179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194
]);
const IT={
  'Guitar':'Chitarra', 'Electric guitar':'Chitarra elettrica','Bass guitar':'Basso elettrico',
  'Acoustic guitar':'Chitarra acustica','Steel guitar, slide guitar':'Chitarra slide',
  'Banjo':'Banjo','Sitar':'Sitar','Mandolin':'Mandolino','Zither':'Cetera',
  'Ukulele':'Ukulele','Keyboard (musical)':'Tastiera','Piano':'Pianoforte',
  'Electric piano':'Pianoforte elettrico','Organ':'Organo','Electronic organ':'Organo elettronico',
  'Hammond organ':'Organo Hammond','Synthesizer':'Sintetizzatore','Harpsichord':'Clavicembalo',
  'Drum kit':'Batteria','Drum machine':'Drum machine','Drum':'Tamburo','Snare drum':'Rullante',
  'Bass drum':'Grancassa','Cymbal':'Piatti','Hi-hat':'Charleston',
  'Percussion':'Percussioni','Timpani':'Timpani','Marimba, xylophone':'Marimba / xilofono',
  'Glockenspiel':'Glockenspiel','Vibraphone':'Vibrafono','Orchestra':'Orchestra',
  'Brass instrument':'Ottoni','French horn':'Corno francese','Trumpet':'Tromba',
  'Trombone':'Trombone','Bowed string instrument':'Archi','String section':'Sezione archi',
  'Violin, fiddle':'Violino','Cello':'Violoncello','Double bass':'Contrabbasso',
  'Wind instrument, woodwind instrument':'Fiati','Flute':'Flauto',
  'Saxophone':'Sassofono','Clarinet':'Clarinetto','Harp':'Arpa'
};
async function resources(){
 if(!modelPromise){
   modelPromise=tf.loadGraphModel('./yamnet/model.json').catch(e=>{modelPromise=null;throw e;});
 }
 if(!labelsPromise){
   labelsPromise=fetch('./yamnet/classes.csv').then(r=>{
     if(!r.ok)throw Error('Etichette IA strumenti mancanti');
     return r.text();
   }).then(t=>t.trim().split(/\r?\n/).slice(1).map(line=>line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).map(parts=>(parts[2]||'').replace(/^"|"$/g,''))).catch(e=>{labelsPromise=null;throw e;});
 }
 return Promise.all([modelPromise,labelsPromise]);
}
async function make16K(audioBuffer){
 const target = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * TARGET_RATE), TARGET_RATE);
 const node=target.createBufferSource();node.buffer=audioBuffer;node.connect(target.destination);node.start();
 return await target.startRendering();
}
export async function recognizeInstruments(audioBuffer,onStatus=()=>{}){
 if(!audioBuffer||audioBuffer.length===0)throw Error('Traccia audio vuota');
 onStatus('Inizializzo classificatore YAMNet locale (circa 16 MB)…');
 const [model, labels]=await resources();
 const sample=await make16K(audioBuffer);
 const mono=sample.getChannelData(0);
 // Sample widely separated 2-second excerpts. Keeps RAM/CPU usage bounded.
 const section=2*TARGET_RATE;
 const maxStart=Math.max(0,mono.length-section);
 const offsets=[0,.42,.82].map(t=>Math.floor(maxStart*t));
 const sums=new Float64Array(521);
 let samples=0;
 for(let n=0;n<offsets.length;n++){
   const fragment=mono.slice(offsets[n],Math.min(mono.length,offsets[n]+section));
   if(fragment.length<16000)continue;
   onStatus('Riconoscimento strumenti: segmento '+(n+1)+'/3');
   const input=tf.tensor1d(fragment,'float32');
   let scores;
   try{
     const output=model.predict(input);
     const tensors=Array.isArray(output)?output:[output];
     scores=tensors.find(t=>t.shape[t.shape.length-1]===521);
     if(!scores)throw Error('Forma dati YAMNet non riconosciuta');
     const data=await scores.data();
     const frames=Math.floor(data.length/521);
     for(let f=0;f<frames;f++){
       for(let i=0;i<521;i++)sums[i]+=Math.max(0,data[f*521+i]);
     }
     samples+=frames;
     for(const tensor of tensors){if(tensor!==input)tensor.dispose();}
   }finally{input.dispose();}
   await new Promise(requestAnimationFrame);
 }
 if(!samples)throw Error('Audio troppo corto per la classificazione');
 const result=[...MUSICAL_IDS].map(i=>({
   id:i,name:IT[labels[i]]||labels[i],score:sums[i]/samples
 })).sort((a,b)=>b.score-a.score);
 const selected=result.filter(r=>r.score>=.08).slice(0,5);
 return selected.length?selected:[...result.slice(0,3)].map(x=>({...x,weak:true}));
}
