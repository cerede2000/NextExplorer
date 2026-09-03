import { createApp } from 'vue';

// The application's stylesheet, without which none of this component's classes
// exist. An unstyled page lays every element out at its natural size and
// contains it trivially, so a layout assertion against one passes whatever the
// markup says — which is exactly how the first version of the containment test
// came to agree with the defect it was written to catch.
import '../src/assets/main.css';
import MediaPreview from '../src/plugins/preview/MediaPreview.vue';

import { createI18n } from 'vue-i18n';
import en from '../src/i18n/locales/en.json';

/**
 * The component reads its labels through vue-i18n, so the fixture has to
 * install it. Without this the setup function throws "Need to install with
 * app.use function", nothing mounts, and every assertion below fails on a
 * missing element rather than on what it meant to check — which is how this
 * whole fixture came to be silently broken.
 */
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });


const media = [
  { name: 'first.jpg', kind: 'jpg', path: 'Test' },
  { name: 'clip.mp4', kind: 'mp4', path: 'Test' },
  { name: 'last.png', kind: 'png', path: 'Test' },
];

const previewUrls = {
  'first.jpg':
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'clip.mp4': 'data:video/mp4;base64,',
  'last.png':
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
};

const item = media[0];

createApp(MediaPreview, {
  item,
  extension: item.kind,
  filePath: `${item.path}/${item.name}`,
  previewUrl: previewUrls[item.name],
  api: {
    close: () => {},
    download: () => {},
    getPreviewUrl: (target) => previewUrls[target.name],
    getSiblings: () => media,
  },
}).use(i18n).mount('#app');
