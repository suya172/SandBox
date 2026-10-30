import { BgMat, MAT_CATEGORY, Mat, MatCategory, MatId } from '../core/materials';
import { FLAG_INDESTRUCTIBLE, FLAG_NO_BRUSH, HEIGHT, WIDTH, WorldGrid } from '../core/world';
import { ProgressionManager } from '../modes/alchemist';
import { onBlockEdited } from '../systems/building';

export interface BrushResult {
  changedCount: number;
  blockedTier: number; // 0=ブロックなし, 2..4=必要ツールティア不足, 99=破壊不可
  outOfStock: boolean;
}

/**
 * ハイブリッド操作対応ブラシ処理（配置時のストック消費 ＆ 吸引・掘削時の硬度判定・ストック回収）
 */
export function applyHybridBrush(
  world: WorldGrid,
  progression: ProgressionManager,
  cx: number,
  cy: number,
  radius: number,
  mat: MatId,
  action: 'place' | 'harvest'
): BrushResult {
  const res: BrushResult = {
    changedCount: 0,
    blockedTier: 0,
    outOfStock: false,
  };

  const effectiveAction = mat === Mat.Air ? 'harvest' : action;
  const isAlchemist = progression.mode === 'alchemist';

  // Tier 4 未満の Alchemist Mode では極端な大径ブラシでの一括掘削を少し抑制しつつ快適に操作させる
  const effectiveRadius =
    isAlchemist && progression.toolTier === 1 && effectiveAction === 'harvest'
      ? Math.min(radius, 3)
      : radius;

  const cat = MAT_CATEGORY[mat];
  const isScatter =
    effectiveAction === 'place' &&
    (cat === MatCategory.Powder || cat === MatCategory.Liquid || cat === MatCategory.Gas);
  const rSq = effectiveRadius * effectiveRadius;

  if (effectiveRadius <= 0) {
    applyHybridCell(world, progression, cx, cy, mat, effectiveAction, res);
    return res;
  }

  for (let dy = -effectiveRadius; dy <= effectiveRadius; dy++) {
    for (let dx = -effectiveRadius; dx <= effectiveRadius; dx++) {
      if (dx * dx + dy * dy > rSq) continue;
      const gx = cx + dx;
      const gy = cy + dy;
      if (!world.inBounds(gx, gy)) continue;

      if (isScatter && effectiveRadius >= 2 && world.rng.next() > 0.42) {
        continue;
      }

      applyHybridCell(world, progression, gx, gy, mat, effectiveAction, res);
    }
  }

  return res;
}

