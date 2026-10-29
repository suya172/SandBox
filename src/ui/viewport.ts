import { BgMat, MAT_CATEGORY, Mat, MatCategory, MatId } from '../core/materials';
import { FLAG_INDESTRUCTIBLE, FLAG_NO_BRUSH, HEIGHT, WIDTH, WorldGrid } from '../core/world';
import { onBlockEdited } from '../systems/building';

/**
 * ブラシ描画ロジック（スプリンクラー散布効果・保護セル判定・建築フック統合）
 */
export function applyBrush(
  world: WorldGrid,
  cx: number,
  cy: number,
  radius: number,
  mat: MatId,
  isAlchemistMode: boolean
): number {
  let placedCount = 0;
  const cat = MAT_CATEGORY[mat];
  const isScatter =
    cat === MatCategory.Powder || cat === MatCategory.Liquid || cat === MatCategory.Gas;

  const rSq = radius * radius;

  // 1x1 ブラシ（radius === 0）
  if (radius <= 0) {
    if (tryPaintSingleCell(world, cx, cy, mat, isAlchemistMode)) {
      placedCount++;
    }
    return placedCount;
  }

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > rSq) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;

      // 粉体・液体・気体はスプリンクラー効果で粒子状に心地よく散布する
      if (isScatter && radius >= 2 && Math.random() > 0.42) {
        continue;
      }

      if (tryPaintSingleCell(world, gx, gy, mat, isAlchemistMode)) {
        placedCount++;
      }
    }
  }

  return placedCount;
}

function tryPaintSingleCell(
  world: WorldGrid,
  x: number,
  y: number,
  mat: MatId,
  isAlchemistMode: boolean
): boolean {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return false;
  const i = world.idx(x, y);
  const flags = world.flags[i];

  // 破壊不可セル（コア本体・ベッドロック・固定湧水）は変更不可
  if ((flags & FLAG_INDESTRUCTIBLE) !== 0) return false;

  // Alchemist Mode ではコア周囲の保護エリアに直接マテリアルを描けない（消しゴムのみ許可）
  if (isAlchemistMode && mat !== Mat.Air && (flags & FLAG_NO_BRUSH) !== 0) {
    return false;
  }

  // 消しゴム (Mat.Air) の場合
  if (mat === Mat.Air) {
    const prev = world.type[i] as MatId;
    const prevBg = world.bgType[i];
    if (prev === Mat.Air && (prevBg === BgMat.None || prevBg === BgMat.CoreTree || prevBg === BgMat.StoneWall)) {
      return false;
    }
    world.setCell(x, y, Mat.Air);
    if (prevBg === BgMat.WoodPillar || prevBg === BgMat.WoodArch || prevBg === BgMat.RotorBlade) {
      world.setBg(x, y, BgMat.None, 0);
    }
    onBlockEdited(world, x, y, prev, Mat.Air);
    return true;
  }

  const existing = world.type[i] as MatId;

  // 木材の十字中心に銅線を置いた場合 → 羽根車 (RotorHub) 創発のため上書きを許可
  if (mat === Mat.Copper && existing === Mat.Wood) {
    world.setCell(x, y, Mat.Copper);
    onBlockEdited(world, x, y, existing, Mat.Copper);
    return true;
  }

  // 固体・機械以外のブラシは既存の固体ブロックを上書きしない（空気や流体の上のみ配置）
  const targetCat = MAT_CATEGORY[mat];
  const isSolidBrush =
    targetCat === MatCategory.Solid || targetCat === MatCategory.Machine || mat === Mat.VoltFern || mat === Mat.Mushroom;

  if (!isSolidBrush && existing !== Mat.Air && existing !== Mat.Water && existing !== Mat.Steam) {
    return false;
  }

  if (existing === mat) return false;

  // 植物の初期成長パラメータ付与
  let initialMeta = 0;
  if (mat === Mat.VoltFern) initialMeta = 4;
  else if (mat === Mat.Steam) initialMeta = 150;
  else if (mat === Mat.Fire) initialMeta = 60;

  world.setCell(x, y, mat, initialMeta);
  onBlockEdited(world, x, y, existing, mat);
  return true;
}

