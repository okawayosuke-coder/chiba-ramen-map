// 安全性検証: 一般道比較(v0.8.11)が「本物の高速道路」を誤って一般道にしていないか。
// 主要高速のセンターラインを順に走行し、新onPosロジックで posOn が false に化ける割合を測る。
// 期待: false化はほぼ0%（高速上では一般道より高速が近いので surfCloser にならない）。
import { readFileSync } from "node:fs";

const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));
const surf = JSON.parse(readFileSync(new URL("../public/surface-geom.json", import.meta.url), "utf8"));
function prep(src, pad){ const a=[]; for(const r of src.roads){ if(!Array.isArray(r.c)||r.c.length<2)continue; let s=90,w=180,n=-90,e=-180; for(const p of r.c){if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];} a.push({name:(r.name||r.ref||"").trim(),c:r.c,s,w,n,e}); } return {roads:a,pad}; }
const HW=prep(geom,0.002), SG=prep(surf,0.0016);
function nearest(g,lat,lng){ const mLat=110540,mLng=111320*Math.cos(lat*Math.PI/180); let best=Infinity; for(const road of g.roads){ if(lat<road.s-g.pad||lat>road.n+g.pad||lng<road.w-g.pad||lng>road.e+g.pad)continue; const c=road.c; for(let i=0;i<c.length-1;i++){ const ax=(c[i][1]-lng)*mLng,ay=(c[i][0]-lat)*mLat,bx=(c[i+1][1]-lng)*mLng,by=(c[i+1][0]-lat)*mLat; const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy; let t=len2?-(ax*dx+ay*dy)/len2:0; t=t<0?0:t>1?1:t; const d=Math.hypot(ax+t*dx,ay+t*dy); if(d<best)best=d; } } return isFinite(best)?best:null; }

const MARGIN=14;
const TARGETS=["東関東自動車道","京葉道路","常磐自動車道","東名高速道路","中央自動車道","東北自動車道","関越自動車道","新東名高速道路","館山自動車道","首都圏中央連絡自動車道","首都高速湾岸線","東京外環自動車道"];
const canon=s=>{ s=(s||"").split(";")[0].trim(); if(s==="圏央道")return"首都圏中央連絡自動車道"; return s; };

console.log(`安全性検証: 主要高速の本線走行で posOn が false(=一般道) に化ける割合\n`);
let gOn=0,gFalse=0,gAmb=0,gTot=0;
for (const target of TARGETS) {
  let on=0,off=0,amb=0,tot=0;
  for (const road of HW.roads) {
    if (canon(road.name)!==target) continue;
    let surfHits=0;
    for (const pt of road.c) {
      const lat=pt[0],lng=pt[1];
      const snap=nearest(HW,lat,lng);
      let posOn=null;
      if(snap==null){posOn=false;surfHits=0;}
      else{ const sd=nearest(SG,lat,lng); const surfCloser=sd!=null&&sd+MARGIN<snap; const hwCloser=sd==null||snap+MARGIN<sd; surfHits=surfCloser?Math.min(surfHits+1,5):0;
        if(surfHits>=3)posOn=false; else if(snap<35&&hwCloser)posOn=true; else if(snap>90)posOn=false; }
      tot++; if(posOn===true)on++; else if(posOn===false)off++; else amb++;
    }
  }
  if(!tot)continue;
  gOn+=on;gFalse+=off;gAmb+=amb;gTot+=tot;
  const warn = off/tot>0.02 ? "  ⚠誤OFF多" : "";
  console.log(`  ${target.padEnd(12)} 点${String(tot).padStart(5)}  ON ${(on/tot*100).toFixed(1).padStart(5)}%  曖昧 ${(amb/tot*100).toFixed(1).padStart(4)}%  false ${(off/tot*100).toFixed(1).padStart(4)}%${warn}`);
}
console.log(`\n  合計  点${gTot}  ON ${(gOn/gTot*100).toFixed(1)}%  曖昧 ${(gAmb/gTot*100).toFixed(1)}%  false(誤OFF) ${(gFalse/gTot*100).toFixed(2)}%`);
console.log(`  ※false=本線上で一般道判定された点。これがほぼ0%なら高速検出は壊れていない。`);
