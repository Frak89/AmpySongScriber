import assert from 'node:assert/strict';
import {safeLogLine} from '../src/debug-console.js';
assert.equal(safeLogLine(' carico modello \r \n '),'carico modello \n');
assert.ok(safeLogLine({a:1}).includes('"a":1'));
assert.ok(safeLogLine('a'.repeat(900),100).length<130);
assert.equal(safeLogLine(null),'null');
console.log('PASS: GGUF debug console log formatting, limits and serialization');
