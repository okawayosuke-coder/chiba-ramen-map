// 国道357を順に走行(=surfHits蓄積)させ、v0.8.11の新onPosロジックで posOn を判定して分布を見る。
// 期待: 357の大半が「一般道(posOn=false)」になり、高架の真下で重なる区間だけ「曖昧→速度ON」で残る。
import { readFileSync } from "node:fs";

const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));
const surf = JSON.parse(readFileSync(new URL("../public/surface-geom.json", import.meta.url), "utf8"));

function prep(src, pad) {
  const a = [];
  for (const r of src.roads) {
    if (!Array.isArray(r.c) || r.c.length < 2) continue;
    let s=90,w=180,n=-90,e=-180;
    for (const p of r.c){ if(p[0]<s)s=p[0]; if(p[0]>n)n=p[0]; if(p[1]<w)w=p[1]; if(p[1]>e)e=p[1]; }
    a.push({ name:(r.name||r.ref||"").trim(), c:r.c, s,w,n,e });
  }
  return { roads:a, pad };
}
const HW = prep(geom, 0.002), SG = prep(surf, 0.0016);
function nearest(g, lat, lng) {
  const mLat=110540, mLng=111320*Math.cos(lat*Math.PI/180);
  let best=Infinity;
  for (const road of g.roads) {
    if (lat<road.s-g.pad||lat>road.n+g.pad||lng<road.w-g.pad||lng>road.e+g.pad) continue;
    const c=road.c;
    for (let i=0;i<c.length-1;i++){
      const ax=(c[i][1]-lng)*mLng,ay=(c[i][0]-lat)*mLat,bx=(c[i+1][1]-lng)*mLng,by=(c[i+1][0]-lat)*mLat;
      const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy; let t=len2?-(ax*dx+ay*dy)/len2:0; t=t<0?0:t>1?1:t;
      const d=Math.hypot(ax+t*dx,ay+t*dy); if(d<best)best=d;
    }
  }
  return isFinite(best)?best:null;
}

// 357 を取得（measure-357 と同じクエリ）
const q=`[out:json][timeout:90];
( way["highway"~"trunk|primary"]["ref"~"357"](35.45,139.65,35.72,140.15);
  way["highway"~"trunk|primary"]["name"~"湾岸"](35.45,139.65,35.72,140.15); );
out geom;`;
const mirrors=["https://maps.mail.ru/osm/tools/overpass/api/interpreter","https://overpass.kumi.systems/api/interpreter","https://overpass-api.de/api/interpreter"];
let data=null;
for(const m of mirrors){ try{ const r=await fetch(m,{method:"POST",body:"data="+encodeURIComponent(q),headers:{"Content-Type":"application/x-www-form-urlencoded"}}); if(r.ok){data=await r.json(); break;} }catch{} }
if(!data){console.error("fetch失敗");process.exit(1);}

const MARGIN=14;
let onCnt=0, offCnt=0, ambCnt=0, tot=0;
// 各way（=連続走行の単位）ごとに surfHits を持って順に判定
for (const el of data.elements) {
  if (el.type!=="way"||!el.geometry) continue;
  let surfHits=0;
  for (const g of el.geometry) {
    const lat=g.lat, lng=g.lon;
    const snap = nearest(HW, lat, lng);
    let posOn=null;
    if (snap==null) { posOn=false; surfHits=0; }
    else {
      const sd = nearest(SG, lat, lng);
      const surfCloser = sd!=null && sd+MARGIN < snap;
      const hwCloser = sd==null || snap+MARGIN < sd;
      surfHits = surfCloser ? Math.min(surfHits+1,5) : 0;
      if (surfHits>=3) posOn=false;
      else if (snap<35 && hwCloser) posOn=true;
      else if (snap>90) posOn=false;
    }
    tot++;
    if (posOn===true) onCnt++;
    else if (posOn===false) offCnt++;
    else ambCnt++; // null → 速度に委ねる（357は高速度なので実質ON）
  }
}
const pct=x=>(x/tot*100).toFixed(1)+"%";
console.log(`357走行 ${tot}点 の新ロジック判定:`);
console.log(`  一般道 確定(posOn=false)      : ${offCnt} (${pct(offCnt)})  ← 直った分`);
console.log(`  曖昧→速度任せ(実質高速ON)     : ${ambCnt} (${pct(ambCnt)})  ← 高架の真下で重なる区間。手動OFFで対応`);
console.log(`  高速ON 確定(posOn=true)        : ${onCnt} (${pct(onCnt)})  ← 357がランプ等で実際に高速直近`);
console.log(`\n参考(旧ロジック): <35mで強制ON=51.7% + 35-90m速度ON=7.7% ≒ 約6割が高速判定だった`);
