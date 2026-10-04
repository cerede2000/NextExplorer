import { describe, it, expect } from 'vitest';
import { DEFAULT_LOGO_URL, brandingLogoSrc } from './brandingLogo.js';

describe('the logo an instance draws', () => {
  /**
   * `/logo.svg` is what every installation made before this has written down,
   * and what the server still answers with when nobody chose a logo. It names
   * which logo, not where the bytes are.
   */
  it('serves the one we ship from under the build prefix', () => {
    expect(DEFAULT_LOGO_URL).toBe('/assets/logo.svg');
    expect(brandingLogoSrc('/logo.svg')).toBe(DEFAULT_LOGO_URL);
    expect(brandingLogoSrc('')).toBe(DEFAULT_LOGO_URL);
    expect(brandingLogoSrc(null)).toBe(DEFAULT_LOGO_URL);
    expect(brandingLogoSrc('   ')).toBe(DEFAULT_LOGO_URL);
  });

  it('leaves a logo somebody chose where it is', () => {
    expect(brandingLogoSrc('/static/logos/logo-abc.png')).toBe('/static/logos/logo-abc.png');
    expect(brandingLogoSrc('https://example.test/mark.svg')).toBe('https://example.test/mark.svg');
  });
});
