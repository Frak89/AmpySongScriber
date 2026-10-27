/** Musical timing -> MusicXML 4.0.
 *  Offline, no MuseScore binary. Preserve pitch/time/duration; emit 4/4 polyphony
 *  in independent voices, tied notes, barline-crossing notes and rests.
 *  Basic Pitch is approximate; musical interpretation requires human editing.
 */
const DIV=480, MEASURE=DIV*4;
const STEP=['C','C','D','D','E','F','F','G','G','A','A','B'];
const ALTER=[0,1,0,1,0,0,1,0,1,0,1,0];
const TYPES=[
 [1920,'whole',false],[1440,'half',true],[960,'half',false],
 [720,'quarter',true],[480,'quarter',false],[360,'eighth',true],
 [240,'eighth',false],[180,'16th',true],[120,'16th',false],
 [90,'32nd',true],[60,'32nd',false],[30,'64th',false]
];
export const xmlEscape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function quantize(v,step){return Math.round(v/step)*step;}
function durationPieces(duration){
 let remain=duration,out=[];
 for(const [ticks,type,dot] of TYPES){
  while(remain>=ticks){out.push({ticks,type,dot});remain-=ticks;}
 }
 if(remain)out.push({ticks:remain,type:'64th',dot:false});
 return out;
}
function noteXML(event,voice){
 const dur=event.length,type=event.type;
 const tags=event.pitch==null?'<rest/>':(()=>{
  const n=event.pitch,p=n%12;
  return '<pitch><step>'+STEP[p]+'</step>'+(ALTER[p]?'<alter>1</alter>':'')+'<octave>'+((n/12|0)-1)+'</octave></pitch>';
 })();
 const tie=event.pitch==null?'':(event.fromPrev?'<tie type="stop"/>':'')+(event.toNext?'<tie type="start"/>':'');
 const notations=event.pitch==null?'':(event.fromPrev||event.toNext?'<notations>'+(event.fromPrev?'<tied type="stop"/>':'')+(event.toNext?'<tied type="start"/>':'')+'</notations>':'');
 return '<note>'+tags+'<duration>'+dur+'</duration><voice>'+voice+'</voice><type>'+type+'</type>'+(event.dot?'<dot/>':'')+tie+notations+'</note>';
}
function restXML(dur,voice){return durationPieces(dur).map(p=>noteXML({...p,length:p.ticks,pitch:null},voice)).join('');}
export function createMusicXML(notes,{title='AmpySongScriber',instrument='Strumento',bpm=120,grid=120,bass=false}={}){
 bpm=Math.min(240,Math.max(40,Number(bpm)||120));
 grid=[60,120,240].includes(Number(grid))?Number(grid):120;
 const quantized=notes.map((n,i)=>{
  const st=Math.max(0,quantize((Number(n.start)||0)*bpm/60*DIV,grid));
  const length=Math.max(grid,quantize((Number(n.duration)||0)*bpm/60*DIV,grid));
  return {...n,i,tick:st,end:st+length};
 }).filter(n=>Number.isFinite(n.tick)&&Number.isFinite(n.end)&&Number.isInteger(n.pitch)&&n.pitch>=0&&n.pitch<=127)
 .sort((a,b)=>a.tick-b.tick||b.pitch-a.pitch);
 if(!quantized.length)throw Error('Nessuna nota valida rilevata');
 // Greedy voice allocation handles overlapping notes without discarding them.
 const voiceEnds=[],groups=[];
 for(const n of quantized){
  let v=voiceEnds.findIndex(end=>end<=n.tick);
  if(v<0){v=voiceEnds.length;voiceEnds.push(0);groups.push([]);}
  voiceEnds[v]=n.end;groups[v].push(n);
 }
 const maxEnd=Math.max(...voiceEnds);
 const measures=Math.max(1,Math.ceil(maxEnd/MEASURE));
 if(measures>800)throw Error('Spartito troppo lungo per la memoria disponibile');
 const byMeasure=Array.from({length:measures},()=>Array.from({length:groups.length},()=>[]));
 for(let voice=0;voice<groups.length;voice++){
  for(const n of groups[voice]){
   let cursor=n.tick,parts=[];
   while(cursor<n.end){
    const leftInMeasure=MEASURE-cursor%MEASURE;
    const remaining=Math.min(leftInMeasure,n.end-cursor);
    for(const len of durationPieces(remaining)){
     parts.push({tick:cursor, pitch:n.pitch,length:len.ticks,type:len.type,dot:len.dot});
     cursor+=len.ticks;
    }
   }
   for(let k=0;k<parts.length;k++){
    const p=parts[k];
    byMeasure[Math.floor(p.tick/MEASURE)][voice].push({
      ...p,offset:p.tick%MEASURE,fromPrev:k>0,toNext:k<parts.length-1
    });
   }
  }
 }
 const lines=[];
 for(let m=0;m<measures;m++){
  const events=byMeasure[m];
  let xml='<measure number="'+(m+1)+'">';
  if(m===0){
   xml+='<attributes><divisions>'+DIV+'</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>'+(bass?'F':'G')+'</sign><line>'+(bass?'4':'2')+'</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>'+Math.round(bpm)+'</per-minute></metronome></direction-type><sound tempo="'+Math.round(bpm)+'"/></direction>';
  }
  for(let voice=0;voice<groups.length;voice++){
   if(voice>0)xml+='<backup><duration>'+MEASURE+'</duration></backup>';
   let pos=0;
   for(const p of events[voice]){
    if(p.offset>pos){xml+=restXML(p.offset-pos,voice+1);pos=p.offset;}
    if(p.offset<pos)continue;
    xml+=noteXML(p,voice+1);
    pos+=p.length;
   }
   if(pos<MEASURE)xml+=restXML(MEASURE-pos,voice+1);
  }
  xml+='</measure>';lines.push(xml);
 }
 return '<?xml version="1.0" encoding="utf-8"?>\n'+
  '<score-partwise version="4.0">'+
  '<work><work-title>'+xmlEscape(title)+'</work-title></work>'+
  '<movement-title>'+xmlEscape(title)+'</movement-title>'+
  '<identification><creator type="software">AmpySongScriber</creator></identification>'+
  '<defaults><scaling><millimeters>7</millimeters><tenths>40</tenths></scaling></defaults>'+
  '<part-list><score-part id="P1"><part-name>'+xmlEscape(instrument)+'</part-name><part-abbreviation>Inst.</part-abbreviation><score-instrument id="I1"><instrument-name>'+xmlEscape(instrument)+'</instrument-name></score-instrument></score-part></part-list>'+
  '<part id="P1">'+lines.join('')+'</part></score-partwise>';
}
