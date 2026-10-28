import assert from 'node:assert/strict';
import {refineInstrumentNotes,profileFor} from '../src/note-cleanup.js';
const notes=[
 {pitchMidi:24,startTimeSeconds:0,durationSeconds:.3,amplitude:.7}, // bass too low
 {pitchMidi:40,startTimeSeconds:0,durationSeconds:.3,amplitude:.7},
 {pitchMidi:40,startTimeSeconds:.32,durationSeconds:.2,amplitude:.8}, // merge
 {pitchMidi:80,startTimeSeconds:2,durationSeconds:.2,amplitude:.7}, // bass above range
 {pitchMidi:44,startTimeSeconds:2.4,durationSeconds:.01,amplitude:.7} // too short
];
const bass=refineInstrumentNotes(notes,'bass');
assert.equal(bass.length,1,'Bass range and short notes cleaned');
assert.equal(bass[0].pitch,40);
assert.ok(bass[0].duration>.5,'sustained note merged');
const piano=refineInstrumentNotes(notes,'piano');
assert.ok(piano.some(n=>n.pitch===24),'Piano retains low notes');
assert.ok(piano.some(n=>n.pitch===80),'Piano retains high notes');
assert.equal(profileFor('guitar').program,24);
console.log('PASS: instrument-specific note-range cleanup and de-duplication');