function applyHybridCell(
  world: WorldGrid,
  progression: ProgressionManager,
  x: number,
  y: number,
  mat: MatId,
  action: 'place' | 'harvest',
  res: BrushResult
): void {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const i = world.idx(x, y);
  const flags = world.flags[i];

  if (action === 'harvest') {
    const prev = world.type[i] as MatId;
    const prevBg = world.bgType[i];
    const hasRemovableBg =
      prevBg === BgMat.WoodPillar || prevBg === BgMat.WoodArch || prevBg === BgMat.RotorBlade;

    if (prev === Mat.Air && !hasRemovableBg) {
      return;
    }

    if (prev !== Mat.Air) {
      const check = progression.canDigCell(prev, flags);
      if (!check.ok) {
        if (check.requiredTier !== 99 && check.requiredTier > res.blockedTier) {
          res.blockedTier = check.requiredTier;
        }
        return;
      }
      world.setCell(x, y, Mat.Air);
      world.flags[i] &= ~8; // FLAG_RUIN クリア
      progression.harvestCell(prev, world.dayCount);
    }

    if (hasRemovableBg) {
      world.setBg(x, y, BgMat.None, 0);
    }
    onBlockEdited(world, x, y, prev, Mat.Air);
    res.changedCount++;
    return;
  }

  // 配置 (place) アクション
  if ((flags & FLAG_INDESTRUCTIBLE) !== 0) return;
  if (progression.mode === 'alchemist' && (flags & FLAG_NO_BRUSH) !== 0) return;
  if (!progression.isBrushUnlocked(mat)) return;

  const existing = world.type[i] as MatId;

  // 木材の十字中心に銅線を置いた場合 → 羽根車 (RotorHub) 創発のため上書き許可
  if (mat === Mat.Copper && existing === Mat.Wood) {
    if (!progression.consumeForPlace(Mat.Copper)) {
      res.outOfStock = true;
      return;
    }
    world.setCell(x, y, Mat.Copper);
    onBlockEdited(world, x, y, existing, Mat.Copper);
    res.changedCount++;
    return;
  }

  const targetCat = MAT_CATEGORY[mat];
  const isSolidBrush =
    targetCat === MatCategory.Solid ||
    targetCat === MatCategory.Machine ||
    mat === Mat.VoltFern ||
    mat === Mat.Mushroom;

  if (
    !isSolidBrush &&
    existing !== Mat.Air &&
    existing !== Mat.Water &&
    existing !== Mat.BlightWater &&
    existing !== Mat.Steam &&
    existing !== Mat.Miasma
  ) {
    return;
  }

  // 固体ブラシも既存の硬岩や別固体を勝手に上書き消滅させないよう、空気・流体・気体・植物上のみ配置可とする
  if (
    isSolidBrush &&
    progression.mode === 'alchemist' &&
    existing !== Mat.Air &&
    existing !== Mat.Water &&
    existing !== Mat.BlightWater &&
    existing !== Mat.Steam &&
    existing !== Mat.Miasma &&
    existing !== Mat.Spore
  ) {
    return;
  }

  if (existing === mat) return;

  // ストック消費チェック（配置可能なセルに対してのみ消費）
  if (!progression.consumeForPlace(mat)) {
    res.outOfStock = true;
    return;
  }

  let initialMeta = 0;
  if (mat === Mat.VoltFern) initialMeta = 4;
  else if (mat === Mat.Steam || mat === Mat.Miasma) initialMeta = 150;
  else if (mat === Mat.Fire) initialMeta = 60;

  world.setCell(x, y, mat, initialMeta);
  onBlockEdited(world, x, y, existing, mat);
  res.changedCount++;
}

/**
 * 既存の単体テストおよび Cozy 無制限描画と完全互換のシンプルブラシ関数
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
      if (isScatter && radius >= 2 && Math.random() > 0.42) continue;
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

  if ((flags & FLAG_INDESTRUCTIBLE) !== 0) return false;
  if (isAlchemistMode && mat !== Mat.Air && (flags & FLAG_NO_BRUSH) !== 0) return false;

  if (mat === Mat.Air) {
    const prev = world.type[i] as MatId;
    const prevBg = world.bgType[i];
    if (
      prev === Mat.Air &&
      (prevBg === BgMat.None || prevBg === BgMat.CoreTree || prevBg === BgMat.StoneWall)
    ) {
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
  if (mat === Mat.Copper && existing === Mat.Wood) {
    world.setCell(x, y, Mat.Copper);
    onBlockEdited(world, x, y, existing, Mat.Copper);
    return true;
  }

  const targetCat = MAT_CATEGORY[mat];
  const isSolidBrush =
    targetCat === MatCategory.Solid ||
    targetCat === MatCategory.Machine ||
    mat === Mat.VoltFern ||
    mat === Mat.Mushroom;

  if (!isSolidBrush && existing !== Mat.Air && existing !== Mat.Water && existing !== Mat.Steam) {
    return false;
  }
  if (existing === mat) return false;

  let initialMeta = 0;
  if (mat === Mat.VoltFern) initialMeta = 4;
  else if (mat === Mat.Steam || mat === Mat.Miasma) initialMeta = 150;
  else if (mat === Mat.Fire) initialMeta = 60;

  world.setCell(x, y, mat, initialMeta);
  onBlockEdited(world, x, y, existing, mat);
  return true;
}
