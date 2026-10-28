import assert from 'node:assert/strict';
import {
 computeSpectralFrames,spectralNotesFromFrames,runHybridEngine,
 fusePitchEvidence,estimateChordTimeline,makeChordPro,transposeNotes
} from '../src/hybrid-core.js';
const SR=22050;
function sine(length,notes){
 const data=new Float32Array(Math.floor(length*SR));
 for(let i=0;i<data.length;i++){
  const t=i/SR;
  for(const [pitch,gain] of notes){
   const freq=440*2**((pitch-69)/12);
   data[i]+=gain*Math.sin(2*Math.PI*t*freq);
  }
 }
 return data;
}
const melody=sine(2.5,[[45,.30]]);
const frames=computeSpectralFrames(melody,{stem:'bass',sampleRate:SR,maxSeconds:2.5});
const pitches=frames.flatMap(f=>f.pitches.map(p=>p.pitch));
const correct=pitches.filter(p=>p===45).length;
assert.ok(correct/Math.max(1,pitches.length)>.60,'A2 bass pitch must be detected in FFT spectral frames');
const spectral=spectralNotesFromFrames(frames,{stem:'bass',duration:2.5});
assert.ok(spectral.some(n=>n.pitch===45&&n.duration>1.1),'A2 spectral note must persist >1s');
const buffer={length:melody.length,duration:2.5,sampleRate:SR,numberOfChannels:1,getChannelData:()=>melody};
const neural=[{pitch:45,start:.1,duration:2.1,velocity:.85,confidence:.88}];
const hybrid=runHybridEngine(buffer,neural,{stem:'bass',mode:'balanced'});
assert.ok(hybrid.notes.some(n=>n.pitch===45));
assert.equal(hybrid.metrics.neuralCount,1);
assert.ok(hybrid.metrics.spectralCount>=1);
const onlyNeural=runHybridEngine(buffer,neural,{stem:'bass',mode:'neural'});
assert.equal(onlyNeural.metrics.spectralFrames,0);
const onlySpectral=runHybridEngine(buffer,[],{stem:'bass',mode:'spectral'});
assert.ok(onlySpectral.notes.length>=1);
assert.throws(()=>fusePitchEvidence([],[],{mode:'impossible'}),/sconosciuta/);
const chords=[
 {pitch:60,start:0,duration:2,confidence:.9},
 {pitch:64,start:0,duration:2,confidence:.9},
 {pitch:67,start:0,duration:2,confidence:.9},
 {pitch:57,start:2,duration:2,confidence:.9},
 {pitch:60,start:2,duration:2,confidence:.9},
 {pitch:64,start:2,duration:2,confidence:.9}
];
const timeline=estimateChordTimeline(chords,{windowSeconds:2,duration:4});
assert.ok(timeline.length>=2);
assert.equal(timeline[0].chord,'Cmaj');
assert.equal(timeline[1].chord,'Am');
assert.ok(makeChordPro(timeline,{title:'Test'}).includes('[Cmaj]'));
const shifted=transposeNotes(neural,9);
assert.equal(shifted[0].pitch,54);
assert.equal(neural[0].pitch,45,'Must not mutate source pitches');
console.log('PASS HybridCore: spectral A2, independent FFT and neural modes, fusion, C-Am harmony and Eb transpose');
