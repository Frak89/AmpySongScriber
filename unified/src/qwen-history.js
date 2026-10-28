/* Persistent local history for Qwen music notes.
 * Stores generated text and metadata only; never GGUF model bytes or audio.
 * IndexedDB durable transaction with explicit confirmation. LocalStorage fallback
 * when WebView storage is restricted; never report save success on exceptions.
 */
const DATABASE='ampysongscriber_qwen_local';
const STORE='analyses';
const FALLBACK='ampysongscriber_qwen_history_v1';
let cachedDatabase=null;
function db(){
 if(!('indexedDB' in globalThis))return Promise.reject(new Error('IndexedDB non disponibile'));
 if(cachedDatabase)return cachedDatabase;
 cachedDatabase=new Promise((resolve,reject)=>{
  const request=indexedDB.open(DATABASE,1);
  request.onupgradeneeded=()=>{
   const database=request.result;
   if(!database.objectStoreNames.contains(STORE)){
    database.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
   }
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error('Errore apertura archivio Qwen'));
  request.onblocked=()=>reject(new Error('Archivio temporaneamente occupato'));
 }).catch(error=>{cachedDatabase=null;throw error;});
 return cachedDatabase;
}
async function run(mode,operation){
 const database=await db();
 return new Promise((resolve,reject)=>{
  let result, requestError=null;
  const transaction=database.transaction(STORE,mode);
  const store=transaction.objectStore(STORE);
  try{
   const request=operation(store);
   if(request){
    request.onsuccess=()=>{result=request.result;};
    request.onerror=()=>{requestError=request.error;};
   }
  }catch(error){transaction.abort();reject(error);return;}
  transaction.oncomplete=()=>resolve(result);
  transaction.onerror=()=>reject(transaction.error||requestError||new Error('Errore archivio'));
  transaction.onabort=()=>reject(transaction.error||requestError||new Error('Salvataggio annullato'));
 });
}
function fallbackRead(){
 return JSON.parse(localStorage.getItem(FALLBACK)||'[]');
}
function fallbackWrite(data){
 localStorage.setItem(FALLBACK,JSON.stringify(data));
 const verify=localStorage.getItem(FALLBACK);
 if(!verify||verify!==JSON.stringify(data))throw new Error('Verifica del salvataggio non riuscita');
}
export function safeRecord(entry){
 const question=String(entry.question||'').trim().slice(0,1000);
 const answer=String(entry.answer||'').trim().slice(0,12000);
 if(!question)throw new Error('Domanda vuota');
 return {
  id:Number.isSafeInteger(entry.id)?entry.id:undefined,
  createdAt:entry.createdAt||new Date().toISOString(),
  status:entry.status==='error'?'error':entry.status==='pending'?'pending':'complete',
  song:String(entry.song||'').slice(0,180),
  track:String(entry.track||'').slice(0,100),
  model:String(entry.model||'Qwen3-0.6B-Q4_K_M.gguf').slice(0,100),
  question,answer
 };
}
export async function saveAnalysis(entry){
 const record=safeRecord(entry);
 try{
  const id=await run('readwrite',store=>store.put(record));
  return {id,storage:'indexeddb'};
 }catch(firstError){
  try{
   const history=fallbackRead();
   const id=record.id||Date.now();
   const updated={...record,id};
   const index=history.findIndex(x=>x.id===id);
   if(index>=0)history[index]=updated; else history.push(updated);
   fallbackWrite(history);
   return {id,storage:'localstorage'};
  }catch(secondError){
   throw new Error('Impossibile salvare la risposta sul telefono: '+(secondError?.message||firstError?.message));
  }
 }
}
export async function listAnalyses(){
 const items=[];
 try{
  items.push(...await run('readonly',store=>store.getAll()));
 }catch(err){/* fallback can still contain records */}
 try{
  items.push(...fallbackRead());
 }catch(err){if(!items.length)throw new Error('Cronologia non leggibile: '+err.message);}
 const unique=new Map();
 for(const item of items)unique.set(String(item.createdAt)+'|'+String(item.question),item);
 return [...unique.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
export async function deleteAnalysis(item){
 let cleared=false;
 if(Number.isSafeInteger(item.id)){
  try{await run('readwrite',store=>store.delete(item.id));cleared=true;}catch{}
 }
 try{
  const filtered=fallbackRead().filter(x=>x.id!==item.id);
  fallbackWrite(filtered);
  cleared=true;
 }catch(err){if(!cleared)throw err;}
 if(!cleared)throw new Error('Eliminazione non riuscita');
}
export function analysisText(record){
 return [
  'AmpySongScriber - Analisi locale Qwen',
  'Data: '+String(record.createdAt),
  'Modello: '+String(record.model||'Qwen3'),
  'Brano: '+String(record.song||'Non disponibile'),
  'Traccia: '+String(record.track||'Non disponibile'),
  '',
  'DOMANDA',
  String(record.question||''),
  '',
  'RISPOSTA',
  String(record.answer||'Nessuna risposta'),
  '',
  'I suggerimenti di Qwen non sostituiscono la trascrizione musicale e vanno verificati.'
 ].join('\n');
}
