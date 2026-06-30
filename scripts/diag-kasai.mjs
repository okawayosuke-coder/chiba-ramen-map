// 葛西付近(東関東道→首都高湾岸線)を西進し、render()の前方施設フィルタを再現して
// なぜ近い新木場/有明が出ず遠い空港中央が出たかを切り分ける。
import { readFileSync } from "node:fs";
const fac = JSON.parse(readFileSync(new URL("../public/highway.json", import.meta.url), "utf8"));
const geom = JSON.parse(readFileSync(new URL("../public/highways-geom.json", import.meta.url), "utf8"));

// --- canonicalRoad (src/roadName.ts と同一) ---
const ALIASES = [["首都圏中央連絡自動車道", /^(首都圏中央連絡自動車道|圏央道)$/]];
const isRamp = (s) => /(出口|入口|ランプ|ロータリー|バス停)$/.test(s) || s === "ETC専用" || /^[0-9]+$/.test(s);
const canon = (raw) => { let s=(raw||"").trim(); if(!s)return""; s=s.split(";")[0].trim(); if(!s||isRamp(s))return""; for(const[c,re]of ALIASES)if(re.test(s))return c; return s; };

const roads = [];
for (const r of geom.roads) {
  if(!Array.isArray(r.c)||r.c.length<2)continue;
  let s=90,w=180,n=-90,e=-180; for(const p of r.c){if(p[0]<s)s=p[0];if(p[0]>n)n=p[0];if(p[1]<w)w=p[1];if(p[1]>e)e=p[1];}
  roads.push({name:canon(r.name||r.ref),c:r.c,s,w,n,e});
}
const PAD=0.002;
function nearestHighway(lat,lng){
  const mLat=110540,mLng=111320*Math.cos(lat*Math.PI/180);
  let bestAll=Infinity,bestNamed=Infinity,bestName="";
  for(const road of roads){
    if(lat<road.s-PAD||lat>road.n+PAD||lng<road.w-PAD||lng>road.e+PAD)continue;
    const named=!!road.name,c=road.c;
    for(let i=0;i<c.length-1;i++){
      const ax=(c[i][1]-lng)*mLng,ay=(c[i][0]-lat)*mLat,bx=(c[i+1][1]-lng)*mLng,by=(c[i+1][0]-lat)*mLat;
      const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy;let t=len2?-(ax*dx+ay*dy)/len2:0;t=t<0?0:t>1?1:t;
      const d=Math.hypot(ax+t*dx,ay+t*dy);
      if(d<bestAll)bestAll=d; if(named&&d<bestNamed){bestNamed=d;bestName=road.name;}
    }
  }
  return isFinite(bestAll)?{distM:bestAll,name:bestName,namedDistM:bestNamed}:null;
}
const toRad=d=>d*Math.PI/180;
function hav(a,b){const R=6371,t=toRad;const dla=t(b.lat-a.lat),dlo=t(b.lng-a.lng);const u=Math.sin(dla/2)**2+Math.cos(t(a.lat))*Math.cos(t(b.lat))*Math.sin(dlo/2)**2;return 2*R*Math.asin(Math.sqrt(u));}
function bearing(a,b){const t=toRad;const y=Math.sin(t(b.lng-a.lng))*Math.cos(t(b.lat));const x=Math.cos(t(a.lat))*Math.sin(t(b.lat))-Math.sin(t(a.lat))*Math.cos(t(b.lat))*Math.cos(t(b.lng-a.lng));return (Math.atan2(y,x)*180/Math.PI+360)%360;}

const F=fac.facilities;
const MAXKM=25, LOOK=4;
// 湾岸線センターラインを取り、葛西(35.6411,139.8721)付近から西進する車列を作る
const wangan = roads.filter(r=>r.name==="首都高速湾岸線");
// 全頂点を集めて葛西に最も近い点を起点に、西(経度減)方向へ並べる
let pts=[]; for(const r of wangan) pts.push(...r.c.map(p=>({lat:p[0],lng:p[1]})));
// 葛西付近のbboxに絞る
pts=pts.filter(p=>p.lat>35.60&&p.lat<35.66&&p.lng>139.74&&p.lng<139.90);
pts.sort((a,b)=>b.lng-a.lng); // 東→西
// 起点を葛西付近(lng~139.872)にして西進、間引いて数地点
const carPts=[];
for(let i=0;i<pts.length;i+=Math.max(1,Math.floor(pts.length/8))) carPts.push(pts[i]);

console.log("葛西→西(有明/青海方面)を湾岸線センターラインに沿って走行、各地点でrender判定:");
for(let k=0;k<carPts.length-1;k++){
  const here=carPts[k], nxt=carPts[k+1];
  const hd=bearing(here,nxt);
  const snap=nearestHighway(here.lat,here.lng);
  const curRoad = (snap && snap.name && snap.namedDistM<80) ? snap.name : "(更新せず/sticky)";
  // render再現
  const cands=[];
  for(const f of F){
    const d=hav(here,{lat:f.lat,lng:f.lng});
    if(d>MAXKM||d<0.05)continue;
    const diff=Math.abs(((bearing(here,{lat:f.lat,lng:f.lng})-hd+540)%360)-180);
    if(diff>90)continue;
    const fwd=d*Math.cos(toRad(diff)), lat=d*Math.sin(toRad(diff));
    const useRoad = !!snap && snap.name && snap.namedDistM<80; // curRoad確定
    let pass, via;
    if(useRoad && f.road){ pass = f.road===snap.name; via="road"; }
    else { pass = lat <= Math.min(0.45+0.05*fwd,1.0); via="corridor"; }
    if(pass) cands.push({n:f.name,road:f.road||"-",fwd:+fwd.toFixed(1),lat:+lat.toFixed(2),via});
  }
  cands.sort((a,b)=>a.fwd-b.fwd);
  console.log(`\n@${here.lat.toFixed(4)},${here.lng.toFixed(4)} hd=${hd.toFixed(0)}° curRoad=${curRoad} (最寄り高速${snap?snap.distM.toFixed(0):"-"}m/名前付き${snap?snap.namedDistM.toFixed(0):"-"}m)`);
  console.log("  表示(前方"+LOOK+"件): "+cands.slice(0,LOOK).map(c=>`${c.n}[${c.fwd}km/${c.via}]`).join(" / "));
  // 新木場/有明/空港中央の個別判定
  for(const nm of ["新木場","有明","空港中央"]){
    const f=F.find(x=>x.name===nm); if(!f)continue;
    const d=hav(here,{lat:f.lat,lng:f.lng});
    const diff=Math.abs(((bearing(here,{lat:f.lat,lng:f.lng})-hd+540)%360)-180);
    const fwd=d*Math.cos(toRad(diff)), latd=d*Math.sin(toRad(diff));
    const inList=cands.slice(0,LOOK).some(c=>c.n===nm);
    console.log(`   ${nm}: d=${d.toFixed(1)}km diff=${diff.toFixed(0)}° fwd=${fwd.toFixed(1)} lat=${latd.toFixed(2)} road=${f.road} → ${diff>90?"後方除外":inList?"表示":"圏外/落選"}`);
  }
}
