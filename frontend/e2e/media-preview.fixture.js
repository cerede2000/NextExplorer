import { createApp } from 'vue';
import { createI18n } from 'vue-i18n';
import MediaPreview from '../src/plugins/preview/MediaPreview.vue';

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      mediaPreview: {
        close: 'Close preview',
        download: 'Download media',
        next: 'Next media',
        previous: 'Previous media',
        rotateLeft: 'Rotate left',
        rotateRight: 'Rotate right',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
      },
    },
  },
});

const media = [
  { name: 'first.jpg', kind: 'jpg', path: 'Test' },
  { name: 'clip.mp4', kind: 'mp4', path: 'Test' },
  { name: 'last.png', kind: 'png', path: 'Test' },
];

const previewUrls = {
  'first.jpg': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'clip.mp4': 'data:video/mp4;base64,',
  'last.png': 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
};

const item = media[0];
window.previewClosed = false;

const app = createApp(MediaPreview, {
  item,
  extension: item.kind,
  filePath: `${item.path}/${item.name}`,
  previewUrl: previewUrls[item.name],
  api: {
    close: () => {
      window.previewClosed = true;
    },
    download: () => {},
    getPreviewUrl: (target) => previewUrls[target.name],
    getSiblings: () => media,
  },
});

app.use(i18n);
app.mount('#app');
