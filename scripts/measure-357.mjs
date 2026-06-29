// 国道357号(東京湾岸道路の一般道部)の形状をOSMから取得し、各点が最寄りの高速センターライン
// (public/highways-geom.json)から何メートルかを測る。なぜ357走行が高速判定されるかの定量化。
import { readFileSync } from "node:fs";

const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));
const roads = [];
for (const r of geom.roads) {
  if (!Array.isArray(r.c) || r.c.length < 2) continue;
  let s=90,w=180,n=-90,e=-180;
  for (const p of r.c){ if(p[0]<s)s=p[0]; if(p[0]>n)n=p[0]; if(p[1]<w)w=p[1]; if(p[1]>e)e=p[1]; }
  roads.push({ name:(r.name||r.ref||"").trim(), c:r.c, s,w,n,e });
}
const PAD=0.002;
function nearest(lat,lng){
  const mLat=110540,mLng=111320*Math.cos(lat*Math.PI/180);
  let best=Infinity,name="";
  for(const road of roads){
    if(lat<road.s-PAD||lat>road.n+PAD||lng<road.w-PAD||lng>road.e+PAD)continue;
    const c=road.c;
    for(let i=0;i<c.length-1;i++){
      const ax=(c[i][1]-lng)*mLng,ay=(c[i][0]-lat)*mLat,bx=(c[i+1][1]-lng)*mLng,by=(c[i+1][0]-lat)*mLat;
      const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy; let t=len2?-(ax*dx+ay*dy)/len2:0; t=t<0?0:t>1?1:t;
      const d=Math.hypot(ax+t*dx,ay+t*dy); if(d<best){best=d;name=road.name;}
    }
  }
  return {d:best,name};
}

// 357号を取得（東京湾岸: 大田区〜千葉港）。ref/name 両方で拾う。
const q=`[out:json][timeout:90];
( way["highway"~"trunk|primary"]["ref"~"357"](35.45,139.65,35.72,140.15);
  way["highway"~"trunk|primary"]["name"~"湾岸"](35.45,139.65,35.72,140.15); );
out geom;`;
const mirrors=["https://overpass-api.de/api/interpreter","https://maps.mail.ru/osm/tools/overpass/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
let data=null;
for(const m of mirrors){
  try{
    const r=await fetch(m,{method:"POST",body:"data="+encodeURIComponent(q),headers:{"Content-Type":"application/x-www-form-urlencoded"}});
    if(!r.ok){console.error(m,r.status);continue;}
    data=await r.json(); console.error("OK",m,"elements",data.elements.length); break;
  }catch(e){console.error(m,String(e).slice(0,80));}
}
if(!data){console.error("全mirror失敗");process.exit(1);}

const pts=[];
const wayNames=new Set();
for(const el of data.elements){
  if(el.type!=="way"||!el.geometry)continue;
  wayNames.add((el.tags?.name||el.tags?.ref||"?"));
  for(const g of el.geometry) pts.push([g.lat,g.lon]);
}
console.log("取得way名(代表):",[...wayNames].slice(0,8).join(" / "));
console.log("357系の点数:",pts.length);

let on=0,amb=0,off=0; const hist={};
const buckets={"<15":0,"15-20":0,"20-25":0,"25-35":0,"35-50":0,"50-90":0,">90":0};
for(const [la,ln] of pts){
  const {d,name}=nearest(la,ln);
  if(d<35)on++; else if(d>90)off++; else amb++;
  if(d<15)buckets["<15"]++; else if(d<20)buckets["15-20"]++; else if(d<25)buckets["20-25"]++;
  else if(d<35)buckets["25-35"]++; else if(d<50)buckets["35-50"]++; else if(d<90)buckets["50-90"]++; else buckets[">90"]++;
  const k=name||"(なし)"; hist[k]=hist[k]||{n:0}; hist[k].n++;
}
const tot=pts.length;
console.log(`\n357走行中の最寄り高速センターラインまでの距離判定:`);
console.log(`  <35m  高速ON確定 : ${on}点 (${(on/tot*100).toFixed(1)}%)`);
console.log(`  35-90m 速度任せ  : ${amb}点 (${(amb/tot*100).toFixed(1)}%)  ←357は高速度なので実質ON`);
console.log(`  >90m  一般道確定 : ${off}点 (${(off/tot*100).toFixed(1)}%)`);
console.log(`\n距離バケット(しきい値を下げた時に救える量の目安):`);
let cum=0;
for(const [k,v] of Object.entries(buckets)){ cum+=v; console.log(`  ${k.padStart(6)}m : ${String(v).padStart(5)} (${(v/tot*100).toFixed(1)}%)  累積${(cum/tot*100).toFixed(1)}%`); }
console.log(`\n最寄りになった高速(上位):`);
console.log(Object.entries(hist).sort((a,b)=>b[1].n-a[1].n).slice(0,6).map(([k,v])=>`  ${String(v.n).padStart(5)}  ${k}`).join("\n"));
