/**
 * Offline source-cleaning DSP. FFT spectral suppression + band filtering.
 * GGUFs select only bounded parameters; they never manipulate PCM samples.
 * Aims to improve Basic Pitch input, not remove overlapping instruments perfectly.
 * FFT.js (Fedor Indutny, MIT).
 */
import FFT from 'fft.js';

const SR=22050,N=2048,HOP=512, HALF=N>>1;
const fft=new FFT(N);
const window=new Float32Array(N);
for(let i=0;i<N;i++)window[i]=0.5-0.5*Math.cos(2*Math.PI*i/(N-1));

function quantile(arr,q){
 arr.sort((a,b)=>a-b);
 return arr[Math.min(arr.length-1,Math.max(0,Math.floor((arr.length-1)*q)))];
}

export function cleanSamples(samples,opts){
 const len=samples.length, strength=Math.min(.85,Math.max(0,Number(opts.strength)||0));
 const lowcut=Math.min(250,Math.max(0,Number(opts.lowcut)||0));
 const highcut=Math.min(10500,Math.max(1800,Number(opts.highcut)||10500));
 const pad=HALF;
 const padded=new Float32Array(len+2*pad+N);
 padded.set(samples,pad);
 const output=new Float32Array(padded.length);
 const normalization=new Float32Array(padded.length);
 const frame=new Float32Array(N);
 const spec=fft.createComplexArray(),inv=fft.createComplexArray();
 // Use the lowest-magnitude 20% among evenly distributed windows as a
 // conservative noise estimate. For dense music this is only an estimate.
 const sampleCount=Math.min(50,Math.max(1,Math.floor(len/HOP)));
 const estimates=Array.from({length:HALF+1},()=>[]);
 for(let m=0;m<sampleCount;m++){
  const pos=Math.max(0,Math.min(padded.length-N,Math.floor(m*(len/(sampleCount||1))/HOP)*HOP));
  for(let i=0;i<N;i++)frame[i]=padded[pos+i]*window[i];
  fft.realTransform(spec,frame);
  for(let k=0;k<=HALF;k++){
   estimates[k].push(Math.hypot(spec[2*k],spec[2*k+1]));
  }
 }
 const floor=new Float32Array(HALF+1);
 for(let k=0;k<=HALF;k++)floor[k]=quantile(estimates[k],.2);
 const total=Math.ceil((padded.length-N)/HOP)+1;
 const pre=new Float32Array(HALF+1);
 for(let k=0;k<=HALF;k++){
  const freq=k*SR/N;
  const highPass=lowcut>0 ? freq/Math.sqrt(freq*freq+lowcut*lowcut) : 1;
  const lowPass=1/Math.sqrt(1+Math.pow(freq/highcut,8));
  pre[k]=highPass*lowPass;
 }
 for(let t=0;t<total;t++){
  const off=t*HOP;
  frame.fill(0);
  for(let i=0;i<N;i++)frame[i]=(padded[off+i]||0)*window[i];
  fft.realTransform(spec,frame);
  for(let k=0;k<=HALF;k++){
   const re=spec[2*k],im=spec[2*k+1];
   const magnitude=Math.hypot(re,im);
   const relative=Math.min(1,(floor[k]*1.5)/(magnitude+1e-7));
   const mask=pre[k]*(1-strength*relative);
   spec[2*k]=re*mask;spec[2*k+1]=im*mask;
  }
  fft.completeSpectrum(spec);
  fft.inverseTransform(inv,spec);
  for(let i=0;i<N&&off+i<padded.length;i++){
   const w=window[i];
   output[off+i]+=inv[2*i]*w;
   normalization[off+i]+=w*w;
  }
  if(t%32===0){
   if(typeof self!=='undefined')self.postMessage({type:'progress',percent:Math.round(t/total*100)});
  }
 }
 const clean=new Float32Array(len);
 for(let i=0;i<len;i++){
  const pos=i+pad;
  clean[i]=Math.max(-1,Math.min(1,output[pos]/Math.max(normalization[pos],.00001)));
 }
 return clean;
}
if(typeof self!=='undefined')self.onmessage=e=>{
 if(e.data?.type!=='clean')return;
 try{
  const output=cleanSamples(e.data.samples,e.data.params||{});
  self.postMessage({type:'done',samples:output},[output.buffer]);
 }catch(err){self.postMessage({type:'error',message:String(err?.message||err)});}
};
