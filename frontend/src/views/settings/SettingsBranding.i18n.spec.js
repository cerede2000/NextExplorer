import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { createI18n } from 'vue-i18n';

import fr from '@/i18n/locales/fr.json';

/**
 * The branding page as somebody who reads French sees it, through the real
 * catalogue and not a stand-in that echoes keys.
 *
 * Its confirmations and its messages about the chosen file were written in
 * English in the page itself, and some labels only reached the catalogue
 * through a fallback in English. Nothing here falls back: a key the French
 * catalogue lacks is recorded, and fails the test, rather than showing English.
 */

let appSettings;
let missing;
let wrapper;

vi.mock('@/stores/appSettings', () => ({ useAppSettings: () => appSettings }));

import SettingsBranding from './SettingsBranding.vue';

const STORED = {
  appName: 'Chez Benjy',
  appLogoUrl: '/static/logos/logo-0b7f7c1e-3d44-4c55-9a8e-1f2a3b4c5d6e.png',
  showPoweredBy: false,
};

const open = async () => {
  appSettings = reactive({
    state: { branding: STORED },
    save: vi.fn(async (partial) => {
      appSettings.state.branding = { ...appSettings.state.branding, ...partial.branding };
    }),
    saveLogo: vi.fn(),
  });
  const i18n = createI18n({
    legacy: false,
    locale: 'fr',
    fallbackLocale: false,
    messages: { fr },
    missingWarn: false,
    fallbackWarn: false,
    missing: (_locale, key) => {
      missing.push(key);
    },
  });
  wrapper = mount(SettingsBranding, { global: { plugins: [i18n] } });
  await flushPromises();
};

const chooseLogo = async (file) => {
  const input = wrapper.get('input[type="file"]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
};

const message = () => wrapper.get('.rounded-md.border.p-4').text();

beforeEach(() => {
  missing = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  expect(missing).toEqual([]);
  wrapper?.unmount();
  vi.unstubAllGlobals();
});

describe('the branding page in French', () => {
  it('labels everything from the catalogue, the logo’s description included', async () => {
    await open();

    const text = wrapper.text();
    expect(text).toContain('Identité visuelle');
    expect(text).toContain('Nom de l’application');
    expect(text).toContain('Choisir un autre fichier');
    expect(text).toContain('Afficher le lien d’attribution');
    expect(wrapper.get('img').attributes('alt')).toBe('Logo de Chez Benjy');
  });

  it('confirms a save in French', async () => {
    await open();

    await wrapper.get('input[type="text"]').setValue('Fichiers');
    await wrapper.get('[data-test="branding-save"]').trigger('click');
    await flushPromises();

    expect(message()).toBe('Identité visuelle enregistrée.');
  });

  it('reports a refused save in French, with the reason the server gave', async () => {
    await open();
    appSettings.saveLogo.mockRejectedValueOnce(new Error('A logo can be at most 2 MB.'));

    await chooseLogo(new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(message()).toBe('Nouveau logo sélectionné. Cliquez sur Enregistrer pour l’appliquer.');
    await wrapper.get('[data-test="branding-save"]').trigger('click');
    await flushPromises();

    expect(message()).toBe(
      'Impossible d’enregistrer l’identité visuelle : A logo can be at most 2 MB.'
    );
  });

  it('refuses a file, and an empty name, in French', async () => {
    await open();

    await chooseLogo(new File(['gif'], 'logo.gif', { type: 'image/gif' }));
    expect(message()).toBe('Veuillez téléverser un fichier SVG, PNG ou JPG');

    await chooseLogo(
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })
    );
    expect(message()).toBe('Le fichier doit faire moins de 2 Mo');

    await wrapper.get('input[type="text"]').setValue(' ');
    expect(wrapper.get('[data-test="branding-name-invalid"]').text()).toBe(
      'Le nom de l’application ne peut pas être vide.'
    );
  });

  it('says in French that the default logo will be used', async () => {
    await open();

    await wrapper
      .findAll('button')
      .find((item) => item.attributes('title') === 'Retirer')
      .trigger('click');

    expect(message()).toBe('Logo par défaut sélectionné. Cliquez sur Enregistrer pour appliquer.');
    expect(wrapper.text()).toContain('Choisir un logo');
  });
});
