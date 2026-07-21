const pty = require('@homebridge/node-pty-prebuilt-multiarch');

const [archivePath, outputPath, password] = process.argv.slice(2);
if (!archivePath || !outputPath || password === undefined) {
  process.exitCode = 2;
  throw new Error('Expected archive path, output path, and password.');
}

const child = pty.spawn('7z', ['x', '-y', '-p', `-o${outputPath}`, archivePath], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let output = '';
let passwordWritten = false;
const timeout = setTimeout(() => {
  child.kill('SIGKILL');
  throw new Error('Timed out waiting for 7-Zip password prompt.');
}, 10_000);

child.onData((chunk) => {
  output = `${output}${chunk}`.slice(-2000);
  if (!passwordWritten && /enter password/i.test(output)) {
    passwordWritten = true;
    child.write(`${password}\r`);
  }
});

child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode !== 0 || !passwordWritten) {
    process.stderr.write(output);
    process.exit(exitCode || 1);
  }
});
