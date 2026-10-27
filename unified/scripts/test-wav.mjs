import assert from 'node:assert/strict';
import {encodeWav,validateWav} from '../src/wav.js';
const mock={
 length:44100,sampleRate:44100,numberOfChannels:2,
 getChannelData(channel) {
  const x=new Float32Array(44100);
  for(let i=0;i<x.length;i++)x[i]=Math.sin(2*Math.PI*(channel===0?440:660)*i/44100)*.5;
  return x;
 }
};
const wav=encodeWav(mock);
assert.equal(wav.size,44+44100*2*2);
assert.deepEqual(await validateWav(wav),{sampleRate:44100,channels:2,bytes:wav.size});
const bytes=new Uint8Array(await wav.arrayBuffer());
assert.equal(String.fromCharCode(...bytes.subarray(0,4)),'RIFF');
assert.equal(String.fromCharCode(...bytes.subarray(8,12)),'WAVE');
console.log('PASS: stereo PCM16 WAV header and frame length validated');
