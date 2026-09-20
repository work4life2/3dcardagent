import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { logger } from "../log.js";

const log = logger("s3");

/**
 * Minimal S3 uploader: SigV4-signed PutObject and nothing else.
 *
 * Hand-rolled rather than @aws-sdk/client-s3 on purpose — this project ships three runtime
 * dependencies and `deploy/deploy.sh` runs `npm ci` on every push, so ~40 transitive packages
 * for one HTTP verb is a bad trade. Bodies are small enough to buffer, which keeps the payload
 * hash (and therefore the signing) simple.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/**
 * S3 falls back to binary/octet-stream for extensions it does not know, which browsers refuse
 * to execute as script or apply as CSS — so the type is always set explicitly.
 */
export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Objects live under a unique share id, so everything but the entry page can be cached forever. */
function cacheControlFor(relPath: string): string {
  return path.basename(relPath) === "index.html" ? "public, max-age=60" : "public, max-age=31536000, immutable";
}

const sha256 = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

/** S3 keys here are [a-z0-9/._-], but encode per segment anyway so the signature matches the path. */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

export interface PutOptions {
  cacheControl?: string;
  /** Send x-amz-acl: public-read. Rejected by buckets with ACLs disabled (the modern default). */
  acl?: boolean;
}

/** PUT one object. Throws on a non-2xx response, with the (XML) error body trimmed into the message. */
export async function putObject(key: string, body: Buffer, contentType: string, opts: PutOptions = {}): Promise<void> {
  const { share } = getConfig();
  const url = new URL(`${share.baseUrl}/${encodeKey(key)}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const headers: Record<string, string> = {
    "cache-control": opts.cacheControl ?? cacheControlFor(key),
    "content-type": contentType,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (opts.acl) headers["x-amz-acl"] = "public-read";

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = ["PUT", url.pathname, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${share.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(share.secretAccessKey, date, share.region), stringToSign).toString("hex");

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${share.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`PUT ${key} failed: ${res.status} ${detail}`);
  }
}

/** True when an anonymous reader (X's crawler, the buyer's followers) can fetch the object. */
async function readableAnonymously(key: string): Promise<boolean> {
  const { share } = getConfig();
  try {
    const res = await fetch(`${share.baseUrl}/${encodeKey(key)}`, { signal: AbortSignal.timeout(30_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export type PublicMode = "plain" | "acl";

/**
 * Work out how (or whether) this bucket serves objects publicly, using a tiny canary object so a
 * misconfigured bucket costs one request instead of a whole card upload.
 *
 * Returns undefined when the bucket cannot serve public objects at all — that is a bucket policy
 * problem no upload flag can fix, so the caller logs the policy to attach and carries on without
 * a share link.
 */
export async function probePublicMode(keyPrefix: string): Promise<PublicMode | undefined> {
  const { share } = getConfig();
  const key = `${keyPrefix}/.probe`;
  const body = Buffer.from("ok\n");

  await putObject(key, body, "text/plain; charset=utf-8", { cacheControl: "no-store" });
  if (await readableAnonymously(key)) return "plain";

  try {
    await putObject(key, body, "text/plain; charset=utf-8", { cacheControl: "no-store", acl: true });
    if (await readableAnonymously(key)) return "acl";
  } catch (err) {
    // Expected on buckets with Object Ownership = bucket owner enforced, where ACLs are disabled.
    log.info(`public-read ACL rejected by the bucket: ${String(err).slice(0, 160)}`);
  }

  log.error(
    `bucket ${share.bucket} does not serve objects publicly, so shared cards would 404 for everyone. ` +
      `Turn off Block Public Access for it and attach: ` +
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PublicReadSharedCards",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${share.bucket}/${share.keyPrefix}/*`,
          },
        ],
      }),
  );
  return undefined;
}

export interface PutDirectoryOptions {
  mode: PublicMode;
  /** Rewrite a file's bytes on the way up, keyed by its path relative to the uploaded directory. */
  transform?: (relPath: string, body: Buffer) => Buffer;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/** Upload a directory tree under `keyPrefix`. Sequential: a hosted card is a dozen files. */
export async function putDirectory(dir: string, keyPrefix: string, opts: PutDirectoryOptions): Promise<number> {
  const files = walk(dir);
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(dir, rel));
    const body = opts.transform?.(rel, raw) ?? raw;
    await putObject(`${keyPrefix}/${rel.split(path.sep).join("/")}`, body, contentTypeFor(rel), {
      cacheControl: cacheControlFor(rel),
      acl: opts.mode === "acl",
    });
  }
  return files.length;
}

/** Upload a single local file (used for the share image, which sits outside the hosted tree). */
export async function putFile(file: string, key: string, mode: PublicMode): Promise<void> {
  await putObject(key, fs.readFileSync(file), contentTypeFor(file), { acl: mode === "acl" });
}
