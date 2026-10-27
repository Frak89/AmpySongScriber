import assert from 'node:assert/strict';
import {createMusicXML} from '../src/notation.js';
const notes=[
 {pitch:60,start:0,duration:.50},{pitch:64,start:0,duration:.50},
 {pitch:67,start:.50,duration:1.50},{pitch:72,start:1.0,duration:2.0},
 {pitch:48,start:2.6,duration:.25},{pitch:69,start:3.5,duration:1.0}
];
const xml=createMusicXML(notes,{title:'Prova & Test <File>',instrument:'Basso & chitarra',bpm:120,grid:120});
assert.ok(xml.startsWith('<?xml'));
assert.ok(xml.includes('Prova &amp; Test &lt;File&gt;'));
assert.ok(xml.includes('<voice>2</voice>'),'polyphonic voices must survive');
assert.ok(xml.includes('<backup><duration>1920</duration></backup>'),'independent voices need backups');
assert.ok(xml.includes('<tie type="start"/>'),'sustained notes must be tied');
assert.ok(xml.includes('<tie type="stop"/>'),'sustained notes must close');
assert.ok(xml.includes('<rest/>'),'gaps must be rests');
assert.ok(!xml.includes('<duration>0</duration>'),'no zero-length events');
assert.ok(xml.includes('<per-minute>120</per-minute>'));
assert.ok(xml.includes('Basso &amp; chitarra'));
console.log('PASS: multi-voice MusicXML, rests, ties, positive durations, escaping, BPM');
