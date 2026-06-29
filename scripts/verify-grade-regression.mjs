// v0.8.13検証: 現在地中心±100m最小二乗回帰(新) vs here+80m 2点差分(旧) を実GSI標高で比較。
// 房総の起伏道路をsurface-geomから選び、25m間隔の標高プロファイルを実取得して両手法を当てる。
import { readFileSync } from "node:fs";

const surf = JSON.parse(readFileSync(new URL("../public/surface-geom.json", import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gsi(lat, lng) {
  try {
    const r = await fetch(`https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=${lng}&lat=${lat}&outtype=JSON`);
    const j = await r.json();
    if (j && j.elevation !== "-----" && j.elevation != null && !isNaN(Number(j.elevation))) return Number(j.elevation);
  } catch {}
  return null;
}
function lsqFit(xs, ys) {
  const n = xs.length; if (n < 2) return null;
  let sx=0,sy=0,sxx=0,sxy=0;
  for (let i=0;i<n;i++){sx+=xs[i];sy+=ys[i];sxx+=xs[i]*xs[i];sxy+=xs[i]*ys[i];}
  const d=n*sxx-sx*sx; if(Math.abs(d)<1e-9)return null; const a=(n*sxy-sx*sy)/d; return {a,b:(sy-a*sx)/n};
}
function lsqSlope(xs,ys){const f=lsqFit(xs,ys);return f?f.a:null;}
function robustSlope(xs,ys){const f=lsqFit(xs,ys);if(!f)return null;const res=xs.map((x,i)=>Math.abs(ys[i]-(f.a*x+f.b)));const s=[...res].sort((a,b)=>a-b);const mad=s[Math.floor(s.length/2)];const thr=Math.max(3*mad,1.5);const kx=[],ky=[];for(let i=0;i<xs.length;i++)if(res[i]<=thr){kx.push(xs[i]);ky.push(ys[i]);}if(kx.length<5)return f.a;const f2=lsqFit(kx,ky);return f2?f2.a:f.a;}
function std(a){const m=a.reduce((s,x)=>s+x,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);}
// 道路点列を等間隔(stepM)に再サンプル
function resample(coords, stepM) {
  const pts=[{lat:coords[0][0],lng:coords[0][1]}]; let acc=0,next=stepM;
  const hav=(a,b)=>{const R=6371000,t=x=>x*Math.PI/180;const dla=t(b.lat-a.lat),dlo=t(b.lng-a.lng);const u=Math.sin(dla/2)**2+Math.cos(t(a.lat))*Math.cos(t(b.lat))*Math.sin(dlo/2)**2;return 2*R*Math.asin(Math.sqrt(u));};
  for(let i=0;i<coords.length-1;i++){const a={lat:coords[i][0],lng:coords[i][1]},b={lat:coords[i+1][0],lng:coords[i+1][1]};const seg=hav(a,b);if(seg<=0)continue;while(acc+seg>=next){const f=(next-acc)/seg;pts.push({lat:a.lat+(b.lat-a.lat)*f,lng:a.lng+(b.lng-a.lng)*f});next+=stepM;}acc+=seg;}
  return pts;
}

// 房総内陸(起伏)の道路を探す: lat 35.18-35.42, lng 140.0-140.45, 長さ十分
const cands = surf.roads.filter(r => r.c.length>=8 && r.c.every(p=>p[0]>35.18&&p[0]<35.42&&p[1]>140.0&&p[1]<140.45));
console.log(`房総内陸の候補道路: ${cands.length}本。起伏のある道を探索...`);

const STEP=25, HALF=100;
let tested=0;
for (const road of cands) {
  if (tested>=2) break;
  const pts = resample(road.c, STEP);
  if (pts.length < 12) continue;
  // 標高プロファイル取得
  const ele=[];
  for (const p of pts){ ele.push(await gsi(p.lat,p.lng)); await sleep(120); }
  const valid = ele.filter(e=>e!=null);
  if (valid.length < pts.length*0.9) continue;
  const relief = Math.max(...valid)-Math.min(...valid);
  if (relief < 8) continue; // 起伏のある道だけ
  tested++;
  // 各「車位置」で旧2点法と新回帰を計算（プロファイル内インデックスで近似: +80m≒+3.2step, ±100m=±4step）
  const old2=[], newReg=[], robust=[];
  const aheadSteps=Math.round(80/STEP), halfSteps=Math.round(HALF/STEP);
  for (let i=halfSteps;i<ele.length-Math.max(aheadSteps,halfSteps);i++){
    if(ele[i]!=null&&ele[i+aheadSteps]!=null){const g=((ele[i+aheadSteps]-ele[i])/(aheadSteps*STEP))*100; if(Math.abs(g)<=25)old2.push(g);}
    const xs=[],ys=[];
    for(let k=-halfSteps;k<=halfSteps;k++){const e=ele[i+k];if(e!=null){xs.push(k*STEP);ys.push(e);}}
    if(xs.length>=5){const s=lsqSlope(xs,ys);if(s!=null){const g=s*100;if(Math.abs(g)<=25)newReg.push(g);}
      const rs=robustSlope(xs,ys);if(rs!=null){const g=rs*100;if(Math.abs(g)<=25)robust.push(g);}}
  }
  const fmt=a=>`平均${(a.reduce((s,x)=>s+x,0)/a.length).toFixed(2)}% std${std(a).toFixed(2)}% 範囲[${Math.min(...a).toFixed(1)},${Math.max(...a).toFixed(1)}]`;
  console.log(`\n道路(${pts[0].lat.toFixed(4)},${pts[0].lng.toFixed(4)}) 長さ~${(pts.length-1)*STEP}m 起伏${relief.toFixed(1)}m`);
  console.log(`  旧2点法     : ${fmt(old2)}`);
  console.log(`  回帰(素)    : ${fmt(newReg)} → std削減${((1-std(newReg)/std(old2))*100).toFixed(0)}%`);
  console.log(`  ロバスト回帰: ${fmt(robust)} → std削減${((1-std(robust)/std(old2))*100).toFixed(0)}%`);
}
if(tested===0)console.log("起伏のある道路が見つからず(房総候補のbboxが平坦寄り)。lat範囲を変えて再試行を。");
