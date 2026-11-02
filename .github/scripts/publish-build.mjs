// Publishes a packaged build as a GitHub pre-release named build-<commit>, so
// deploy/proxmox/seerr-update.sh can download it instead of building on the
// server. Keeps only the newest few build releases.
//
// Usage: node publish-build.mjs <tarball>
// Needs GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA (set by Actions).
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const KEEP = 5;
const file = process.argv[2];
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
if (!file || !GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_SHA) {
  console.error('Usage: node publish-build.mjs <tarball> (in GitHub Actions)');
  process.exit(1);
}

const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;
const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  'X-GitHub-Api-Version': '2022-11-28',
};

const call = async (url, init = {}) => {
  const response = await fetch(url, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `${init.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`
    );
  }
  return response.status === 204 || response.status === 404
    ? null
    : response.json();
};

const tag = `build-${GITHUB_SHA}`;

// Replace an earlier upload for the same commit (e.g. a re-run)
const existing = await call(`${api}/releases/tags/${tag}`);
if (existing) {
  await call(`${api}/releases/${existing.id}`, { method: 'DELETE' });
}

const release = await call(`${api}/releases`, {
  method: 'POST',
  body: JSON.stringify({
    tag_name: tag,
    target_commitish: GITHUB_SHA,
    name: `Build ${GITHUB_SHA.slice(0, 8)}`,
    body: 'Ready-to-run build for deploy/proxmox/seerr-update.sh. Made automatically by Fork CI after all checks passed.',
    prerelease: true,
  }),
});

const { size } = await stat(file);
await call(
  `${release.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(basename(file))}`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(size),
    },
    body: await readFile(file),
  }
);
console.log(`Published ${release.html_url}`);

// Remove older builds
const releases = await call(`${api}/releases?per_page=100`);
const builds = releases
  .filter((r) => r.tag_name.startsWith('build-'))
  .sort((a, b) => b.created_at.localeCompare(a.created_at));
for (const old of builds.slice(KEEP)) {
  await call(`${api}/releases/${old.id}`, { method: 'DELETE' });
  await call(`${api}/git/refs/tags/${old.tag_name}`, { method: 'DELETE' });
  console.log(`Removed ${old.tag_name}`);
}
