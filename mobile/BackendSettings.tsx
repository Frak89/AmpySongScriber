"use client";
import { useEffect, useState } from "react";
export default function BackendSettings() {
 const [open, setOpen] = useState(false);
 const [url, setUrl] = useState("");
 const [msg, setMsg] = useState("");
 useEffect(() => { try { setUrl(localStorage.getItem("ampysongscriber_api") || ""); } catch {} }, []);
 function save() {
   try {
     if (url.trim()) {
       const parsed = new URL(url.trim());
       if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
     }
     localStorage.setItem("ampysongscriber_api", url.trim().replace(/\/$/, ""));
     setMsg(url.trim() ? "Indirizzo salvato. Il backend deve supportare CORS." : "Indirizzo cancellato.");
   } catch { setMsg("URL non valido: usa http:// o https://"); }
 }
 return <div className="fixed bottom-3 right-3 z-[9999] max-w-[calc(100vw-24px)] text-sm">
   {open && <div className="mb-2 w-[min(340px,calc(100vw-24px))] rounded-xl border border-yellow-500 bg-stone-950 p-4 text-white shadow-2xl">
     <h2 className="mb-2 font-bold">AmpySongScriber · Backend</h2>
     <p className="mb-3 text-xs text-stone-300">La trascrizione richiede un backend Python compatibile con AmpySongScriber. Inserisci l'indirizzo del server raggiungibile dal telefono.</p>
     <input aria-label="URL backend" className="w-full rounded border border-stone-600 bg-stone-800 p-2 text-white" type="url" placeholder="https://api.example.org" value={url} onChange={e=>setUrl(e.target.value)}/>
     <div className="mt-3 flex gap-2"><button className="rounded bg-yellow-500 px-3 py-2 font-bold text-black" onClick={save}>Salva</button><button className="rounded border border-stone-500 px-3 py-2" onClick={()=>setOpen(false)}>Chiudi</button></div>
     {msg && <p role="status" className="mt-2 text-xs">{msg}</p>}
   </div>}
   <button aria-label="Impostazioni server API" onClick={()=>{setOpen(!open);setMsg("");}} className="rounded-full border border-yellow-500 bg-stone-950 px-4 py-3 font-bold text-white shadow-xl">⚙ API</button>
 </div>;
}
