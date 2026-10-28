/**
 * AmpySongScriber Rev13 curated offline GGUF model library.
 * Every entry is a TEXT-GENERATION / INSTRUCT model, not an embedding model.
 * Exact public Hugging Face model repo + direct resolve URL.
 * Sizes are advisory for storage check, not a guarantee of mobile inference.
 */
export const GGUF_CATALOG=Object.freeze([
 {
  id:'smol135-q4',title:'SmolLM2 135M Instruct · Q4_K_M',
  file:'SmolLM2-135M-Instruct-Q4_K_M.gguf',
  repo:'unsloth/SmolLM2-135M-Instruct-GGUF',
  size:105000000,
  role:'Analisi iniziale / test velocità',
  note:'Molto leggero. Qualità dei parametri limitata: verifica JSON e risultati.',
  license:'Apache-2.0',recommended:true
 },
 {
  id:'smol360-q4',title:'SmolLM2 360M Instruct · Q4_K_M',
  file:'SmolLM2-360M-Instruct-Q4_K_M.gguf',
  repo:'bartowski/SmolLM2-360M-Instruct-GGUF',
  size:271000000,
  role:'Revisione e parametri DSP',
  note:'Più capacità del 135M; da provare su Android WebView.',
  license:'Apache-2.0',recommended:true
 },
 {
  id:'smol360-q4-0',title:'SmolLM2 360M Instruct · Q4_0',
  file:'SmolLM2-360M-Instruct-Q4_0.gguf',
  repo:'bartowski/SmolLM2-360M-Instruct-GGUF',
  size:230000000,
  role:'Alternativa più compatta',
  note:'Formato Q4_0 più semplice, qualità inferiore a Q4_K_M.',
  license:'Apache-2.0'
 },
 {
  id:'qwen25-05b-q4',title:'Qwen2.5 0.5B Instruct · Q4_K_M',
  file:'qwen2.5-0.5b-instruct-q4_k_m.gguf',
  repo:'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  size:491000000,
  role:'Revisione in italiano',
  note:'Modello instruct multilingue; più pesante, non prioritario.',
  license:'Apache-2.0'
 },
 {
  id:'qwen3-06b-q4-0',title:'Qwen3 0.6B · Q4_0',
  file:'Qwen3-0.6B-Q4_0.gguf',
  repo:'ggml-org/Qwen3-0.6B-GGUF',
  size:429000000,
  role:'Alternativa Qwen3 ufficiale',
  note:'Potrebbe ripresentare il blocco di prefill già visto con Qwen3 sul Pixel.',
  license:'Apache-2.0'
 }
].map(m=>Object.freeze({
 ...m,
 source:'https://huggingface.co/'+m.repo,
 url:'https://huggingface.co/'+m.repo+'/resolve/main/'+encodeURIComponent(m.file)+'?download=true'
})));
export function findGGUF(id){return GGUF_CATALOG.find(x=>x.id===id)||null;}
export function plausibleModelSize(model,actual){
 return Number.isFinite(actual)&&actual>80*1048576
  &&actual>=model.size*.84&&actual<=model.size*1.18;
}
export function isModelGGUFHeader(bytes){
 const a=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
 return a.byteLength>=4&&a[0]===0x47&&a[1]===0x47&&a[2]===0x55&&a[3]===0x46;
}
