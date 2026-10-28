import assert from 'node:assert/strict';
import {noteName,validateEditedNotes} from '../src/hybrid-editor.js';
assert.equal(noteName(60),'C4');
assert.equal(noteName(45),'A2');
assert.equal(noteName(70),'Bb4');
const original=[
 {pitch:45,start:2.1,duration:.3,velocity:.8},
 {pitch:41,start:.9,duration:.2,velocity:.5},
 {pitch:47,start:3.3,duration:.4,velocity:.9}
];
const corrected=validateEditedNotes(original);
assert.equal(corrected.length,3);
assert.deepEqual(corrected.map(x=>x.pitch),[41,45,47]);
assert.equal(original[0].start,2.1,'Source must not be mutated');
assert.throws(()=>validateEditedNotes([{pitch:130,start:1,duration:.2}]),/non valida/);
assert.throws(()=>validateEditedNotes([{pitch:45,start:-3,duration:.2}]),/non valida/);
assert.throws(()=>validateEditedNotes([{pitch:45,start:1,duration:0}]),/non valida/);
console.log('PASS Rev15 NoteLab: MIDI pitch names, validation, sorted editing and original immutability');
