/**
 * Rev10 on-device diagnostic console for AmpySongScriber.
 * No external telemetry: messages are rendered locally and downloadable as TXT.
 * Token progress reports *observed* chunks; no invented percentage/ETA.
 */
const $=id=>document.getElementById(id);
const formatSec=seconds=>Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
export function safeLogLine(value,max=440){
 try{
  let line=typeof value==='string'?value:JSON.stringify(value);
  if(line===undefined)line=String(value);
  line=line.replace(/\r/g,'').replace(/[^\S\n]+/g,' ').trim();
  return line.length>max?line.slice(0,max)+' …[troncato]':line;
 }catch{return String(value);}
}
export function initDebugConsole(exportFile){
 const panel=$('ggufConsole'),state=$('ggufConsoleState');
 const stage=$('ggufConsoleStage'),elapsed=$('ggufConsoleTime');
 const tokens=$('ggufConsoleTokens'),memory=$('ggufConsoleMemory');
 const stop=$('ggufStop'),download=$('ggufExportConsole');
 const clear=$('ggufClearConsole'),autoscroll=$('ggufConsoleAutoscroll');
 let lines=[],stageName='Inattiva',stageSince=Date.now(),count=0,active=false,lastTokenAt=0;
 let stopHandler=null,tokenText='',renderCounter=0;
 function clock(){return new Date().toLocaleTimeString('it-IT',{hour12:false});}
 function scroll(){if(autoscroll.checked)panel.scrollTop=panel.scrollHeight;}
 function put(kind,message){
  const line='['+clock()+']['+kind+'] '+safeLogLine(message);
  lines.push(line);
  if(lines.length>2000)lines.splice(0,lines.length-1500);
  const text=document.createTextNode(line+'\n');
  panel.append(text);
  if(panel.childNodes.length>520)panel.removeChild(panel.firstChild);
  scroll();
 }
 function setStage(name){
  stageName=String(name);
  stageSince=Date.now();
  count=0;lastTokenAt=0;tokenText='';renderCounter=0;
  stage.textContent='Fase: '+stageName;
  tokens.textContent='Token: 0';
  state.textContent=active?'IN ESECUZIONE':'IN ATTESA';
  put('FASE',stageName);
 }
 function setActive(value){
  active=Boolean(value);
  stop.disabled=!active;
  state.textContent=active?'IN ESECUZIONE':'IN ATTESA';
 }
 function token(chunk){
  count++;
  lastTokenAt=Date.now();
  tokenText+=String(chunk||'');
  if(tokenText.length>3500)tokenText=tokenText.slice(-3500);
  tokens.textContent='Token/chunk: '+count;
  // Write content once per 8 chunks, so Chromium WebView stays responsive.
  renderCounter++;
  if(renderCounter>=8){flushToken();renderCounter=0;}
 }
 function flushToken(){
  if(!tokenText)return;
  let excerpt=tokenText;
  if(excerpt.length>600)excerpt=excerpt.slice(-600);
  put('IA OUTPUT',excerpt);
  tokenText='';
 }
 function tick(){
  if(!active)return;
  const sec=Math.floor((Date.now()-stageSince)/1000);
  elapsed.textContent='Fase: '+formatSec(sec);
  const perf=performance?.memory;
  if(perf&&Number.isFinite(perf.usedJSHeapSize)){
   memory.textContent='Heap JS: '+(perf.usedJSHeapSize/1048576).toFixed(0)+' MiB';
  }else memory.textContent='Heap JS: non esposto da Android';
  if(sec>=30&&count===0&&sec%15===0){
   // Distinguish "wait" from token progress; no fake activity.
   put('ATTESA','Nessun token ricevuto dopo '+sec+' s. Possibile preparazione contesto o inferenza bloccata.');
  }
  if(sec>=60&&count>0&&lastTokenAt&&Date.now()-lastTokenAt>30000&&sec%15===0){
   put('ATTESA','Ultimo token '+Math.floor((Date.now()-lastTokenAt)/1000)+' s fa.');
  }
 }
 const clockHandle=setInterval(tick,1000);
 stop.addEventListener('click',()=>{
  if(!active)return;
  put('STOP','Interruzione richiesta. L operazione WASM può terminare solo dopo la chiamata corrente.');
  stop.disabled=true;
  stopHandler?.();
 });
 clear.addEventListener('click',()=>{
  panel.replaceChildren();lines=[];
  put('CONSOLE','Vista e log azzerati su richiesta.');
 });
 download.addEventListener('click',async()=>{
  try{
   put('EXPORT','Esportazione del log locale.');
   const contents=[
    'AmpySongScriber Rev10 - Console IA locale',
    'Data: '+new Date().toISOString(),
    'Android WebView - log diagnostico (nessun invio online)',
    '',
    ...lines
   ].join('\n');
   await exportFile(new Blob([contents],{type:'text/plain;charset=utf-8'}),
    'AmpySongScriber-Console-'+new Date().toISOString().replace(/[:.]/g,'-')+'.txt');
  }catch(e){put('ERRORE','Esportazione log: '+safeLogLine(e?.message||e));}
 });
 put('SYSTEM','Console locale inizializzata. In attesa di GGUF o elaborazione audio.');
 return {
  line:(message)=>put('INFO',message),
  warn:(message)=>put('WARN',message),
  error:(message)=>put('ERRORE',message),
  stage:setStage,
  token,flushToken,
  setActive,
  setStopHandler:handler=>{stopHandler=handler;},
  modelLogger:{
   log:(...args)=>put('WASM',args.map(x=>safeLogLine(x,200)).join(' ')),
   info:(...args)=>put('WASM',args.map(x=>safeLogLine(x,200)).join(' ')),
   warn:(...args)=>put('WASM WARN',args.map(x=>safeLogLine(x,200)).join(' ')),
   error:(...args)=>put('WASM ERRORE',args.map(x=>safeLogLine(x,200)).join(' ')),
   debug:()=>{}
  }
 };
}
