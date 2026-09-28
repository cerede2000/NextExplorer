import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  Teleport,
} from 'vue';
import { createPinia } from 'pinia';
import { createI18n } from 'vue-i18n';

// The application's stylesheet, without which none of this is what the browser
// actually lays out — and, more to the point, without which the fade that this
// fixture exists to provoke does not exist.
import '../src/assets/main.css';
import en from '../src/i18n/locales/en.json';
import PreviewHost from '../src/plugins/preview/PreviewHost.vue';
import { usePreviewManager } from '../src/plugins/preview/manager';
import { useTabsStore } from '../src/stores/tabs';

/**
 * A viewer that takes its own element out of the page, in a real browser.
 *
 * ONLYOFFICE does this: the Document Server's script is handed an element and
 * replaces it with an `iframe`, so the node Vue believes it owns is no longer in
 * the document. Everything that goes wrong afterwards goes wrong inside Vue's
 * patch — it looks for that node's parent and finds none — and none of it can be
 * seen in a unit test, because jsdom reports no transition support: a leave that
 * a real browser spreads over two hundred milliseconds happens there at once, so
 * the shutting document is never still in the page while the next is built.
 *
 * Hence a fixture. The page is driven from the spec through the functions on
 * `window`, and everything the page throws is collected on `window.thrown`.
 */

window.thrown = [];
window.addEventListener('error', (event) => window.thrown.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) =>
  window.thrown.push(String(event.reason?.message || event.reason))
);

/** The element the script replaces, as `<DocumentEditor>` renders it. */
const DocumentEditor = defineComponent({
  name: 'DocumentEditor',
  props: { config: { type: Object, required: true } },
  setup(props) {
    const host = ref(null);
    let frame = null;
    onMounted(() => {
      frame = document.createElement('iframe');
      frame.className = 'h-full w-full';
      frame.dataset.document = props.config.document;
      host.value?.replaceWith(frame);
    });
    // `destroyEditor`, which the real component calls on its way out: the script
    // put the frame there, so the script takes it away. Vue cannot — what it
    // holds is the element that was replaced.
    onBeforeUnmount(() => {
      frame?.remove();
      frame = null;
    });
    return () => h('div', { ref: host, class: 'h-full w-full' }, 'the editor');
  },
});

/** Set by the viewer, so the spec can make it rebuild where it stands. */
let rebuild = async () => {};

/** The plugin's component, shaped like `OnlyOfficePreview.vue`. */
const OfficeViewer = defineComponent({
  name: 'OfficeViewer',
  props: {
    item: { type: Object, required: true },
    extension: { type: String, default: '' },
    filePath: { type: String, default: '' },
    previewUrl: { type: String, default: '' },
    previewState: { type: Object, default: () => ({}) },
    api: { type: Object, default: () => ({}) },
  },
  setup(props) {
    const { previewState } = props;
    const config = ref(null);
    onMounted(async () => {
      // The configuration is fetched, so the editor is always a tick behind.
      await Promise.resolve();
      config.value = { document: props.filePath };
      await nextTick();
      // And once the document is open the editor draws its own close button,
      // which takes the page's fallback one away.
      Object.assign(previewState, { hasNativeClose: true });
    });
    // What `load({ inPlace: false })` does: the configuration is cleared, so the
    // editor on screen is taken off by that very render, and another is built
    // once the answer comes back. A rename from the title bar does it, and so
    // does a document the server reports as outdated.
    rebuild = async () => {
      config.value = null;
      await nextTick();
      config.value = { document: `${props.filePath}#again` };
      await nextTick();
    };

    return () =>
      h('div', { class: 'h-full w-full bg-white' }, [
        config.value
          ? h(DocumentEditor, { key: props.filePath, config: config.value })
          : h('div', 'Loading the editor…'),
        // The dialogs the editor opens — sharing, and the picker it asks for a
        // file with. They teleport to the body and are siblings of the element
        // the editor took away.
        h(Teleport, { to: 'body' }, [h('div', { class: 'share-dialog' })]),
        h(Teleport, { to: 'body' }, [h('div', { class: 'picker-dialog' })]),
      ]);
  },
});

const pinia = createPinia();
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const app = createApp({ render: () => h(PreviewHost) });
app.config.errorHandler = (error) => window.thrown.push(String(error?.message || error));
app.use(pinia).use(i18n).mount('#app');

const manager = usePreviewManager(pinia);
const tabs = useTabsStore(pinia);

manager.register({
  id: 'office',
  minimalHeader: true,
  match: () => true,
  component: () => Promise.resolve({ default: OfficeViewer }),
});

tabs.setEnabled(true);
// Two tabs, so a document can be opened in one while another is in front.
const second = tabs.open('/browse/Second', { activate: false });
const ids = [tabs.tabs[0].id, second.id];

window.tabsOpen = () => ids.length;
window.openDocument = (which, name) =>
  manager.openIn(ids[which], { name, path: 'Docs', kind: 'docx' });
window.closeDocument = (which) => manager.closeIn(ids[which]);
window.activateTab = (which) => tabs.activate(ids[which]);
window.closeTab = (which) => tabs.close(ids[which]);
window.moveTab = (which, to) => tabs.move(ids[which], to);
window.newTab = () => {
  const made = tabs.open('/browse/Another', { activate: false });
  ids.push(made.id);
  return ids.length - 1;
};
window.rebuildEditor = () => rebuild();
window.frames_ = () => document.querySelectorAll('iframe[data-document]').length;
