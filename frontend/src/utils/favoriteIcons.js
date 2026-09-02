import * as OutlineIcons from '@heroicons/vue/24/outline';
import * as SolidIcons from '@heroicons/vue/24/solid';

/**
 * Favorite icons are stored as "<variant>:<IconName>", e.g. "outline:StarIcon".
 *
 * Resolution lives here rather than in each view: the sidebar, the home grid
 * and the edit dialog all render the same stored value, and a variant one of
 * them does not know about silently falls back to a star.
 */
const FAVORITE_ICON_VARIANTS = {
  outline: OutlineIcons,
  solid: SolidIcons,
};

/**
 * Map a stored variant onto a real one.
 *
 * "outline-solid" was written by an earlier version of the edit dialog; it
 * never matched a registry, so every icon saved that way renders as the
 * default star. Treat it as "outline" so those favorites come back.
 */
export const normalizeIconVariant = (variant) => {
  const key = String(variant || '').toLowerCase();
  if (key === 'outline-solid') return 'outline';
  return key;
};

export const resolveFavoriteIcon = (iconName) => {
  if (typeof iconName !== 'string') return OutlineIcons.StarIcon;

  const trimmed = iconName.trim();
  if (!trimmed) return OutlineIcons.StarIcon;

  if (trimmed.includes(':')) {
    const [variantRaw, iconRaw] = trimmed.split(':', 2);
    const registry = FAVORITE_ICON_VARIANTS[normalizeIconVariant(variantRaw)];
    const iconKey = iconRaw.trim();
    if (registry && registry[iconKey]) return registry[iconKey];
  }

  // Bare names (no variant) are accepted for backwards compatibility.
  return OutlineIcons[trimmed] || SolidIcons[trimmed] || OutlineIcons.StarIcon;
};
