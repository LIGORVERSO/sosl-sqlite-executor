import crypto from 'node:crypto';
import process from 'node:process';

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not configured');
}

let credential;
try {
  credential = JSON.parse(raw);
} catch {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
}

if (
  credential?.type !== 'service_account' ||
  typeof credential?.client_email !== 'string' ||
  typeof credential?.private_key !== 'string'
) {
  throw new Error('Service-account credential is missing required fields');
}

const base64url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const now = Math.floor(Date.now() / 1000);
const scope = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const tokenUrl = 'https://oauth2.googleapis.com/token';

const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const payload = base64url(
  JSON.stringify({
    iss: credential.client_email,
    scope,
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  }),
);
const unsignedJwt = `${header}.${payload}`;
const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedJwt), credential.private_key);
const assertion = `${unsignedJwt}.${base64url(signature)}`;

const tokenResponse = await fetch(tokenUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
});

if (!tokenResponse.ok) {
  const body = await tokenResponse.text();
  throw new Error(`Google OAuth token exchange failed (${tokenResponse.status}): ${body.slice(0, 500)}`);
}

const token = await tokenResponse.json();
if (typeof token?.access_token !== 'string' || token.access_token.length < 20) {
  throw new Error('Google OAuth token exchange returned no access token');
}

const filesUrl = new URL('https://www.googleapis.com/drive/v3/files');
filesUrl.searchParams.set('pageSize', '20');
filesUrl.searchParams.set('spaces', 'drive');
filesUrl.searchParams.set('q', 'trashed = false');
filesUrl.searchParams.set(
  'fields',
  'files(id,mimeType,capabilities(canDownload,canEdit)),nextPageToken',
);

const filesResponse = await fetch(filesUrl, {
  headers: { authorization: `Bearer ${token.access_token}` },
});

if (!filesResponse.ok) {
  const body = await filesResponse.text();
  throw new Error(`Drive files.list failed (${filesResponse.status}): ${body.slice(0, 500)}`);
}

const listing = await filesResponse.json();
const files = Array.isArray(listing?.files) ? listing.files : [];

const mimeTypes = {};
let canDownloadCount = 0;
let aclCanEditCount = 0;
for (const file of files) {
  const mime = typeof file?.mimeType === 'string' ? file.mimeType : 'unknown';
  mimeTypes[mime] = (mimeTypes[mime] || 0) + 1;
  if (file?.capabilities?.canDownload === true) canDownloadCount += 1;
  if (file?.capabilities?.canEdit === true) aclCanEditCount += 1;
}

const result = {
  ok: files.length > 0,
  contract: 'sosl_drive_readonly_probe_v0.1.0',
  auth: {
    mode: 'service_account_jwt',
    oauth_scope: scope,
    credential_logged: false,
  },
  drive: {
    listed_files_sample: files.length,
    has_more: Boolean(listing?.nextPageToken),
    can_download_sample: canDownloadCount,
    acl_can_edit_sample: aclCanEditCount,
    mime_type_counts: mimeTypes,
  },
  safety: {
    metadata_only: true,
    file_names_logged: false,
    file_ids_logged: false,
    content_downloaded: false,
    drive_write_attempted: false,
  },
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
