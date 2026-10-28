import assert from 'node:assert/strict';
import {cleanSamples} from '../src/audio-cleaner-worker.js';
import {bounds,extractJSON,measureAudio} from '../src/dual-gguf.js';
const frames=22050;
const wave=new Float32Array(frames);
for(let i=0;i<frames;i++){
 const tone=Math.sin(2*Math.PI*220*i/22050)*.32;
 const noise=Math.sin(2*Math.PI*4100*i/22050)*.06;
 wave[i]=tone+noise;
}
const before=Math.sqrt(wave.reduce((a,x)=>a+x*x,0)/wave.length);
const clean=cleanSamples(wave,{strength:.2,lowcut:30,highcut:3000});
assert.equal(clean.length,wave.length);
assert.ok(clean.every(Number.isFinite),'cleaned audio must have finite samples');
const after=Math.sqrt(clean.reduce((a,x)=>a+x*x,0)/clean.length);
assert.ok(after>.05&&after<before*1.08,'audio must stay non-silent and bounded');
const opts=bounds({strength:900,lowcut:-100,highcut:999999},'bass');
assert.ok(opts.strength<=.7&&opts.lowcut>=30&&opts.highcut<=6500);
const report=extractJSON('The JSON: {"strength":0.3,"lowcut":55,"highcut":4300}');
assert.equal(report.strength,.3);
const features=measureAudio({duration:1,sampleRate:22050,getChannelData:()=>wave});
assert.ok(features.rmsDb>-20&&features.peakDb<0);
console.log('PASS: FFT cleaner finite audio, bounded parameters, JSON parsing, signal features');
