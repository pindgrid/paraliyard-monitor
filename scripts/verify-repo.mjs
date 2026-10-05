// Read-only repository guard. It only reads files and never deploys,
// installs or calls any network service. Exits non-zero on any violation.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", ".firebase"]);
const TEXT_EXT = /\.(ts|js|mjs|cjs|json|html|css|map|txt|md)$/i;

const errors = [];
const fail = (msg) => errors.push(msg);
const rel = (p) => relative(ROOT, p).split(sep).join("/");

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// 1. Forbidden files anywhere in the repo (deploy config, env files, keys).
const FORBIDDEN_FILES = [
  [/^firebase\.json$/i, "firebase.json"],
  [/^\.firebaserc$/i, ".firebaserc"],
  [/^\.env(?!\.example$)/i, "env file"],
  [/\.(pem|p12|key)$/i, "key file"],
  [/^service-account.*\.json$/i, "service-account file"],
  [/-sa\.json$/i, "service-account file"],
  [/credentials.*\.json$/i, "credentials file"],
  [/(-key|\.key)\.json$/i, "key file"],
  [/^gha-creds-.*\.json$/i, "credentials file"],
  [/^deploy(\.|-|_)/i, "deploy script"],
];

const allFiles = walk(ROOT);
for (const file of allFiles) {
  const name = basename(file);
  for (const [pattern, label] of FORBIDDEN_FILES) {
    if (pattern.test(name)) fail(`forbidden ${label}: ${rel(file)}`);
  }
}

// 2. Secrets in any text file we own (excluding this script's own patterns).
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/"type"\s*:\s*"service_account"/, "service-account JSON"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
];
for (const file of allFiles) {
  if (file === SELF || !TEXT_EXT.test(file) || /package-lock\.json$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) fail(`${label} found in ${rel(file)}`);
  }
}

// 3. Frontend source and build: no Firebase SDK, auth or Google sign-in.
const FRONTEND_FORBIDDEN = [
  [/(from\s*|import\s*\(\s*|require\s*\(\s*)["']firebase/, "firebase SDK import"],
  [/firebase\/auth/, "'firebase/auth'"],
  [/firebase\/app/, "'firebase/app'"],
  [/GoogleAuthProvider|signInWithPopup|signInWithRedirect/, "Google sign-in"],
  [/accounts\.google\.com|apis\.google\.com|gapi\.auth/, "Google sign-in script"],
  [/apiKey\s*[:=]/, "API key field"],
];
const frontendFiles = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "dist"))].filter((f) =>
  TEXT_EXT.test(f),
);
for (const file of frontendFiles) {
  const text = readFileSync(file, "utf8");
  for (const [pattern, label] of FRONTEND_FORBIDDEN) {
    if (pattern.test(text)) fail(`${label} found in ${rel(file)}`);
  }
}

// 4. Functions source: no admin SDK or direct data-store clients.
const FUNCTIONS_FORBIDDEN = ["firebase-admin", "@google-cloud/firestore", "@google-cloud/storage"];
const functionsSource = [join(ROOT, "functions", "index.js"), ...walk(join(ROOT, "functions", "src"))]
  .filter((f) => existsSync(f) && TEXT_EXT.test(f));
for (const file of functionsSource) {
  const text = readFileSync(file, "utf8");
  for (const name of FUNCTIONS_FORBIDDEN) {
    if (text.includes(name)) fail(`'${name}' referenced in ${rel(file)}`);
  }
}

// 5. Build output: single dist folder with index.html and mock-mode config.
const distIndex = join(ROOT, "dist", "index.html");
const distConfig = join(ROOT, "dist", "config.json");
if (!existsSync(distIndex)) fail("dist/index.html missing (run npm run build first)");
if (!existsSync(distConfig)) {
  fail("dist/config.json missing (run npm run build first)");
} else {
  try {
    const config = JSON.parse(readFileSync(distConfig, "utf8"));
    if (config.mode !== "mock") fail(`dist/config.json mode is "${config.mode}", expected "mock"`);
  } catch {
    fail("dist/config.json is not valid JSON");
  }
}

// 5a. Built page: no script or stylesheet tags loading from another host.
if (existsSync(distIndex)) {
  const html = readFileSync(distIndex, "utf8");
  const EXTERNAL_TAGS = [
    [/<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i, "<script src>"],
    [/<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i, "<link href>"],
  ];
  for (const [pattern, label] of EXTERNAL_TAGS) {
    if (pattern.test(html)) fail(`dist/index.html has an external ${label}`);
  }
}

// 5b. Root runtime dependencies (bundled into the site) must be MIT or Apache-2.0.
// Font packages from the Fontsource scopes may also be OFL-1.1 (nothing else may).
const ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0"]);
const OFL_LICENSE = "OFL-1.1";
const OFL_SCOPES = ["@fontsource/", "@fontsource-variable/"];
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const name of Object.keys(rootPkg.dependencies || {})) {
  const depPkgPath = join(ROOT, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(depPkgPath)) {
    fail(`dependency ${name} is not installed (run npm ci first)`);
    continue;
  }
  const license = JSON.parse(readFileSync(depPkgPath, "utf8")).license;
  const oflFont = license === OFL_LICENSE && OFL_SCOPES.some((scope) => name.startsWith(scope));
  if (!ALLOWED_LICENSES.has(license) && !oflFont) {
    fail(
      `dependency ${name} has license ${JSON.stringify(license)}, expected MIT or Apache-2.0 ` +
        `(OFL-1.1 only for ${OFL_SCOPES.join(" or ")} packages)`,
    );
  }
}

