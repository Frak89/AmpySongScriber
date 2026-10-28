/**
 * AmpySongScriber Rev7: specialized six-source neural separator.
 * MIT-licensed HTDemucs-6s ONNX model (StemSplitio / Meta).
 * Input  [1,2,343980] 44.1 kHz stereo.
 * Output [1,6,2,343980], ordered drums,bass,other,vocals,guitar,piano.
 *
 * Only the chosen source is accumulated in memory. No fake "piano" labeling
 * of a mixed residual. Full-song chunks use normalized overlap/add.
 */
import * as ort from 'onnxruntime-web';

export const STEM_KEYS=['drums','bass','other','vocals','guitar','piano'];
export const STEM_LABELS={
 drums:'🥁 Batteria',bass:'🎸 Basso',other:'🎻 Strumenti non ancora isolati',
 vocals:'🎙️ Voce',guitar:'🎸 Chitarra',piano:'🎹 Pianoforte'
};
const RATE=44100, CHUNK=343980, OVERLAP=Math.floor(CHUNK*.25), STEP=CHUNK-OVERLAP;
ort.env.wasm.wasmPaths='/ort/';
ort.env.wasm.numThreads=1;
ort.env.wasm.proxy=false;
ort.env.logLevel='warning';

export async function loadDemucs6(onProgress){
 onProgress?.({stage:'loading',percent:10});
 const model='/models/htdemucs_6s_fp16weights.onnx';
 let session;
 try{
  session=await ort.InferenceSession.create(model,{
   executionProviders:['wasm'],graphOptimizationLevel:'basic'
  });
 }catch(e){
  const detail=e instanceof Error?(e.stack||e.message):(typeof e==='string'?e:
   e===undefined?'ONNX Runtime ha rifiutato la sessione senza un messaggio':
   (()=>{try{return JSON.stringify(e)}catch{return String(e)}})());
  throw new Error('HTDemucs 6s ONNX/WASM: '+detail+
   '. Il modello potrebbe superare la memoria WebView, avere operatori non supportati o un errore WASM.');
 }
 if(session.inputNames.length!==1||session.outputNames.length!==1)
  throw Error('Modello ONNX 6s non compatibile: input/output non riconosciuti.');
 onProgress?.({stage:'ready',percent:100});
 return session;
}
export async function isolateStem(session,audio,stem,onProgress){
 const index=STEM_KEYS.indexOf(stem);
 if(index<0)throw Error('Strumento non supportato: '+stem);
 if(audio.sampleRate&&audio.sampleRate!==RATE)throw Error('È richiesto audio a 44.100 Hz');
 if(audio.numberOfChannels!==2)throw Error('È richiesto audio stereo');
 const length=audio.length;
 const channels=[audio.getChannelData(0),audio.getChannelData(1)];
 const out=[new Float32Array(length),new Float32Array(length)];
 const weights=new Float32Array(length);
 const total=Math.max(1,Math.ceil(length/STEP));
 const input=new Float32Array(2*CHUNK);
 const fade=new Float32Array(CHUNK);
 for(let i=0;i<CHUNK;i++){
  fade[i]=i<OVERLAP?i/OVERLAP:i>=CHUNK-OVERLAP?(CHUNK-i)/OVERLAP:1;
 }
 for(let chunk=0;chunk<total;chunk++){
  const offset=chunk*STEP;
  const valid=Math.max(0,Math.min(CHUNK,length-offset));
  if(valid<=0)break;
  input.fill(0);
  for(let ch=0;ch<2;ch++){
   input.set(channels[ch].subarray(offset,offset+valid),ch*CHUNK);
  }
  const feeds={[session.inputNames[0]]:new ort.Tensor('float32',input,[1,2,CHUNK])};
  const outputs=await session.run(feeds);
  const result=outputs[session.outputNames[0]];
  if(!result||result.dims.length!==4||result.dims[1]!==6||result.dims[2]!==2||result.dims[3]!==CHUNK)
   throw Error('Forma modello non valida: richiesti 6 strumenti.');
  const arr=result.data;
  for(let k=0;k<valid;k++){
   const dest=offset+k;
   let w=fade[k];
   if(chunk===0&&k<OVERLAP)w=1;
   if(chunk===total-1&&k>=CHUNK-OVERLAP)w=1;
   weights[dest]+=w;
   out[0][dest]+=arr[(index*2)*CHUNK+k]*w;
   out[1][dest]+=arr[(index*2+1)*CHUNK+k]*w;
  }
  for(const t of Object.values(outputs)){if(typeof t.dispose==='function')t.dispose();}
  onProgress?.({chunk:chunk+1,total,percent:Math.round(100*(chunk+1)/total),instrument:stem});
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 for(let i=0;i<length;i++)if(weights[i]>0){
  out[0][i]/=weights[i];out[1][i]/=weights[i];
 }
 return {stem,channels:out,sampleRate:RATE,length};
}
