/**
 * AmpyQwen Rev6: local GGUF language assistant with verified autosave.
 * The GGUF remains in user's Android Download; only text analyses persist.
 */
import {saveAnalysis,listAnalyses,deleteAnalysis,analysisText} from './qwen-history.js';

let engine=null, modelFile=null, ready=false, pending=false, currentRecord=null;
const $=id=>document.getElementById(id);
const status=message=>{$('qwenStatus').textContent=message;};
const saveStatus=message=>{$('qwenSaveStatus').textContent=message;};
const SYS=[
 'Sei AmpyQwen, assistente musicale offline di AmpySongScriber.',
 'HTDemucs separa audio, YAMNet classifica strumenti, Basic Pitch stima note, MusicXML/PDF sono generati dal codice.',
 'Ricevi solo testo e dati delle note, NON ascolti i WAV direttamente.',
 'Rispondi in italiano con consigli concreti. Se i dati sono insufficienti, dillo.',
 'Non inventare note, strumenti, precisione o BPM; non usare cloud.'
].join(' ');
function toContext(data){
 const d=data||{};
 return JSON.stringify({
  brano:String(d.song||'').slice(0,100),
  durata_secondi:Number(d.durationSec||0),
  tempo_bpm:Number(d.tempo||120),
  traccia:String(d.track||'').slice(0,65),
  separazione_4_stems:!!d.hasStems,
  note_riconosciute:Number(d.noteCount||0),
  esempi_note:(d.notes||[]).slice(0,36).map(n=>({
   midi:Number(n.pitch),secondi:Number((n.start||0).toFixed(2)),durata:Number((n.duration||0).toFixed(2))
  })),
  strumenti_probabili:(d.instrumentPredictions||[]).slice(0,5).map(i=>({
   nome:String(i.name).slice(0,40),affinita:Math.round((Number(i.score)||0)*100)
  }))
 });
}
function formatDate(iso){
 try{return new Date(iso).toLocaleString('it-IT');}catch{return String(iso);}
}
async function pdfForRecord(record){
 const {jsPDF}=await import('jspdf');
 const pdf=new jsPDF({unit:'mm',format:'a4',compress:true});
 const body=analysisText(record)
    .replace(/[\u{1F300}-\u{1FAFF}]/gu,'')
    .replaceAll('–','-').replaceAll('—','-').replaceAll('’',"'")
    .split('\n');
 const W=210,H=297,left=16,right=16,top=21,bottom=18;
 let y=top;
 pdf.setProperties({title:'AmpyQwen - '+record.song,author:'AmpySongScriber',subject:'Analisi musicale locale'});
 const newPage=()=>{
  pdf.addPage('a4','portrait');
  y=top;
 };
 for(let i=0;i<body.length;i++){
  const line=body[i];
  const heading=['DOMANDA','RISPOSTA'].includes(line)||i===0;
  pdf.setFont('helvetica',heading?'bold':'normal');
  pdf.setFontSize(i===0?15:heading?12:10);
  pdf.setTextColor(heading?25:50);
  const maxW=W-left-right;
  const parts=pdf.splitTextToSize(line||' ',maxW);
  const lineH=i===0?7:heading?6.2:5.3;
  for(const str of parts){
   if(y+lineH>H-bottom)newPage();
   pdf.text(str,left,y);
   y+=lineH;
  }
  if(heading)y+=3;
 }
 const pages=pdf.getNumberOfPages();
 for(let p=1;p<=pages;p++){
  pdf.setPage(p);
  pdf.setDrawColor(215);pdf.line(left,H-14,W-right,H-14);
  pdf.setFont('helvetica','normal');pdf.setFontSize(8);pdf.setTextColor(115);
  pdf.text('AmpySongScriber - analisi offline',left,H-9);
  pdf.text(p+' / '+pages,W-right,H-9,{align:'right'});
 }
 return pdf.output('blob');
}
export function initQwen(getContext,exportFile){
 const input=$('qwenFile'),load=$('qwenLoad'),unload=$('qwenUnload');
 const ask=$('qwenAsk'),prompt=$('qwenPrompt'),out=$('qwenOutput');
 const save=$('qwenSave'),txt=$('qwenTxt'),pdf=$('qwenPdf');
 const backup=$('qwenBackup'),history=$('qwenHistory');
 const refresh=$('qwenRefresh');
 const setCurrent=record=>{
  currentRecord=record;
  out.textContent=record?.answer||'';
  prompt.value=record?.question||prompt.value;
  for(const button of [save,txt,pdf])button.disabled=!record?.answer;
 };
 async function refreshHistory(){
  history.textContent='Lettura cronologia locale…';
  try{
   const items=await listAnalyses();
   history.replaceChildren();
   if(!items.length){history.textContent='Nessuna analisi salvata. La prossima risposta completa verrà registrata automaticamente.';return;}
   const info=document.createElement('p');
   info.textContent=items.length+' analisi registrate nel telefono. Tocca Apri per leggerle o esportarle.';
   history.append(info);
   for(const entry of items){
    const row=document.createElement('div');
    row.style.cssText='padding:12px 0;border-top:1px solid #425475;display:grid;gap:8px';
    const label=document.createElement('span');
    const state=entry.status==='pending'?' (interrotta)':entry.status==='error'?' (errore)':'';
    label.textContent=formatDate(entry.createdAt)+' · '+(entry.song||'Analisi')+state;
    const description=document.createElement('small');
    description.textContent=entry.question.slice(0,110);
    const actions=document.createElement('div');actions.className='actions';
    const open=document.createElement('button');open.className='secondary';open.textContent='Apri';
    open.onclick=()=>{setCurrent(entry);saveStatus('Analisi del '+formatDate(entry.createdAt)+' ripristinata dall’archivio.');};
    const remove=document.createElement('button');remove.className='secondary';remove.textContent='Elimina';
    remove.onclick=async()=>{
     if(!window.confirm('Eliminare questa analisi salvata?'))return;
     try{await deleteAnalysis(entry);if(currentRecord?.id===entry.id)setCurrent(null);await refreshHistory();}
     catch(e){saveStatus('Eliminazione fallita: '+e.message);}
    };
    actions.append(open,remove);row.append(label,description,actions);history.append(row);
   }
  }catch(e){history.textContent='Archivio non leggibile: '+e.message;}
 }
 refresh.addEventListener('click',refreshHistory);
 input.addEventListener('change',()=>{
  const f=input.files?.[0];if(!f)return;
  if(!/\.gguf$/i.test(f.name)||f.size<100*1048576||f.size>1500*1048576){
   modelFile=null;load.disabled=true;
   status('Seleziona Qwen3-0.6B-Q4_K_M.gguf (~484 MB) da Download.');return;
  }
  modelFile=f;load.disabled=false;
  try{localStorage.setItem('ampy_qwen_last_model_name',f.name);}catch{}
  status('Selezionato '+f.name+' ('+(f.size/1048576).toFixed(0)+' MiB). Premi Avvia Qwen.');
 });
 load.addEventListener('click',async()=>{
  if(!modelFile||pending)return;pending=true;load.disabled=true;ask.disabled=true;
  status('Caricamento GGUF locale. Può richiedere molta RAM nel WebView...');
  try{
   if(engine){await engine.exit();engine=null;ready=false;}
   const {Wllama}=await import('@wllama/wllama/esm/index.js');
   engine=new Wllama({default:'./wllama/wllama.wasm'},{allowOffline:true});
   await engine.loadModel([modelFile],{n_ctx:1536,n_batch:128,n_threads:1,n_gpu_layers:0});
   ready=true;ask.disabled=false;
   status('Qwen caricato offline. Ora posso analizzare le note riconosciute.');
  }catch(e){
   ready=false;try{await engine?.exit();}catch{}
   engine=null;
   status('Impossibile caricare Qwen: '+String(e?.message||e)+'. Le altre funzioni restano disponibili.');
  }finally{pending=false;load.disabled=false;}
 });
 async function unloadModel(){
  if(pending)return;
  try{
   if(engine)await engine.exit();
   engine=null;ready=false;ask.disabled=true;
   status('Qwen liberato dalla RAM. Le analisi già salvate restano nella cronologia.');
  }catch(e){status('Errore liberando Qwen: '+e.message);}
 }
 unload.addEventListener('click',unloadModel);
 async function askQwen(question){
  if(!ready||!engine){status('Carica prima Qwen dalla cartella Download.');return;}
  if(pending)return;pending=true;ask.disabled=true;
  const data=getContext();
  let record={
   createdAt:new Date().toISOString(),question:String(question).slice(0,1000),
   answer:'',status:'pending',song:data.song||'',track:data.track||'',
   model:modelFile?.name||'Qwen3-0.6B-Q4_K_M.gguf'
  };
  setCurrent(null);
  out.textContent='Elaborazione Qwen in corso…';
  status('Inferenza locale di testo e note (nessun accesso ai WAV).');
  try{
   const saved=await saveAnalysis(record);
   record.id=saved.id;
   saveStatus('Richiesta registrata nell’archivio locale. Generazione in corso…');
  }catch(e){
   saveStatus('Attenzione: la richiesta non è stata salvata: '+e.message);
  }
  try{
   const response=await engine.createChatCompletion({
    messages:[
     {role:'system',content:SYS},
     {role:'user',content:'DATI DISPONIBILI: '+toContext(data)+'\nRICHIESTA: '+record.question+' /no_think'}
    ],
    max_tokens:280,temperature:.25,top_p:.9,stream:false
   });
   const answer=String(response?.choices?.[0]?.message?.content||'')
    .replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
   if(!answer)throw new Error('Qwen non ha restituito testo; niente da salvare.');
   record={...record,answer,status:'complete'};
   setCurrent(record);
   try{
    const saved=await saveAnalysis(record);record.id=saved.id;currentRecord=record;
    saveStatus('✓ Analisi salvata automaticamente sul telefono alle '+formatDate(record.createdAt)+'. Esportabile in TXT/PDF.');
   }catch(e){
    saveStatus('⚠ Risposta visibile ma salvataggio fallito: '+e.message+'. Usa Esporta TXT/PDF.');
   }
   status('Analisi Qwen completata. La cronologia è disponibile anche dopo la chiusura dell’app.');
  }catch(e){
   record={...record,status:'error',answer:'Errore di generazione: '+String(e?.message||e)};
   out.textContent=record.answer;
   try{await saveAnalysis(record);saveStatus('Errore registrato nella cronologia locale.');}
   catch(err){saveStatus('Impossibile salvare l’errore: '+err.message);}
   status('La generazione Qwen non è riuscita. I motori audio restano disponibili.');
  }finally{
   pending=false;ask.disabled=!ready;
   await refreshHistory();
  }
 }
 ask.addEventListener('click',()=>askQwen(prompt.value||'Analizza il risultato musicale.'));
 document.querySelectorAll('[data-ampy-ai]').forEach(button=>
  button.addEventListener('click',()=>askQwen(button.dataset.ampyAi))
 );
 save.addEventListener('click',async()=>{
  if(!currentRecord?.answer)return;
  try{
   const result=await saveAnalysis(currentRecord);
   currentRecord.id=result.id;
   saveStatus('✓ Analisi salvata e verificata: '+formatDate(currentRecord.createdAt));
   await refreshHistory();
  }catch(e){saveStatus('Salvataggio fallito: '+e.message);}
 });
 const slug=s=>String(s||'analisi').replace(/\.[^.]+$/,'').replace(/[^a-z0-9._-]/gi,'_').slice(0,45)||'analisi';
 txt.addEventListener('click',async()=>{
  if(!currentRecord?.answer)return;
  try{
   await exportFile(new Blob([analysisText(currentRecord)],{type:'text/plain;charset=utf-8'}),
     'AmpyQwen_'+slug(currentRecord.song)+'_'+Date.now()+'.txt');
   saveStatus('Esportazione TXT inviata al selettore di salvataggio Android.');
  }catch(e){saveStatus('Esportazione TXT non riuscita: '+e.message);}
 });
 pdf.addEventListener('click',async()=>{
  if(!currentRecord?.answer)return;
  pdf.disabled=true;
  try{
   const blob=await pdfForRecord(currentRecord);
   await exportFile(blob,'AmpyQwen_'+slug(currentRecord.song)+'_'+Date.now()+'.pdf');
   saveStatus('Esportazione PDF inviata al selettore di salvataggio Android.');
  }catch(e){saveStatus('Esportazione PDF non riuscita: '+e.message);}
  finally{pdf.disabled=false;}
 });
 backup.addEventListener('click',async()=>{
  try{
   const items=await listAnalyses();
   if(!items.length){saveStatus('Cronologia vuota: nessun dato da esportare.');return;}
   const json=JSON.stringify({app:'AmpySongScriber',schema:1,exportedAt:new Date().toISOString(),analyses:items},null,2);
   await exportFile(new Blob([json],{type:'application/json;charset=utf-8'}),
     'AmpySongScriber-Qwen-backup-'+new Date().toISOString().slice(0,10)+'.json');
   saveStatus('Backup della cronologia inviato al selettore Android.');
  }catch(e){saveStatus('Backup non riuscito: '+e.message);}
 });
 $('qwenRestoreFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{
   if(file.size>12*1048576)throw new Error('Backup oltre 12 MB: suddividi il file');
   const imported=JSON.parse(await file.text());
   if(imported.app!=='AmpySongScriber'||!Array.isArray(imported.analyses))
    throw new Error('Formato backup Qwen non valido');
   const existing=new Set((await listAnalyses()).map(x=>String(x.createdAt)+'|'+String(x.question)));
   let recovered=0;
   for(const item of imported.analyses){
    const signature=String(item.createdAt)+'|'+String(item.question);
    if(existing.has(signature))continue;
    await saveAnalysis({
     createdAt:String(item.createdAt||new Date().toISOString()),
     question:String(item.question||''),
     answer:String(item.answer||''),
     song:String(item.song||''),
     track:String(item.track||''),
     model:String(item.model||'Qwen3'),
     status:item.status==='error'?'error':item.status==='pending'?'pending':'complete'
    });
    recovered++;existing.add(signature);
   }
   saveStatus('Ripristino completato: '+recovered+' analisi recuperate, duplicati ignorati.');
   await refreshHistory();
  }catch(e){saveStatus('Ripristino non riuscito: '+e.message);}
  finally{event.target.value='';}
 });
 try{
  const last=localStorage.getItem('ampy_qwen_last_model_name');
  if(last)status('Ultimo modello scelto: '+last+'. Selezionalo nuovamente da Download per riavviare Qwen.');
 }catch{}
 refreshHistory();
 return {askQwen,isLoaded:()=>ready,unload:unloadModel};
}
