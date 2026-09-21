import { afterEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import i18n from '@/i18n';
import { useDeleteDialogWording } from './deleteDialogWording';

/**
 * The warning about a document open in ONLYOFFICE, read with the real
 * catalogues. It was a French sentence written into the component, shown in
 * French whatever the language of the page — which only a test that reads the
 * catalogues, rather than one that mocks `t`, could have said.
 */

const previous = i18n.global.locale.value;
afterEach(() => {
  i18n.global.locale.value = previous;
});

const warningFor = (names, locale) => {
  i18n.global.locale.value = locale;
  const wording = useDeleteDialogWording({
    t: i18n.global.t,
    featuresStore: {},
    confirm: {
      pendingDeleteItems: ref(
        names.map((name) => ({ name, path: 'Docs', onlyofficeActivity: { active: true } }))
      ),
      trashPlan: ref(null),
      isLoadingDeleteImpact: ref(false),
      deleteImpact: ref(null),
      keptItems: ref([]),
    },
  });
  return wording.deleteOnlyOfficeActivityMessage.value;
};

describe('a document open in ONLYOFFICE, about to be deleted', () => {
  it('is said in the language of the page', () => {
    expect(warningFor(['report.docx'], 'en')).toBe(
      'report.docx is open in OnlyOffice. It can still be deleted, but changes not yet saved there may be lost.'
    );
    expect(warningFor(['report.docx'], 'fr')).toContain('est ouvert dans OnlyOffice');
    expect(warningFor(['report.docx'], 'de')).toContain('ist in OnlyOffice geöffnet');
  });

  it('agrees with how many there are', () => {
    expect(warningFor(['a.docx', 'b.docx'], 'en')).toMatch(/^a\.docx, b\.docx are open/);
    expect(warningFor(['a.docx', 'b.docx', 'c.docx', 'd.docx'], 'en')).toMatch(
      /^a\.docx, b\.docx and 2 more are open/
    );
  });

  // Polish has three forms, and the catalogue gives it all three.
  it('takes the right one of three forms in Polish', () => {
    expect(warningFor(['a.docx'], 'pl')).toContain('jest otwarty');
    expect(warningFor(['a', 'b', 'c'], 'pl')).toContain('są otwarte');
    expect(warningFor(['a', 'b', 'c', 'd', 'e'], 'pl')).toContain('jest otwartych');
  });

  it('says nothing when none of them is open', () => {
    expect(warningFor([], 'en')).toBe('');
  });
});
