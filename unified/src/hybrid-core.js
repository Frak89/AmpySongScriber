/**
 * AmpySongScriber Hybrid Engine v1 (Rev15).
 *
 * Independent DSP pitch evidence is fused with existing Basic Pitch neural
 * output. This is NOT a port or bundling of third-party Python / proprietary
 * weights. The core is original, dependency-light and entirely offline.
 *
 * Architecture inspired by research architectures in Omnizart (multi-task),
 * Song-transcriber (cross-check methods), music21 (notation), SheetSage
 * (melody/harmony and tempo hints) and MusIA (meter-aware note gridding).
 */
import FFT from 'fft.js';
import {profileFor,reconcileInstrumentNotes} from './note-cleanup.js';
export const HYBRID_MODES=Object.freeze(['neural','balanced','spectral']);
const SR=22050, N=4096, HOP=2048, MIN_RMS=0.00015;
const LIMITS={bass:[28,72],guitar:[40,88],piano:[21,104],
 vocals:[43,90],other:[28,100],original:[28,100],drums:[21,108]};
const noteHz=p=>440*2**((p-69)/12);
const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const median=a=>{if(!a.length)return 0;const x=[...a].sort((a,b)=>a-b);return x[Math.floor(x.length/2)]};
function getMagnitude(arr,k){const x=arr[2*k]||0,y=arr[2*k+1]||0;return Math.hypot(x,y)}
export function computeSpectralFrames(samples,{stem='bass',sampleRate=SR,maxSeconds=14}={}){
 if(sampleRate!==SR)throw Error('Hybrid DSP richiede mono 22050 Hz');
 if(!samples||!samples.length)return [];
 const range=LIMITS[stem]||LIMITS.original,mono=stem==='bass'||stem==='vocals';
 const fft=new FFT(N),real=new Float32Array(N),freq=fft.createComplexArray();
 const wnd=new Float32Array(N);
 for(let i=0;i<N;i++)wnd[i]=.5-.5*Math.cos(2*Math.PI*i/(N-1));
 const frames=[];
 const end=Math.min(samples.length,Math.round(maxSeconds*SR));
 for(let start=0;start<end;start+=HOP){
  let energy=0;
  for(let i=0;i<N;i++){
   const x=samples[start+i]||0;
   real[i]=x*wnd[i];energy+=x*x;
  }
  const rms=Math.sqrt(energy/N);
  if(rms<MIN_RMS){frames.push({time:(start+N/2)/SR,rms,pitches:[]});continue;}
  fft.realTransform(freq,real);
  const spectrum=new Float32Array(N/2+1);
  for(let k=0;k<spectrum.length;k++)spectrum[k]=getMagnitude(freq,k);
  const scores=[];
  for(let pitch=range[0];pitch<=range[1];pitch++){
   const fundamental=noteHz(pitch);
   if(fundamental<SR/N*1.7||fundamental>SR/2)continue;
   let score=0,matched=0;
   for(let h=1;h<=5;h++){
    const hz=fundamental*h;
    if(hz>SR/2-25)break;
    const b=hz*N/SR,idx=Math.floor(b),fraction=b-idx;
    // Interpolate exact frequency to avoid giving adjacent semitones the
    // same max FFT bin; local max caused off-by-one pitch errors on A2 tests.
    const local=(spectrum[idx]||0)*(1-fraction)+(spectrum[idx+1]||0)*fraction;
    const weight=h===1?1.55:1/Math.sqrt(h);
    score+=local*weight;
    matched++;
   }
   if(matched) scores.push({pitch,score});
  }
  scores.sort((a,b)=>b.score-a.score);
  const maximum=scores[0]?.score||1;
  const pitches=[];
  for(const candidate of scores){
   const confidence=candidate.score/maximum;
   if(confidence<(mono?.76:.70))break;
   if(pitches.some(x=>Math.abs(x.pitch-candidate.pitch)<=1))continue;
   // Avoid interpreting harmonics as a second note in monophonic stems.
   if(mono&&pitches.length)break;
   if(!mono&&pitches.some(x=>Math.abs(x.pitch-candidate.pitch)===12&&confidence<.86))continue;
   pitches.push({pitch:candidate.pitch,confidence:clamp(confidence,0,1)});
   if(pitches.length>=(mono?1:3))break;
  }
  frames.push({time:(start+N/2)/SR,rms,pitches});
 }
 return frames;
}
export function spectralNotesFromFrames(frames,{stem='bass',duration=Infinity}={}){
 if(!Array.isArray(frames)||!frames.length)return [];
 const step=frames.length>1?median(frames.slice(1,9).map((f,i)=>f.time-frames[i].time)):.09;
 const active=new Map(),result=[];
 const finish=(pitch,startState,end)=>{
  const n={pitch,start:Math.max(0,startState.start),duration:Math.max(0,end-startState.start),
   confidence:clamp(startState.sum/Math.max(1,startState.count),0,1),
   velocity:clamp(startState.sum/Math.max(1,startState.count)*.75,.2,1),source:'spectral'};
  if(startState.count>=2&&n.duration>=(stem==='bass'?.105:.085)&&n.start<duration)result.push(n);
 };
 for(const f of frames){
  const present=new Set(f.pitches.filter(p=>p.confidence>.65).map(x=>x.pitch));
  for(const [pitch,state] of [...active]){
   if(!present.has(pitch)){finish(pitch,state,Math.min(f.time,duration));active.delete(pitch);}
  }
  for(const p of f.pitches){
   if(p.confidence<=.65)continue;
   const state=active.get(p.pitch);
   if(state){state.count++;state.sum+=p.confidence;}
   else active.set(p.pitch,{start:Math.max(0,f.time-step/2),count:1,sum:p.confidence});
  }
 }
 const last=(frames.at(-1).time+step/2);
 for(const [pitch,state] of active)finish(pitch,state,Math.min(last,duration));
 return result.sort((a,b)=>a.start-b.start);
}
function overlaps(a,b){
 const left=Math.max(a.start,b.start);
 const right=Math.min(a.start+a.duration,b.start+b.duration);
 return Math.max(0,right-left)/Math.max(.001,Math.min(a.duration,b.duration));
}
export function fusePitchEvidence(neural,spectral,{stem='bass',mode='balanced',duration=Infinity}={}){
 if(!HYBRID_MODES.includes(mode))throw Error('Modalità Hybrid Engine sconosciuta: '+mode);
 const p=profileFor(stem);
 const clean=a=>(a||[]).filter(n=>Number.isInteger(n.pitch)&&n.pitch>=p.min&&n.pitch<=p.max
  &&Number.isFinite(n.start)&&Number.isFinite(n.duration)&&n.duration>=.065&&n.start<duration)
  .map(n=>({...n,confidence:clamp(Number(n.confidence)||.68,0,1)}));
 const n=clean(neural),s=clean(spectral);
 if(mode==='neural')return reconcileInstrumentNotes(n,stem,{duration});
 if(mode==='spectral')return reconcileInstrumentNotes(s,stem,{duration});
 if(!s.length)return reconcileInstrumentNotes(n,stem,{duration});
 if(!n.length)return reconcileInstrumentNotes(s.filter(x=>x.confidence>=.8),stem,{duration});
 const result=[];
 for(const note of n){
  const candidate=s.map(x=>({x,overlap:overlaps(x,note)}))
   .sort((a,b)=>b.overlap-a.overlap)[0];
  if(!candidate||candidate.overlap<.33){
   result.push({...note,confidence:note.confidence*.66,source:'basic-pitch-only'});
   continue;
  }
  const match=candidate.x,delta=Math.abs(match.pitch-note.pitch);
  if(delta===0){
   result.push({...note,confidence:clamp(.58*note.confidence+.42*match.confidence,0,1),
     source:'basic-pitch+spectral'});
  }else if(delta===12&&match.confidence>.94&&note.confidence<.8){
   result.push({...note,pitch:match.pitch,confidence:.65,source:'octave-corrected'});
  }else{
   result.push({...note,confidence:note.confidence*.70,source:'pitch-disagreement'});
  }
 }
 // A stable spectral bass note can fill a gap Basic Pitch missed.
 if(stem==='bass'||stem==='vocals'){
  for(const extra of s){
   if(extra.confidence<.94||extra.duration<.18)continue;
   if(result.some(n=>overlaps(n,extra)>.26))continue;
   result.push({...extra,confidence:extra.confidence*.70,source:'spectral-gap-fill'});
  }
 }
 return reconcileInstrumentNotes(result,stem,{duration});
}
export function runHybridEngine(buffer,neuralNotes,{stem='bass',mode='balanced'}={}){
 if(!buffer||buffer.sampleRate!==SR||buffer.numberOfChannels!==1)
  throw Error('Hybrid Engine richiede audio mono 22050 Hz');
 const start=Date.now();
 const frames=mode==='neural'?[]:computeSpectralFrames(buffer.getChannelData(0),{
  stem,sampleRate:SR,maxSeconds:buffer.duration
 });
 const spectral=spectralNotesFromFrames(frames,{stem,duration:buffer.duration});
 const fused=fusePitchEvidence(neuralNotes,spectral,{stem,mode,duration:buffer.duration});
 return {notes:fused,metrics:{
  mode,stem,neuralCount:(neuralNotes||[]).length,spectralCount:spectral.length,
  fusedCount:fused.length,disagreements:fused.filter(n=>n.source==='pitch-disagreement').length,
  spectralFrames:frames.length,elapsedMs:Date.now()-start,
  status:frames.length?'Two independent estimators (Basic Pitch + FFT harmonic salience)':'Basic Pitch only'
 }};
}
const CHORDS=[
 ['maj',[0,4,7]],['m',[0,3,7]],['7',[0,4,7,10]],['m7',[0,3,7,10]],
 ['sus4',[0,5,7]],['dim',[0,3,6]]
];
const PC=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
export function estimateChordTimeline(notes,{windowSeconds=2,duration=null,minNotes=3}={}){
 const list=(notes||[]).filter(n=>Number.isInteger(n.pitch)&&Number.isFinite(n.start)&&n.duration>0);
 if(!list.length)return [];
 const end=Math.min(duration||Math.max(...list.map(n=>n.start+n.duration)),1800);
 const segments=[];
 for(let t=0;t<end;t+=windowSeconds){
  const chroma=Array(12).fill(0);
  for(const n of list){
   const intersection=Math.max(0,Math.min(t+windowSeconds,n.start+n.duration)-Math.max(t,n.start));
   if(intersection>.04)chroma[n.pitch%12]+=intersection*(n.confidence||.7);
  }
  const total=chroma.reduce((a,b)=>a+b,0);
  const active=chroma.filter(v=>v>total*.08).length;
  if(!total||active<minNotes)continue;
  let best=null;
  for(let root=0;root<12;root++)for(const [suffix,intervals] of CHORDS){
   const hit=intervals.reduce((s,k)=>s+chroma[(root+k)%12],0);
   const confidence=hit/total;
   const penalty=intervals.filter(k=>chroma[(root+k)%12]<total*.03).length*.08;
   const score=confidence-penalty;
   if(!best||score>best.score)best={chord:PC[root]+suffix,score,confidence};
  }
  if(best&&best.score>=.65){
   const prev=segments[segments.length-1];
   if(prev&&prev.chord===best.chord&&Math.abs(prev.start+prev.duration-t)<.05)
    prev.duration+=windowSeconds;
   else segments.push({start:t,duration:windowSeconds,chord:best.chord,
    confidence:Number(best.confidence.toFixed(2))});
  }
 }
 return segments;
}
export function transposeNotes(notes,semitones=0){
 const shift=Math.round(Number(semitones)||0);
 if(Math.abs(shift)>36)throw Error('Trasposizione massima ±36 semitoni');
 return (notes||[]).map(n=>({...n,pitch:clamp(n.pitch+shift,0,127)}));
}
export function makeChordPro(chords,{title='AmpySongScriber',bpm=120}={}){
 const clean=String(title).replace(/[{}\n\r]/g,' ').slice(0,120);
 const rows=['{title: '+clean+'}','{tempo: '+Math.round(bpm)+'}','{comment: Accordi STIMATI da note; verificare a orecchio}'];
 for(const c of chords)rows.push('['+c.chord+'] @ '+c.start.toFixed(1)+'s (conf '+c.confidence+')');
 return rows.join('\n')+'\n';
}
