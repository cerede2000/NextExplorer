const { normalizeRelativePath } = require('../utils/pathUtils');
const { getSettings, setSettings } = require('../services/settingsService');
const { ruleAppliesToAdmins } = require('../utils/accessRules');

/**
 * Whether this rule binds the caller.
 *
 * An administrator used to sit outside read-only rules and inside hidden ones,
 * which is neither and was written nowhere: a read-only rule left the Create
 * button on a folder for them and they wrote into it, while a hidden rule took
 * a folder away from the one account meant to manage it, with no way to say
 * otherwise. It is one switch now, the same whatever the rule grants.
 */
const heldTo = (rule, { isAdmin, applyToAdmins }) => {
  if (!isAdmin) return true;
  if (applyToAdmins) return true;
  return ruleAppliesToAdmins(rule);
};

/**
 * The rules, as a question that can be asked many times without reading them
 * again.
 *
 * @param {{rules?: Array<object>, applyToAdmins?: boolean}} access the access
 *   section, rules and the setting above them together — not the rules alone,
 *   because whom a rule holds is decided by both.
 * @returns {(relativePath: string, who?: {isAdmin?: boolean}) => 'rw'|'ro'|'hidden'}
 */
const createPermissionResolver = (access = {}) => {
  const normalizedRules = Array.isArray(access?.rules) ? access.rules : [];
  const applyToAdmins = access?.applyToAdmins === true;

  return (relativePath, who = {}) => {
    const rel = normalizeRelativePath(relativePath || '');
    const isAdmin = who?.isAdmin === true;

    // first match wins
    for (const rule of normalizedRules) {
      const rulePath = normalizeRelativePath(rule.path || '');
      if (!rulePath) continue;
      // A rule that does not hold this caller does not stand in the way of a
      // later one either: it is passed over, not matched and waived.
      if (!heldTo(rule, { isAdmin, applyToAdmins })) continue;

      if (rule.recursive) {
        if (rel === rulePath || rel.startsWith(rulePath + '/')) {
          return rule.permissions || 'rw';
        }
      } else {
        if (rel === rulePath) {
          return rule.permissions || 'rw';
        }
      }
    }

    return 'rw';
  };
};

// Determine permission for a given relative path: 'rw' | 'ro' | 'hidden'
const getPermissionForPath = async (relativePath, who) => {
  const settings = await getSettings();
  return createPermissionResolver(settings?.access)(relativePath, who);
};

const getRules = async () => {
  const settings = await getSettings();
  return Array.isArray(settings?.access?.rules) ? settings.access.rules : [];
};

const setRules = async (rules) => {
  const next = await setSettings({
    access: {
      rules: Array.isArray(rules) ? rules : [],
    },
  });
  return next.access.rules;
};

module.exports = {
  createPermissionResolver,
  getPermissionForPath,
  getRules,
  setRules,
};
