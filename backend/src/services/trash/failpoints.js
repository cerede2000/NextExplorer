/**
 * Named places where a test can make the trash fail on purpose.
 *
 * Every operation writes its intent, touches the disk, then confirms. The claim
 * is that a crash between any two of those steps leaves something the recovery
 * finishes or undoes — never a file without a record, never a record without a
 * file. A claim like that is only as good as the crashes it has survived, so
 * each step boundary is named here, and the suites stop the operation at each
 * one in turn.
 *
 * A simulated crash is an error the operations do not catch: they undo what
 * they started when something fails, and a process that died would not have
 * had the chance. Failpoints sit outside those undo blocks for that reason.
 *
 * Empty in production: `hit` finds nothing registered and returns.
 */
const points = new Map();

const hit = async (name, detail) => {
  const action = points.get(name);
  if (action) await action(detail);
};

const set = (name, action) => {
  points.set(name, action);
};

const clear = () => {
  points.clear();
};

/** An action that stops the operation where it stands, as a crash would. */
const crash = (name = 'failpoint') => {
  const error = new Error(`Simulated crash at ${name}`);
  error.simulatedCrash = true;
  throw error;
};

module.exports = { hit, set, clear, crash };
