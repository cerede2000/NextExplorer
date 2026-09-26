import DefaultTheme from 'vitepress/theme';
import ApiExplorer from './ApiExplorer.vue';
import ApiSchema from './ApiSchema.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ApiExplorer', ApiExplorer);
    // Registered by name as well, because it opens itself for nested shapes.
    app.component('ApiSchema', ApiSchema);
  },
};
