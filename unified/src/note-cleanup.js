/**
 * Instrument-conditioned note cleanup of Basic Pitch's neural outputs.
 * The pitch class/range comes from the isolated HTDemucs source, not from
 * a text model. Conservative range filtering/duplicate merging reduces
 * octave artifacts and short transient detections; not a second pitch model.
 */
const PROFILES={
 bass:{min:28,max:72,minDuration:.085,name:'Basso E1–C5',program:33},
 guitar:{min:40,max:91,minDuration:.075,name:'Chitarra E2–G6',program:24},
 piano:{min:21,max:108,minDuration:.065,name:'Pianoforte A0–C8',program:0},
 vocals:{min:43,max:91,minDuration:.090,name:'Voce G2–G6',program:53},
 drums:{min:21,max:108,minDuration:.065,name:'Batteria (trascrizione melodica non affidabile)',program:0},
 other:{min:28,max:108,minDuration:.07,name:'Strumento non identificato',program:0},
 original:{min:21,max:108,minDuration:.07,name:'Brano misto',program:0}
};
export function profileFor(stem){return PROFILES[stem]||PROFILES.original;}
export function noteRange(stem){return profileFor(stem).name;}
export function refineInstrumentNotes(raw,stem){
 const profile=profileFor(stem);
 const preliminary=(raw||[]).map(n=>({
  pitch:Number(n.pitchMidi),
  start:Math.max(0,Number(n.startTimeSeconds)),
  duration:Number(n.durationSeconds),
  velocity:Math.min(1,Math.max(.12,Number(n.amplitude)||.7))
 })).filter(n=>Number.isFinite(n.pitch)&&Number.isFinite(n.start)&&Number.isFinite(n.duration)&&
  n.pitch>=profile.min&&n.pitch<=profile.max&&n.duration>=profile.minDuration
 ).sort((a,b)=>a.start-b.start||a.pitch-b.pitch);
 const result=[];
 const recent=new Map();
 for(const note of preliminary){
  const prev=recent.get(note.pitch);
  const near=prev&&note.start<=prev.start+prev.duration+.065;
  if(near){
   const end=Math.max(prev.start+prev.duration,note.start+note.duration);
   prev.duration=end-prev.start;
   prev.velocity=Math.max(prev.velocity,note.velocity);
  }else{
   result.push(note);recent.set(note.pitch,note);
  }
 }
 return result;
}
