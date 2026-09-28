import { createApp, h } from 'vue';
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
// What the page said to the console, which is where the Document Server's script
// explains itself — "Skip loading. Instance already exists" above all.
window.logged = [];
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    window.logged.push(`${level}: ${args.map((one) => String(one)).join(' ')}`);
    original(...args);
  };
}
window.addEventListener('error', (event) => window.thrown.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) =>
  window.thrown.push(String(event.reason?.message || event.reason))
);
// The stack as well, for the probe: the dev server serves this unminified, which
// is the only place the frames have names.
window.stacks = [];
window.addEventListener('unhandledrejection', (event) =>
  window.stacks.push(String(event.reason?.stack || ''))
);

/**
 * The server this page answers for itself.
 *
 * Everything the real ONLYOFFICE preview asks of the backend, answered here, so
 * the component under test is the real one — its own `v-if` chain, its own
 * `editorId` churn, its own teleported dialogs — and the only thing standing in
 * for the Document Server is the script at `docs-server/`, which does what that
 * script does: it takes the element it is handed out of the page.
 */
const onlyofficeConfig = (path) => ({
  documentServerUrl: `${window.location.origin}/e2e/docs-server/`,
  forceSaveSessionId: 'session-1',
  config: {
    document: { key: path, title: path.split('/').pop(), fileType: 'docx', url: 'about:blank' },
    documentType: 'word',
    editorConfig: { lang: 'en', mode: 'edit' },
  },
});

const answers = [
  [/\/api\/onlyoffice\/config/, (body) => onlyofficeConfig(body?.path || 'Docs/report.docx')],
  [/\/api\/onlyoffice\/session/, () => ({ active: true })],
  [/\/api\/onlyoffice\//, () => ({})],
  [/\/api\/features/, () => ({ versionsEnabled: false, onlyofficeEnabled: true })],
  [/\/api\//, () => ({})],
];

const realFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const match = answers.find(([pattern]) => pattern.test(url));
  if (!match) return realFetch(input, init);
  let body;
  try {
    body = init.body ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  return Promise.resolve(
    new Response(JSON.stringify(match[1](body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
};

const pinia = createPinia();
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } });
const app = createApp({ render: () => h(PreviewHost) });
app.config.errorHandler = (error, instance, info) => {
  window.thrown.push(String(error?.message || error));
  window.stacks.push(`${info}\n${error?.stack || ''}`);
};
app.use(pinia).use(i18n).mount('#app');

const manager = usePreviewManager(pinia);
const tabs = useTabsStore(pinia);

manager.register({
  id: 'onlyoffice',
  minimalHeader: true,
  match: () => true,
  component: () => import('../src/plugins/onlyoffice/OnlyOfficePreview.vue'),
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
window.frames_ = () => document.querySelectorAll('iframe[data-document]').length;
