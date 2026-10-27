/** Uncompressed canonical RIFF/WAVE PCM S16LE, readable on Android/Windows/macOS/Linux.
 * No MP3 codec or custom headers; channel order is interleaved.
 * Encodes a stereo/mono AudioBuffer from source separation and returns a Blob.
 */
export function encodeWav(buffer) {
 if(!buffer || !Number.isInteger(buffer.length) || buffer.length<1)throw Error('Audio vuoto');
 const frames=buffer.length,channels=buffer.numberOfChannels,rate=buffer.sampleRate;
 if(channels<1||channels>2||!Number.isInteger(rate)||rate<8000||rate>192000)
   throw Error('Formato WAV non supportato: '+channels+' canali, '+rate+' Hz');
 const dataBytes=frames*channels*2;
 if(!Number.isSafeInteger(dataBytes)||dataBytes>0xffffff00)
   throw Error('Traccia troppo lunga per il formato WAV classico');
 const raw=new ArrayBuffer(44+dataBytes),dv=new DataView(raw);
 const ascii=(pos,s)=>{for(let i=0;i<s.length;i++)dv.setUint8(pos+i,s.charCodeAt(i))};
 ascii(0,'RIFF');dv.setUint32(4,36+dataBytes,true);
 ascii(8,'WAVE');ascii(12,'fmt ');
 dv.setUint32(16,16,true);dv.setUint16(20,1,true);
 dv.setUint16(22,channels,true);dv.setUint32(24,rate,true);
 dv.setUint32(28,rate*channels*2,true);dv.setUint16(32,channels*2,true);
 dv.setUint16(34,16,true);ascii(36,'data');dv.setUint32(40,dataBytes,true);
 const samples=Array.from({length:channels},(_,i)=>buffer.getChannelData(i));
 let off=44;
 for(let i=0;i<frames;i++){
  for(let c=0;c<channels;c++){
   const val=samples[c][i];
   const x=Number.isFinite(val)?Math.max(-1,Math.min(1,val)):0;
   dv.setInt16(off,Math.round(x<0?x*32768:x*32767),true);
   off+=2;
  }
 }
 return new Blob([raw],{type:'audio/wav'});
}
export async function validateWav(blob){
 if(!blob || blob.size<44)throw Error('WAV troppo corto');
 const b=new DataView(await blob.slice(0,44).arrayBuffer());
 const str=(i,n)=>Array.from({length:n},(_,j)=>String.fromCharCode(b.getUint8(i+j))).join('');
 if(str(0,4)!=='RIFF'||str(8,4)!=='WAVE'||str(12,4)!=='fmt '||str(36,4)!=='data')
   throw Error('Intestazione WAV danneggiata');
 if(b.getUint16(20,true)!==1||b.getUint16(34,true)!==16)
   throw Error('Il WAV non è PCM 16 bit');
 const size=b.getUint32(4,true)+8, data=b.getUint32(40,true);
 if(size!==blob.size||data+44!==blob.size)throw Error('WAV incompleto: dimensione RIFF errata');
 return {sampleRate:b.getUint32(24,true),channels:b.getUint16(22,true),bytes:blob.size};
}
