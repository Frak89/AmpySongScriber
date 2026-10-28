/**
 * Rev14 audio quality: prevent header-valid but inaudible WAV exports.
 * Numeric RMS/peak checks before and after isolation, downmix and FFT.
 * Silence can be genuine (breaks in arrangement); never fabricate a stem.
 */
export function signalStats(samples){
 if(!samples||!samples.length)return {samples:0,rms:0,peak:0,db:-140};
 let energy=0,peak=0,finite=0;
 // sample in fixed strides to avoid megabytes of work on UI thread
 const step=Math.max(1,Math.floor(samples.length/24000));
 for(let i=0;i<samples.length;i+=step){
  const x=Number(samples[i]);
  if(!Number.isFinite(x))continue;
  peak=Math.max(peak,Math.abs(x));energy+=x*x;finite++;
 }
 const rms=Math.sqrt(energy/Math.max(1,finite));
 return {samples:samples.length,rms,peak,db:20*Math.log10(Math.max(rms,1e-8))};
}
export function audioStats(buffer){
 if(!buffer||!buffer.numberOfChannels||!buffer.length)throw Error('Audio non valido');
 const perChannel=Array.from({length:buffer.numberOfChannels},(_,i)=>signalStats(buffer.getChannelData(i)));
 return {length:buffer.length,rate:buffer.sampleRate,
  peak:Math.max(...perChannel.map(x=>x.peak)),
  rms:Math.sqrt(perChannel.reduce((n,x)=>n+x.rms*x.rms,0)/perChannel.length),
  channels:perChannel};
}
export function downmixChannels(left,right){
 if(!left||!right||left.length!==right.length)throw Error('Canali stereo non validi');
 const n=left.length,sum=new Float32Array(n);
 let a=0,b=0,mixed=0;
 const stride=Math.max(1,Math.floor(n/12000));
 for(let i=0;i<n;i+=stride){
  const l=left[i],r=right[i],s=(l+r)*.5;
  a+=l*l;b+=r*r;mixed+=s*s;
 }
 const source=Math.max(a,b);
 // Avoid annihilating anti-phase instrument stems during standard stereo→mono.
 // If L+R loses >=85% RMS while one channel remains usable, choose loudest.
 const cancellation=source>0&&mixed/source<.0225;
 if(cancellation){
  const chosen=a>=b?left:right;
  sum.set(chosen);
 }else{
  for(let i=0;i<n;i++)sum[i]=(left[i]+right[i])*.5;
 }
 return {samples:sum,cancellation,selected:cancellation?(a>=b?'left':'right'):'mix'};
}
export function preserveAudibility(original,processed,{maxGain=2.5}={}){
 const before=signalStats(original),after=signalStats(processed);
 if(before.rms<1e-6)return {samples:processed,bypassed:false,gain:1,before,after};
 if(after.rms<before.rms*.28||after.peak<1e-6){
  return {samples:original.slice(),bypassed:true,gain:1,before,after};
 }
 // Match reasonable loudness, but never amplify artifacts excessively.
 const gain=Math.max(.65,Math.min(maxGain,before.rms/Math.max(after.rms,1e-9)));
 if(Math.abs(gain-1)<.02)return {samples:processed,bypassed:false,gain:1,before,after};
 const out=new Float32Array(processed.length);
 for(let i=0;i<out.length;i++)out[i]=Math.max(-1,Math.min(1,processed[i]*gain));
 return {samples:out,bypassed:false,gain,before,after:signalStats(out)};
}
export function assertAudibleWav(samples,{minimumPeak=.00012,minimumRms=.000016,context='WAV'}={}){
 const stats=signalStats(samples);
 if(stats.peak<minimumPeak||stats.rms<minimumRms){
  throw Error(context+' quasi muto (RMS '+stats.db.toFixed(1)+' dBFS; picco '+stats.peak.toFixed(6)+').'
   +' Verificare isolamento, mono e DSP: non esportare un falso WAV valido.');
 }
 return stats;
}
export function completionState(actualFrames,expectedFrames){
 if(!Number.isSafeInteger(actualFrames)||!Number.isSafeInteger(expectedFrames)||expectedFrames<1||actualFrames<0)
  throw Error('Conteggio campioni non valido');
 const missing=Math.max(0,expectedFrames-actualFrames);
 return {complete:actualFrames===expectedFrames,missing,
  processedSeconds:actualFrames/22050,expectedSeconds:expectedFrames/22050,
  percent:Math.round(100*actualFrames/expectedFrames)};
}

/**
 * Peak normalization to make quiet but non-silent separated instruments audible.
 * Does not attempt to "repair" absent instruments: only boosts signals whose
 * existing peak is clearly above the digital noise floor.
 */
export function normalizeQuietStem(samples,{targetPeak=.28,maxGain=10,noiseFloorPeak=.00025}={}){
 const before=signalStats(samples);
 if(before.peak<noiseFloorPeak){
  return {samples,boosted:false,gain:1,inaudible:true,before,after:before};
 }
 const gain=before.peak<targetPeak?Math.min(maxGain,targetPeak/before.peak):1;
 if(gain<=1.025)return {samples,boosted:false,gain:1,inaudible:false,before,after:before};
 const output=new Float32Array(samples.length);
 for(let i=0;i<samples.length;i++)output[i]=Math.max(-1,Math.min(1,samples[i]*gain));
 return {samples:output,boosted:true,gain,inaudible:false,before,after:signalStats(output)};
}
