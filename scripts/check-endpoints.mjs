// Un lot peut se construire, demarrer, et rendre une 404 a l'utilisateur : il
// suffit qu'il livre l'appel client sans la route qui y repond. Ni le bundler
// ni le chargement des modules ne voient ca. Ce controle compare les deux.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

// --- cote serveur : tout chemin litteral passe a router.METHOD(...) ---
const METHOD = /\brouter\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\2/g;
const serverPaths = new Set();
for (const f of walk(path.join(ROOT, 'backend', 'src', 'routes'))) {
  if (!f.endsWith('.js')) continue;
  for (const m of fs.readFileSync(f, 'utf8').matchAll(METHOD)) serverPaths.add(m[3]);
}

// Un parametre mange un segment, un joker mange le reste. Les marqueurs sont
// du texte ordinaire : un caractere de controle rendrait ce fichier binaire
// pour git, ce qui nous a deja coute une journee.
const WILD = 'ZWILDZ';
const SEG = 'ZSEGZ';
const toRegex = (p) => {
  const marked = p
    .replace(/\{\*[^}]*\}/g, WILD)
    .replace(/\*[a-zA-Z]*/g, WILD)
    .replace(/:[A-Za-z0-9_]+/g, SEG);
  const escaped = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.split(WILD).join('.*').split(SEG).join('[^/]+') + '$');
};
const serverRegexes = [...serverPaths].map((p) => ({ p, re: toRegex(p) }));

// --- cote client : tout litteral /api/... ecrit dans le frontend ---
const MOUNTS = ['/api/auth', '/api/shares', '/api/share', '/api'];
const CALL = /['"`](\/api\/[^'"`$?]*)/g;
const missing = new Map();
for (const f of walk(path.join(ROOT, 'frontend', 'src'))) {
  if (!/\.(js|vue|ts)$/.test(f)) continue;
  if (/\.spec\.js$/.test(f)) continue; // un test peut nommer une route qu'il simule
  for (const m of fs.readFileSync(f, 'utf8').matchAll(CALL)) {
    const endpoint = m[1].replace(/\/+$/, '');
    const mount = MOUNTS.find((p) => endpoint === p || endpoint.startsWith(p + '/'));
    if (!mount) continue;
    const suffix = endpoint.slice(mount.length) || '/';
    // Le litteral peut n'etre qu'un prefixe, le reste venant d'un template :
    // une route dont le debut correspond suffit donc a le servir.
    const served = serverRegexes.some(
      ({ p, re }) => re.test(suffix) || p.startsWith(suffix) || re.test(suffix + '/x')
    );
    if (!served) {
      if (!missing.has(endpoint)) missing.set(endpoint, new Set());
      missing.get(endpoint).add(path.relative(ROOT, f));
    }
  }
}

console.log('routes serveur declarees : ' + serverPaths.size);
if (!missing.size) {
  console.log('Aucun appel client sans route.');
  process.exit(0);
}
for (const [endpoint, files] of missing) {
  console.log('  x ' + endpoint);
  console.log('      appele par ' + [...files].join(', '));
}
console.log('\n' + missing.size + ' endpoint(s) appele(s) mais non servi(s).');
process.exit(1);
