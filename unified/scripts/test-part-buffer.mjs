import assert from 'node:assert/strict';
import {encodeWav,validateWav} from '../src/wav.js';
import {mergedWaveBytes} from '../src/part-buffer.js';
const makePart=(length,freq)=>{
 const a=new Float32Array(length);
 for(let i=0;i<length;i++)a[i]=Math.sin(2*Math.PI*freq*i/22050)*.25;
 return {length,sampleRate:22050,numberOfChannels:1,getChannelData:()=>a};
};
const one=new Uint8Array(await encodeWav(makePart(22050,220)).arrayBuffer());
const two=new Uint8Array(await encodeWav(makePart(11025,440)).arrayBuffer());
const merged=mergedWaveBytes([one,two]);
const blob=new Blob([merged],{type:'audio/wav'});
const info=await validateWav(blob);
assert.deepEqual(info,{sampleRate:22050,channels:1,bytes:44+(22050+11025)*2});
assert.deepEqual(merged.subarray(44,44+22050*2),one.subarray(44));
assert.deepEqual(merged.subarray(44+22050*2),two.subarray(44));
assert.equal(new DataView(merged.buffer).getUint32(40,true),(22050+11025)*2);
console.log('PASS: part001 + part002 join into a standard mono PCM16 WAV with exact frame boundaries');
