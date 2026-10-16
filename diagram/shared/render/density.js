export const DENSITIES = {
  compact: { gap: 20, pad: 12 },
  normal: { gap: 28, pad: 16 },
  airy: { gap: 40, pad: 22 },
};

export function getDensity(name) {
  return DENSITIES[name] ?? DENSITIES.normal;
}
