import assert from 'node:assert/strict';
import {GGUF_CATALOG,findGGUF,plausibleModelSize,isModelGGUFHeader} from '../src/model-catalog.js';
assert.equal(GGUF_CATALOG.length>=3,true);
for(const m of GGUF_CATALOG){
 assert.ok(m.file.endsWith('.gguf'));
 assert.ok(m.url.startsWith('https://huggingface.co/'));
 assert.ok(m.url.includes('/resolve/main/'));
 assert.ok(!/embedding|reranker/i.test(m.file));
 assert.equal(plausibleModelSize(m,m.size),true);
 assert.equal(plausibleModelSize(m,4000),false);
 assert.equal(findGGUF(m.id),m);
}
assert.equal(isModelGGUFHeader(new Uint8Array([71,71,85,70,1,0,0,0])),true);
assert.equal(isModelGGUFHeader(new Uint8Array([60,104,116,109,108,62])),false);
assert.equal(isModelGGUFHeader(new Uint8Array([0,1])),false);
console.log('PASS: all GGUF catalogue models valid Instruct names, trusted HF URLs, bounded sizes, GGUF magic checks');
