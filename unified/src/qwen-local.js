/**
 * Optional offline Qwen3 GGUF assistant, file selected via Android picker.
 * Qwen analyzes structured results, not PCM audio or waveform directly.
 */
let engine=null,modelFile=null,ready=false,pending=false;
const $=id=>document.getElementById(id);
const status=text=>{$('qwenStatus').textContent=text;};
const SYS=[
 'Sei AmpyQwen, assistente musicale offline di AmpySongScriber.',
 'HTDemucs separa l audio, YAMNet classifica alcuni strumenti, Basic Pitch stima note, MusicXML/PDF sono generati da codice.',
 'Ricevi soltanto testo e dati delle note. NON ascolti direttamente le onde sonore o il WAV.',
 'Rispondi in italiano, con consigli brevi e verificabili. Non inventare note, strumenti, precisione o BPM assenti.',
 'Se ci sono dati mancanti o incerti, indicalo. Non proporre accesso a server o cloud.'
].join(' ');
function toContext(data){
 const d=data||{};
 return JSON.stringify({
  brano:String(d.song||'').slice(0,90),
  durata_secondi:Number(d.durationSec||0),
  tempo_bpm:Number(d.tempo||120),
  traccia:String(d.track||'').slice(0,50),
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
export function initQwen(getContext){
 const input=$('qwenFile'),load=$('qwenLoad'),unload=$('qwenUnload');
 const ask=$('qwenAsk'),prompt=$('qwenPrompt'),out=$('qwenOutput');
 input.addEventListener('change',()=>{
  const f=input.files?.[0];
  if(!f)return;
  if(!/\.gguf$/i.test(f.name)||f.size<100*1048576||f.size>1500*1048576){
   modelFile=null;load.disabled=true;
   status('Seleziona Qwen3-0.6B-Q4_K_M.gguf (~484 MB) da Download.');return;
  }
  modelFile=f;load.disabled=false;
  status('Selezionato '+f.name+' · '+(f.size/1048576).toFixed(0)+' MiB. Premi Avvia Qwen.');
 });
 load.addEventListener('click',async()=>{
  if(!modelFile||pending)return;
  pending=true;load.disabled=true;ask.disabled=true;
  status('Caricamento Qwen dal file GGUF locale. Può richiedere molta RAM nel WebView...');
  try{
   if(engine){await engine.exit();engine=null;ready=false;}
   const {Wllama}=await import('@wllama/wllama');
   engine=new Wllama({default:'./wllama/wllama.wasm'},{allowOffline:true});
   await engine.loadModel([modelFile],{n_ctx:1536,n_batch:128,n_threads:1,n_gpu_layers:0});
   ready=true;ask.disabled=false;
   status('Qwen3-0.6B caricato offline. Puoi chiedere analisi delle tracce o dello spartito.');
  }catch(err){
   ready=false;try{await engine?.exit()}catch{}
   engine=null;
   status('Impossibile caricare Qwen: '+String(err?.message||err)+'. Possibile limite RAM/WebAssembly. Separazione e spartiti rimangono disponibili.');
  }finally{pending=false;load.disabled=false;}
 });
 unload.addEventListener('click',async()=>{
  if(pending)return;
  try{
   if(engine)await engine.exit();
   engine=null;ready=false;ask.disabled=true;
   status('Qwen scaricato dalla RAM. Per riprenderlo seleziona nuovamente il GGUF.');
  }catch(err){status('Errore liberando Qwen: '+String(err?.message||err));}
 });
 async function askQwen(question){
  if(!ready||!engine){status('Carica prima il GGUF dalla cartella Download.');return;}
  if(pending)return;
  pending=true;ask.disabled=true;
  out.textContent='Elaborazione locale Qwen…';
  status('Analisi offline di testo e note: il modello non ascolta direttamente il WAV.');
  try{
   const answer=await engine.createChatCompletion({
    messages:[
     {role:'system',content:SYS},
     {role:'user',content:'DATI DISPONIBILI: '+toContext(getContext())+'\nRICHIESTA: '+String(question).slice(0,500)+' /no_think'}
    ],
    max_tokens:240,temperature:0.25,top_p:0.9,stream:false
   });
   const text=String(answer?.choices?.[0]?.message?.content||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
   out.textContent=text||'Nessuna risposta generata.';
   status('Analisi Qwen completata: verifica manualmente i suggerimenti.');
  }catch(err){
   out.textContent='Errore Qwen: '+String(err?.message||err);
   status('Qwen non disponibile. Le funzioni audio restano indipendenti.');
  }finally{pending=false;ask.disabled=false;}
 }
 ask.addEventListener('click',()=>askQwen(prompt.value||'Suggerisci correzioni basate sui dati correnti.'));
 document.querySelectorAll('[data-ampy-ai]').forEach(b=>
  b.addEventListener('click',()=>askQwen(b.dataset.ampyAi))
 );
 return {askQwen,isLoaded:()=>ready};
}
