import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

/** The sidebar's way into the trash. */

const push = vi.fn();
let routeName = 'HomeView';

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({
    get name() {
      return routeName;
    },
  }),
}));
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key) => key }) }));

import TrashMenu from './TrashMenu.vue';

beforeEach(() => {
  push.mockReset();
  routeName = 'HomeView';
});

describe('the trash entry in the sidebar', () => {
  it('opens the trash', async () => {
    const wrapper = mount(TrashMenu);

    await wrapper.get('[data-test="trash-menu"]').trigger('click');

    expect(push).toHaveBeenCalledWith({ name: 'Trash' });
    expect(wrapper.text()).toContain('trash.menu');
  });

  it('says it is the current page while the trash is open', () => {
    routeName = 'Trash';

    const wrapper = mount(TrashMenu);

    expect(wrapper.get('[data-test="trash-menu"]').attributes('aria-current')).toBe('page');
  });

  it('does not claim to be the current page elsewhere', () => {
    const wrapper = mount(TrashMenu);

    expect(wrapper.get('[data-test="trash-menu"]').attributes('aria-current')).toBeUndefined();
  });
});
