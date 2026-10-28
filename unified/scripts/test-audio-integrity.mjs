import assert from 'node:assert/strict';
import {
 signalStats,downmixChannels,preserveAudibility,assertAudibleWav,completionState,normalizeQuietStem
} from '../src/audio-quality.js';
import {reconcileInstrumentNotes} from '../src/note-cleanup.js';
const len=22050;
const sine=new Float32Array(len);
for(let i=0;i<len;i++)sine[i]=.24*Math.sin(2*Math.PI*110*i/22050);
const inverted=Float32Array.from(sine,x=>-x);
const mono=downmixChannels(sine,inverted);
assert.equal(mono.cancellation,true,'Anti-phase stereo must be recognized');
assert.ok(signalStats(mono.samples).rms>.15,'Downmix should not accidentally mute the signal');
const normal=downmixChannels(sine,sine);
assert.equal(normal.cancellation,false);
assert.ok(signalStats(normal.samples).rms>.15);
const muted=new Float32Array(len);
const protectedAudio=preserveAudibility(sine,muted);
assert.equal(protectedAudio.bypassed,true,'DSP must never replace musical signal with silence');
assert.ok(signalStats(protectedAudio.samples).peak>.20);
const quiet=Float32Array.from(sine,x=>x*.08);
const boosted=normalizeQuietStem(quiet);
assert.equal(boosted.boosted,true,'Quiet real stem must be made audible');
assert.ok(boosted.after.peak>.1);
const emptyNormalized=normalizeQuietStem(muted);
assert.equal(emptyNormalized.inaudible,true);
assert.equal(emptyNormalized.boosted,false);

assert.throws(()=>assertAudibleWav(muted),/quasi muto/);
assert.ok(assertAudibleWav(sine).rms>.1);
const partial=completionState(95*22050,325*22050);
assert.equal(partial.complete,false);
assert.equal(partial.processedSeconds,95);
assert.equal(partial.expectedSeconds,325);
assert.equal(partial.percent,29);
const final=completionState(325*22050,325*22050);
assert.equal(final.complete,true);
const notes=[
 {pitch:40,start:0,duration:.4,velocity:.75},
 {pitch:52,start:.01,duration:.42,velocity:.25},
 {pitch:40,start:.42,duration:.32,velocity:.7},
 {pitch:45,start:.78,duration:.3,velocity:.82},
 {pitch:42,start:1.15,duration:.02,velocity:.2}
];
const clean=reconcileInstrumentNotes(notes,'bass',{duration:3});
assert.equal(clean.length,2,'Bass should be monophonic, merge duplicate fragments and reject 20ms artifacts');
assert.deepEqual(clean.map(n=>n.pitch),[40,45]);
assert.ok(clean[0].duration>.65);
for(let i=1;i<clean.length;i++){
 assert.ok(clean[i].start>=clean[i-1].start+clean[i-1].duration-.026);
}
console.log('PASS Rev14: phase-safe downmix, no silent DSP, 95s/325s completeness, and cleaned solo bass MIDI');
