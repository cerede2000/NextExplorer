// Decode a HEIC the way the thumbnail service does — ffmpeg to PNG, then sharp
// — and print the colour near each side, as "R G B R G B", left then right.
//
// The image build runs this against the FFmpeg package installed for its
// target architecture. PNG keeps the check aligned with the thumbnail service.
//
// Usage: node check-heic.cjs <file.heic> [video filter]
// The filter defaults to the service's reduction; another one (hflip, a crop)
// is how the check was shown to catch a flipped or partial decode.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createRequire } = require('node:module');

// sharp is resolved from the working directory, /app in the image, rather than
// from wherever this file happens to be mounted.
const sharp = createRequire(path.join(process.cwd(), 'index.js'))('sharp');

const [source, filter = 'scale=64:-1:flags=lanczos'] = process.argv.slice(2);
if (!source) {
  console.error('usage: node check-heic.cjs <file.heic> [video filter]');
  process.exit(2);
}

const ffmpeg = spawn(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    source,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    filter,
    '-vcodec',
    'png',
    '-f',
    'image2pipe',
    'pipe:1',
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] }
);

const chunks = [];
ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
ffmpeg.on('error', (error) => {
  console.error(`ffmpeg could not be started: ${error.message}`);
  process.exit(1);
});
ffmpeg.on('close', async (code) => {
  if (code !== 0) {
    console.error(`ffmpeg exited with ${code}`);
    process.exit(1);
  }
  const { data, info } = await sharp(Buffer.concat(chunks))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x) => {
    const i = (Math.floor(info.height / 2) * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };
  console.log([...at(6), ...at(info.width - 6)].join(' '));
});