// 5c. Built HTML and CSS: no font CDNs, script CDNs or remote url()/@import.
const EXTERNAL_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"];
const ALLOWED_URLS = ["http://www.w3.org/2000/svg"];
const builtPages = [
  ...walk(join(ROOT, "dist")).filter((f) => /\.html$/i.test(f) && relative(join(ROOT, "dist"), f) === basename(f)),
  ...walk(join(ROOT, "dist", "assets")).filter((f) => /\.css$/i.test(f)),
];
for (const file of builtPages) {
  let text = readFileSync(file, "utf8");
  for (const allowed of ALLOWED_URLS) text = text.split(allowed).join("");
  for (const host of EXTERNAL_HOSTS) {
    if (text.includes(host)) fail(`${rel(file)} references ${host}`);
  }
  if (/url\(\s*["']?\s*https?:/i.test(text)) fail(`${rel(file)} has a url() pointing at another host`);
  if (/@import\s+(url\(\s*)?["']?\s*https?:/i.test(text)) fail(`${rel(file)} has an @import from another host`);
}

// 6. functions/package.json rules.
const fnPkgPath = join(ROOT, "functions", "package.json");
if (!existsSync(fnPkgPath)) {
  fail("functions/package.json missing");
} else {
  const fnPkg = JSON.parse(readFileSync(fnPkgPath, "utf8"));
  if (fnPkg.engines?.node !== "22") fail('functions/package.json engines.node must be "22"');
  if (fnPkg.main !== "index.js") fail('functions/package.json main must be "index.js"');
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of FUNCTIONS_FORBIDDEN) {
      if (fnPkg[field]?.[name]) fail(`functions/package.json ${field} must not include ${name}`);
    }
    // Local links (e.g. "file:..") would not exist in the deployed functions source.
    for (const [name, spec] of Object.entries(fnPkg[field] || {})) {
      if (/^(file|link):/.test(spec)) fail(`functions/package.json ${field}.${name} is a local link (${spec})`);
    }
  }
}
const fnLockPath = join(ROOT, "functions", "package-lock.json");
if (!existsSync(fnLockPath)) {
  fail("functions/package-lock.json missing");
} else {
  const fnLock = JSON.parse(readFileSync(fnLockPath, "utf8"));
  for (const [key, entry] of Object.entries(fnLock.packages || {})) {
    if (key.startsWith("..") || entry.link) fail(`functions/package-lock.json has a local link entry: "${key}"`);
  }
}

if (errors.length > 0) {
  console.error(`verify-repo: ${errors.length} problem(s):`);
  for (const msg of errors) console.error(`  - ${msg}`);
  process.exit(1);
}
console.log("verify-repo: OK");
