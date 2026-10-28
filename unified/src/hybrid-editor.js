/**
 * Rev15 NoteLab: correct actual note events (MIDI + MusicXML/PDF) on device.
 * Original lightweight editor inspired by read-only spectrogram/piano-roll
 * workflows; no external editor binaries or proprietary code.
 */
export function noteName(midi){
 const names=['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
 return names[midi%12]+(Math.floor(midi/12)-1);
}
export function validateEditedNotes(notes){
 if(!Array.isArray(notes)||notes.length>12000)throw Error('Troppe note per l editor');
 const out=[];
 for(const [i,n] of notes.entries()){
  const pitch=Math.round(Number(n.pitch));
  const start=Number(n.start),duration=Number(n.duration);
  if(!Number.isInteger(pitch)||pitch<0||pitch>127
   ||!Number.isFinite(start)||start<0||start>3600
   ||!Number.isFinite(duration)||duration<.02||duration>60)
    throw Error('Nota '+(i+1)+' non valida: pitch 0–127, inizio 0–3600 s, durata 0.02–60 s.');
  out.push({...n,pitch,start:Number(start.toFixed(4)),duration:Number(duration.toFixed(4)),
   velocity:Math.min(1,Math.max(.12,Number(n.velocity)||.7))});
 }
 return out.sort((a,b)=>a.start-b.start||a.pitch-b.pitch);
}
export function initHybridNoteEditor({getNotes,onApply}){
 const host=document.getElementById('hybridEditor');
 const panel=document.getElementById('hybridEditorPanel');
 const open=document.getElementById('hybridEditOpen');
 const summary=document.getElementById('hybridEditorSummary');
 const save=document.getElementById('hybridEditSave');
 const add=document.getElementById('hybridEditAdd');
 const prev=document.getElementById('hybridEditPrev');
 const next=document.getElementById('hybridEditNext');
 const cancel=document.getElementById('hybridEditCancel');
 const pageSize=25;
 let staged=[],page=0,enabled=false,previous=null;
 function show(){
  const total=Math.max(1,Math.ceil(staged.length/pageSize));
  page=Math.max(0,Math.min(total-1,page));
  prev.disabled=page===0;next.disabled=page>=total-1;
  host.replaceChildren();
  const table=document.createElement('table');
  table.style.width='100%';table.style.fontSize='12px';
  const head=document.createElement('thead'),tr=document.createElement('tr');
  for(const label of ['Nota','MIDI','Inizio (s)','Durata (s)','Conf.','']) {
   const th=document.createElement('th');th.textContent=label;tr.appendChild(th);
  }
  head.appendChild(tr);table.appendChild(head);
  const body=document.createElement('tbody');
  staged.slice(page*pageSize,(page+1)*pageSize).forEach((n,i)=>{
   const index=page*pageSize+i;
   const row=document.createElement('tr');
   const label=document.createElement('td');label.textContent=noteName(n.pitch);
   row.appendChild(label);
   for(const [key,step] of [['pitch','1'],['start','0.01'],['duration','0.01']]){
    const td=document.createElement('td'),input=document.createElement('input');
    input.type='number';input.step=step;input.value=String(n[key]);
    input.style.cssText='width:72px;max-width:95%;padding:5px';
    input.setAttribute('aria-label',key+' nota '+(index+1));
    input.addEventListener('change',()=>{n[key]=Number(input.value);if(key==='pitch')label.textContent=noteName(n.pitch);});
    td.appendChild(input);row.appendChild(td);
   }
   const conf=document.createElement('td');conf.textContent=Number(n.confidence||0).toFixed(2);
   row.appendChild(conf);
   const del=document.createElement('td'),delBtn=document.createElement('button');
   delBtn.className='secondary';delBtn.textContent='×';delBtn.title='Elimina nota '+(index+1);
   delBtn.addEventListener('click',()=>{staged.splice(index,1);show();});
   del.appendChild(delBtn);row.appendChild(del);
   body.appendChild(row);
  });
  table.appendChild(body);host.appendChild(table);
  summary.textContent=staged.length+' note · pagina '+(page+1)+'/'+total+
   '. Le modifiche restano locali fino a Applica.';
 }
 function load(){
  const notes=getNotes()||[];
  staged=notes.map(n=>({...n}));page=0;
  open.disabled=notes.length===0;show();
 }
 open.addEventListener('click',()=>{
  if(open.disabled)return;
  load();panel.hidden=!panel.hidden;
  if(!panel.hidden)panel.scrollIntoView?.({block:'nearest'});
 });
 prev.addEventListener('click',()=>{page--;show();});
 next.addEventListener('click',()=>{page++;show();});
 add.addEventListener('click',()=>{
  const ref=staged[Math.min(staged.length-1,page*pageSize+pageSize-1)];
  staged.push({pitch:ref?.pitch||60,start:ref?Number((ref.start+ref.duration).toFixed(2)):0,
    duration:.25,velocity:.7,confidence:.5,source:'manual'});
  page=Math.ceil(staged.length/pageSize)-1;show();
 });
 cancel.addEventListener('click',()=>{panel.hidden=true;load();});
 save.addEventListener('click',async()=>{
  try{
   const notes=validateEditedNotes(staged);
   if(!notes.length)throw Error('Almeno una nota necessaria.');
   save.disabled=true;
   await onApply(notes);
   load();
   summary.textContent='✓ Note applicate a MIDI, MusicXML e PDF. '+notes.length+' note.';
  }catch(e){summary.textContent='Errore: '+String(e?.message||e);}
  finally{save.disabled=false;}
 });
 return {load,setEnabled:flag=>{enabled=Boolean(flag);open.disabled=!enabled;}};
}
