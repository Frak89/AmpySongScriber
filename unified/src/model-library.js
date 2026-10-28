/**
 * AmpySongScriber Rev13: native in-app GGUF downloader/selector.
 *
 * The network is accessed ONLY when the user explicitly presses "Scarica".
 * Capacitor FileTransfer writes model bytes directly to private Android Data
 * storage (NOT through JS base64 / WebView RAM). Downloads remain on device.
 * The original model sources and licenses are visible in the UI.
 *
 * For inference, Capacitor.convertFileSrc exposes the app-private file to the
 * local WebView. This creates a File/Blob on demand; heavy WebView memory usage
 * is possible and clearly reported. Never claim runtime compatibility without
 * physical testing.
 */
import {Filesystem,Directory} from '@capacitor/filesystem';
import {FileTransfer} from '@capacitor/file-transfer';
import {Capacitor} from '@capacitor/core';
import {GGUF_CATALOG,findGGUF,plausibleModelSize,isModelGGUFHeader} from './model-catalog.js';

const $=id=>document.getElementById(id);
const ROOT='AmpySongScriber/gguf';
const KEY='ampysongscriber_model_assignments_v1';
const fmt=bytes=>(bytes/1048576).toFixed(0)+' MiB';
const safeError=e=>String(e?.message||e?.code||e).slice(0,400);
function getAssignments(){
 try{
  const x=JSON.parse(localStorage.getItem(KEY)||'{}');
  return {first:String(x.first||''),second:String(x.second||'')};
 }catch{return {first:'',second:''};}
}
function persistAssignments(a){
 try{localStorage.setItem(KEY,JSON.stringify(a));}catch{}
}
function pathFor(model){return ROOT+'/'+model.file;}
function pathForTemp(model){return ROOT+'/'+model.id+'.downloading';}
export function initModelLibrary({onChange=()=>{},log=()=>{}}={}){
 const host=$('modelCatalog'),status=$('modelLibraryStatus');
 const assignments=getAssignments();
 const downloaded=new Map();
 const cards=new Map();
 let downloading=false, activeId=null, lastProgressBytes=0,verified=false;
 const native=Capacitor.isNativePlatform();
 const say=message=>{status.textContent=message;log(message);};

 async function present(model){
  const ui=cards.get(model.id);
  if(!ui)return;
  const found=downloaded.get(model.id);
  ui.download.disabled=downloading||!!found||!native;
  ui.first.disabled=downloading||!found;
  ui.second.disabled=downloading||!found;
  ui.remove.disabled=downloading||!found;
  ui.download.textContent=found?'✓ Scaricato':'⬇ Scarica '+fmt(model.size);
  ui.first.textContent=assignments.first===model.id?'✓ IA 1 selezionata':'Usa come IA 1';
  ui.second.textContent=assignments.second===model.id?'✓ IA 2 selezionata':'Usa come IA 2';
  ui.state.textContent=found?
    'Installato in archivio app ('+fmt(found.size)+'). Offline · nessuna riselezione Download.':
    native?'Da scaricare · necessita Internet solo per installare il modello':
      'Download diretto disponibile nell’app Android, non nel browser';
  ui.state.style.color=found?'#93e5b2':'';
 }
 async function refresh(){
  for(const m of GGUF_CATALOG){
   try{
    const stat=await Filesystem.stat({directory:Directory.Data,path:pathFor(m)});
    const size=Number(stat.size);
    if(plausibleModelSize(m,size)){downloaded.set(m.id,{size});}
    else downloaded.delete(m.id);
   }catch{downloaded.delete(m.id);}
  }
  if(!downloaded.has(assignments.first))assignments.first='';
  if(!downloaded.has(assignments.second))assignments.second='';
  persistAssignments(assignments);
  for(const m of GGUF_CATALOG)await present(m);
  const n=downloaded.size;
  say(n+' modelli GGUF installati. '+'Selezione IA1: '+(findGGUF(assignments.first)?.title||'file manuale')+
    ' · IA2: '+(findGGUF(assignments.second)?.title||'file manuale')+'.');
  onChange();
 }
 function roleMeta(role){
  const id=assignments[role];
  const m=findGGUF(id);
  return m&&downloaded.has(id)?{name:m.file,size:downloaded.get(id).size}:null;
 }
 async function loadRoleFile(role){
  const id=assignments[role],m=findGGUF(id);
  if(!m||!downloaded.has(id))return null;
  if(!native)throw Error('I modelli installati possono essere aperti solo dalla app Android.');
  const {uri}=await Filesystem.getUri({directory:Directory.Data,path:pathFor(m)});
  const safeUri=Capacitor.convertFileSrc(uri);
  say('Apro '+m.title+' dal file salvato sul telefono (nessuna rete)…');
  let response;
  try{response=await fetch(safeUri,{cache:'no-store'});}
  catch(e){throw Error('File locale non leggibile in Android WebView: '+safeError(e));}
  if(!response.ok)throw Error('Android WebView non apre il modello locale: HTTP '+response.status);
  const blob=await response.blob();
  if(!plausibleModelSize(m,blob.size))
   throw Error('Il GGUF è incompleto: '+fmt(blob.size)+' (previsti ~'+fmt(m.size)+').');
  const magic=new Uint8Array(await blob.slice(0,4).arrayBuffer());
  if(!isModelGGUFHeader(magic))throw Error('Il file non ha intestazione GGUF (file HTML/errore download?)');
  return new File([blob],m.file,{type:'application/octet-stream',lastModified:Date.now()});
 }
 function assign(role,model){
  if(!downloaded.has(model.id))return;
  assignments[role]=model.id;
  if(assignments.first&&assignments.second&&assignments.first!==assignments.second&&$('ggufReuse'))
   $('ggufReuse').checked=false;
  persistAssignments(assignments);
  for(const m of GGUF_CATALOG)present(m);
  say(model.title+' assegnato a '+(role==='first'?'IA 1':'IA 2')+'. Puoi avviare la pipeline offline.');
  onChange();
 }
 async function remove(model){
  if(!downloaded.has(model.id))return;
  if(!window.confirm('Eliminare '+model.title+' dai file dell’app? Potrai riscaricarlo in seguito.'))return;
  try{
   await Filesystem.deleteFile({directory:Directory.Data,path:pathFor(model)});
   downloaded.delete(model.id);
   if(assignments.first===model.id)assignments.first='';
   if(assignments.second===model.id)assignments.second='';
   persistAssignments(assignments);
   await present(model);
   say('Modello eliminato: '+model.title);
   onChange();
  }catch(e){say('Eliminazione fallita: '+safeError(e));}
 }
 async function download(model){
  if(downloading||downloaded.has(model.id))return;
  if(!native){say('Il download integrato richiede Android. Per il browser apri la fonte Hugging Face.');return;}
  downloading=true;activeId=model.id;lastProgressBytes=0;
  for(const m of GGUF_CATALOG)present(m);
  const ui=cards.get(model.id);
  ui.progress.hidden=false;ui.progress.value=0;
  ui.state.textContent='Connessione a Hugging Face…';
  let handle=null;
  try{
   await Filesystem.mkdir({directory:Directory.Data,path:ROOT,recursive:true});
   const target=pathForTemp(model);
   // Download to .downloading first: partial files cannot be mistaken for models.
   try{await Filesystem.deleteFile({directory:Directory.Data,path:target});}catch{}
   const {uri}=await Filesystem.getUri({directory:Directory.Data,path:target});
   handle=await FileTransfer.addListener('progress',ev=>{
    if(activeId!==model.id)return;
    const bytes=Number(ev.bytes)||0,total=Number(ev.contentLength)||model.size;
    if(bytes<=lastProgressBytes)return;
    lastProgressBytes=bytes;
    ui.progress.value=Math.min(99,Math.floor(100*bytes/Math.max(total,1)));
    ui.state.textContent='Scaricati '+fmt(bytes)+' / ~'+fmt(model.size)+
      ' ('+ui.progress.value+'%). Non chiudere l’app.';
   });
   say('Download '+model.title+' in memoria privata Android. Nessun GGUF nell’APK.');
   await FileTransfer.downloadFile({
    url:model.url,path:uri,progress:true,
    connectTimeout:60000,readTimeout:120000
   });
   const st=await Filesystem.stat({directory:Directory.Data,path:target});
   if(!plausibleModelSize(model,Number(st.size)))throw Error(
    'Dimensione incompleta: '+fmt(Number(st.size))+' invece di circa '+fmt(model.size));
   await Filesystem.rename({
    from:target,to:pathFor(model),directory:Directory.Data
   });
   downloaded.set(model.id,{size:Number(st.size)});
   ui.progress.value=100;
   ui.state.textContent='✓ Scaricato e verificato per dimensione: '+fmt(Number(st.size));
   if(!assignments.second){
    assignments.second=model.id;persistAssignments(assignments);
   }else if(!assignments.first&&assignments.second!==model.id){
    assignments.first=model.id;persistAssignments(assignments);
    if($('ggufReuse'))$('ggufReuse').checked=false;
   }
   say('Modello installato offline: '+model.file+'. Verifica GGUF all’apertura prima dell’inferenza.');
   onChange();
  }catch(e){
   say('Download non riuscito: '+safeError(e)+'; ritenta con rete stabile e spazio libero.');
   ui.state.textContent='Errore: '+safeError(e);
   try{await Filesystem.deleteFile({directory:Directory.Data,path:pathForTemp(model)});}catch{}
  }finally{
   if(handle)try{await handle.remove();}catch{}
   downloading=false;activeId=null;
   for(const m of GGUF_CATALOG)present(m);
  }
 }
 function el(tag,cls,text){
  const n=document.createElement(tag);if(cls)n.className=cls;
  if(text!=null)n.textContent=text;
  return n;
 }
 for(const model of GGUF_CATALOG){
  const card=el('div','model-library-card');
  const headline=el('strong','',model.title);
  const detail=el('p','sub',model.role+' · ~'+fmt(model.size)+' · '+model.license+' · '+model.note);
  const link=el('a','sub','Fonte originale Hugging Face');
  link.href=model.source;link.target='_blank';link.rel='noopener noreferrer';
  const state=el('p','sub','Verifica archivio…');
  const progress=el('progress');progress.max=100;progress.value=0;progress.hidden=true;
  const actions=el('div','actions');
  const dl=el('button','secondary','⬇ Scarica '+fmt(model.size));
  const first=el('button','secondary','IA 1');const second=el('button','secondary','IA 2');
  const removeBtn=el('button','secondary','Elimina');
  dl.addEventListener('click',()=>download(model));
  first.addEventListener('click',()=>assign('first',model));
  second.addEventListener('click',()=>assign('second',model));
  removeBtn.addEventListener('click',()=>remove(model));
  actions.append(dl,first,second,removeBtn);
  card.append(headline,detail,link,state,progress,actions);
  host.append(card);
  cards.set(model.id,{download:dl,first,second,remove:removeBtn,state,progress});
 }
 $('modelLibraryRefresh').addEventListener('click',refresh);
 $('modelLibraryClearRole1').addEventListener('click',()=>{
  assignments.first='';persistAssignments(assignments);
  for(const m of GGUF_CATALOG)present(m);
  say('IA 1 liberata: puoi selezionare un GGUF da Download manualmente.');onChange();
 });
 $('modelLibraryClearRole2').addEventListener('click',()=>{
  assignments.second='';persistAssignments(assignments);
  for(const m of GGUF_CATALOG)present(m);
  say('IA 2 liberata: puoi selezionare un GGUF da Download manualmente.');onChange();
 });
 refresh();
 return {
  getRoleMeta:roleMeta,
  getRoleFile:loadRoleFile,
  clearRole:role=>{
   assignments[role]='';persistAssignments(assignments);
   for(const m of GGUF_CATALOG)present(m);
   onChange();
  },
  refresh
 };
}
