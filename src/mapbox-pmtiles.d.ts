// mapbox-pmtiles(am2222・MIT) は package main が .ts ソースのため、そのまま import すると
// tsc がパッケージ内 .ts を noUnusedLocals で型検査して失敗する。dist の ESM ビルドを import しつつ、
// そのパスに ambient 宣言を与えて型を any 化する（実行時は Vite が dist を束ねる）。
declare module "mapbox-pmtiles/dist/mapbox-pmtiles.js" {
  // 実体は mapboxgl の VectorTileSource を継承したカスタムソース。型は any で十分。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PmTilesSource: any;
  export default PmTilesSource;
  export const SOURCE_TYPE: string;
}
