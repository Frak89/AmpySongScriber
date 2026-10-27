"""Adapt pinned Songscribe Next.js for Android static export. MIT upstream."""
from pathlib import Path
from shutil import rmtree, copyfile
import re, sys
root=Path(sys.argv[1]).resolve()
assets=Path(__file__).resolve().parent.parent/'mobile'
def edit(name, fn):
 p=root/name;p.write_text(fn(p.read_text(encoding='utf8')),encoding='utf8')
rmtree(root/'app/api',ignore_errors=True)
(root/'next.config.js').write_text("module.exports = { output:'export', trailingSlash:true, images:{unoptimized:true} };\n")
def layout(s):
 s=s.replace('import { Lexend, Nunito } from "next/font/google";','')
 s=re.sub(r'const lexend = Lexend\([\s\S]*?\);\s*const nunito = Nunito\([\s\S]*?\);','',s)
 s=s.replace('className={'+chr(96)+'$'+'{lexend.variable} $'+'{nunito.variable}'+chr(96)+'}','className=""')
 s=s.replace('import "./globals.css";','import "./globals.css";\nimport "./mobile.css";')
 s=s.replace('import Link from "next/link";','import Link from "next/link";\nimport BackendSettings from "./BackendSettings";')
 return s.replace('<footer className=','<BackendSettings />\n<footer className=')
edit('app/layout.tsx',layout)
for src,dst in [('BackendSettings.tsx','app/BackendSettings.tsx'),('mobileApi.ts','utils/mobileApi.ts')]:copyfile(assets/src,root/dst)
(root/'app/mobile.css').write_text(':root{--font-lexend:Arial,sans-serif;--font-nunito:Arial,sans-serif}button,a,input{touch-action:manipulation}\n')
for name in ('utils/getMidi.ts','utils/isolateAudio.ts','utils/getAudioFromUrl.ts'):
 def patch(s):
  old='$'+'{process.env.NEXT_PUBLIC_API_BASE_URL}'
  if old not in s:raise ValueError('Upstream API URL changed: '+name)
  return 'import { getApiBaseUrl } from "./mobileApi";\n'+s.replace(old,'$'+'{getApiBaseUrl()}')
 edit(name,patch)
(root/'utils/clearScores.ts').write_text('export async function clearScores(_baseUrl: string): Promise<boolean> { return false; }\n')
edit('utils/mergeMidi.ts',lambda s:s.replace('const combinedMidiBuffer = combinedMidi.toArray();','const combinedMidiBuffer = Uint8Array.from(combinedMidi.toArray()).buffer;'))
edit('app/audio/page.tsx',lambda s:re.sub(r'  // Warn user before leaving the page[\s\S]*?\n  return \(','  return (',s))
edit('app/audio/AudioForm.tsx',lambda s:s.replace('message = "Failed to isolate audio.";', 'message = error?.message || "Failed to isolate audio.";'))
edit('components/GetStartedButton.tsx',lambda s:s.replace('href="/audio"','href="/audio/"'))
edit('app/audio/ExportView.tsx',lambda s:s.replace('window.location.href = "/audio"','window.location.href = "/audio/"'))
(root/'capacitor.config.json').write_text('{"appId":"com.ampy.songscriber","appName":"AmpySongScriber","webDir":"out","android":{"allowMixedContent":true,"backgroundColor":"#111111"},"server":{"androidScheme":"https"}}\n')
print('Prepared Android UI in',root)
