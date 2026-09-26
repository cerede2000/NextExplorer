/**
 * Whom an access rule holds — the one place that decides it.
 *
 * Kept apart from both the settings service, which stores the rules, and the
 * access control service, which resolves them: each needs the answer, and one
 * requiring the other would close a circle. It has no dependency of its own.
 */

/**
 * Whether a rule holds administrators.
 *
 * A rule says so itself. One stored before it could — every rule an upgrade
 * finds — is read as what it did then: a hidden rule hid the folder from
 * everybody, a read-only rule left administrators free to write. So an upgrade
 * changes nothing until somebody says otherwise on the settings page.
 */
const ruleAppliesToAdmins = (rule) =>
  typeof rule?.appliesToAdmins === 'boolean'
    ? rule.appliesToAdmins
    : (rule?.permissions || 'rw') === 'hidden';

module.exports = { ruleAppliesToAdmins };
