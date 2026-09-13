export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Keeps an existing pet anchor when it is still meaningfully visible. If a monitor was unplugged
 * and the pet is entirely stranded, moves it fully inside the nearest remaining work area.
 */
export function recoverPositionToWorkAreas(
  pos: { x: number; y: number },
  width: number,
  height: number,
  areas: WorkArea[],
): { x: number; y: number } {
  if (areas.length === 0) return pos;
  const minVisibleX = Math.min(48, width);
  const minVisibleY = Math.min(48, height);
  const visible = areas.some((area) => {
    const intersectionWidth = Math.max(0, Math.min(pos.x + width, area.x + area.width) - Math.max(pos.x, area.x));
    const intersectionHeight = Math.max(0, Math.min(pos.y + height, area.y + area.height) - Math.max(pos.y, area.y));
    return intersectionWidth >= minVisibleX && intersectionHeight >= minVisibleY;
  });
  if (visible) return pos;

  const center = { x: pos.x + width / 2, y: pos.y + height / 2 };
  const nearest = areas.reduce((best, area) => {
    const ax = Math.max(area.x, Math.min(center.x, area.x + area.width));
    const ay = Math.max(area.y, Math.min(center.y, area.y + area.height));
    const distance = (center.x - ax) ** 2 + (center.y - ay) ** 2;
    return distance < best.distance ? { area, distance } : best;
  }, { area: areas[0], distance: Number.POSITIVE_INFINITY }).area;
  return {
    x: Math.round(Math.max(nearest.x, Math.min(pos.x, nearest.x + Math.max(0, nearest.width - width)))),
    y: Math.round(Math.max(nearest.y, Math.min(pos.y, nearest.y + Math.max(0, nearest.height - height)))),
  };
}
