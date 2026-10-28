import assert from 'node:assert/strict';
import {createMusicXML} from '../src/notation.js';
const notes=[
 {pitch:45,start:.1,duration:.22},
 {pitch:47,start:.43,duration:.31},
 {pitch:48,start:.78,duration:.35},
 {pitch:50,start:1.3,duration:.55}
];
for(const meter of ['4/4','3/4','6/8','5/4','7/8','12/8']){
 const xml=createMusicXML(notes,{title:'Meter '+meter,bass:true,bpm:120,meter});
 const [beats,type]=meter.split('/');
 assert.ok(xml.includes('<beats>'+beats+'</beats><beat-type>'+type+'</beat-type>'),meter);
 assert.ok(xml.includes('<score-partwise version="4.0">'));
 assert.ok(xml.includes('<measure number="1">'));
}
assert.throws(()=>createMusicXML(notes,{meter:'19/7'}),/non supportato/);
console.log('PASS Rev15: meter-aware MusicXML 3/4, 6/8, 5/4, 7/8 and 12/8 with stable notation');
