/* global fetch, AbortController, AbortSignal, Response, setTimeout, clearTimeout */
import { homedir, tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { existsSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs'
import { readdir, stat, unlink, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { execa } from 'execa'
import { logger } from './logger.js'
import type { IssueProvider } from '../mcp/types.js'

/**
 * Represents a matched image in markdown content
 */
export interface ImageMatch {
  fullMatch: string
  url: string
  isMarkdown: boolean  // true for ![](url), false for <img>
}

/**
 * Supported image extensions
 */
const SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']

/**
 * Maximum allowed image size (10MB)
 */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024

/**
 * Request timeout in milliseconds (30 seconds)
 */
const REQUEST_TIMEOUT_MS = 30000

/**
 * Cache directory path for downloaded images.
 * Lives under the per-user iloom-ai config dir (not /tmp) so it isn't world-readable
 * and isn't subject to pre-creation/cache-poisoning by other users on shared hosts.
 */
export const CACHE_DIR = join(homedir(), '.config', 'iloom-ai', 'cache', 'images')

/**
 * Cache TTL: files older than this are pruned during periodic prune sweeps
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How often to run the stale-cache prune sweep within a single process.
 * Long-running processes (orchestrator, watch mode) need to prune more than once.
 */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Timestamp of the most recent prune within this process. Zero means "never pruned yet".
 */
let lastPruneAt = 0

/**
 * Cached GitHub auth token (module-level to avoid repeated `gh auth token` calls)
 */
let cachedGitHubToken: string | undefined

/**
 * One-shot flag for legacy cache cleanup. Reset via resetLegacyCleanupFlagForTesting()
 * in tests so each test can re-trigger the cleanup path.
 */
let legacyCleanedThisRun = false

/**
 * Best-effort recursive cleanup of the legacy /tmp/iloom-images cache dir from
 * earlier builds. macOS doesn't reliably purge /tmp on reboot, so users who
 * upgrade leave a world-readable image cache behind. Runs once per process.
 */
function cleanupLegacyCache(): void {
  if (legacyCleanedThisRun) return
  legacyCleanedThisRun = true

  const legacyDir = join(tmpdir(), 'iloom-images')
  if (!existsSync(legacyDir)) return

  rm(legacyDir, { recursive: true, force: true }).catch((error: unknown) => {
    if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
      throw error
    }
    logger.debug(`Failed to remove legacy cache at ${legacyDir}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * Ensure CACHE_DIR exists with restrictive (0o700) permissions.
 * mkdir's mode is only honored on creation, so chmod defensively to fix
 * pre-existing dirs that may have been created with broader permissions.
 *
 * Uses sync chmod so the tightened perms are guaranteed in place before
 * any caller writes to the dir (the next line in downloadAndSaveImage is
 * createWriteStream — async chmod could race with the write).
 */
function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(CACHE_DIR, 0o700)
  } catch (error) {
    if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
      throw error
    }
    logger.debug(`chmod on cache dir failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`)
  }

  cleanupLegacyCache()
}

/**
 * Extract all image URLs from markdown content
 * Handles both ![alt](url) and <img src="url"> formats
 *
 * @param content - Markdown content to parse
 * @returns Array of image matches with full match string and URL
 */
export function extractMarkdownImageUrls(content: string): ImageMatch[] {
  if (!content) {
    return []
  }

  const matches: ImageMatch[] = []

  // Regex for markdown images: ![alt](url)
  // Captures the entire match and the URL separately
  // Handles parentheses in URLs by matching balanced parens
  // The URL part matches: non-paren chars OR (balanced paren group)*, followed by non-paren/non-space chars
  const markdownRegex = /!\[([^\]]*)\]\(((?:[^()\s]|\((?:[^()\s]|\([^()]*\))*\))+)\)/g
  let match: RegExpExecArray | null

  while ((match = markdownRegex.exec(content)) !== null) {
    const url = match[2]
    if (url) {
      matches.push({
        fullMatch: match[0],
        url,
        isMarkdown: true
      })
    }
  }

  // Regex for HTML img tags: <img ... src="url" ...>
  // Handles both double and single quotes, and self-closing tags
  const htmlImgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*\/?>/gi

  while ((match = htmlImgRegex.exec(content)) !== null) {
    const url = match[1]
    if (url) {
      matches.push({
        fullMatch: match[0],
        url,
        isMarkdown: false
      })
    }
  }

  return matches
}

/**
 * Check if URL requires authentication to download
 * - Linear: uploads.linear.app
 * - GitHub: private-user-images.githubusercontent.com
 *
 * @param url - Image URL to check
 * @returns true if URL requires authentication
 */
export function isAuthenticatedImageUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname.toLowerCase()

    // Linear uploads require authentication
    if (hostname === 'uploads.linear.app') {
      return true
    }

    // GitHub private user images require authentication
    if (hostname === 'private-user-images.githubusercontent.com') {
      return true
    }

    // GitHub user-attachments (uploaded images in issues/PRs) require authentication
    if (hostname === 'github.com' && parsedUrl.pathname.startsWith('/user-attachments/assets/')) {
      return true
    }

    return false
  } catch {
    // Invalid URL - treat as not authenticated
    return false
  }
}

/**
 * Get extension from URL pathname
 *
 * @param url - URL to extract extension from
 * @returns Extension including dot (e.g., '.png') or null if not found
 */
function getExtensionFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url)
    const pathname = parsedUrl.pathname
    const ext = extname(pathname).toLowerCase()

    if (SUPPORTED_EXTENSIONS.includes(ext)) {
      return ext
    }
    return null
  } catch {
    return null
  }
}

/**
 * Generate cache key from URL
 * For GitHub URLs, strips JWT query params to ensure consistent caching
 * Returns hash + original extension
 *
 * @param url - Image URL to generate cache key for
 * @returns Cache key (hash + extension)
 */
export function getCacheKey(url: string): string {
  const parsedUrl = new URL(url)

  // For GitHub private images, remove jwt query param to get stable cache key
  // The jwt changes each fetch but the base URL is the same for the same image
  if (parsedUrl.hostname === 'private-user-images.githubusercontent.com') {
    parsedUrl.searchParams.delete('jwt')
  }

  // Get URL without volatile params for hashing
  const stableUrl = parsedUrl.toString()

  // Generate SHA256 hash of the stable URL (first 16 chars for brevity)
  const hash = createHash('sha256').update(stableUrl).digest('hex').slice(0, 16)

  // Extract extension from URL pathname, default to .png
  const ext = getExtensionFromUrl(url) ?? '.png'

  return `${hash}${ext}`
}

/**
 * Check if image is already cached
 * Returns file path if exists, undefined otherwise
 *
 * @param url - Image URL to check cache for
 * @returns Cached file path or undefined
 */
export function getCachedImagePath(url: string): string | undefined {
  const cacheKey = getCacheKey(url)
  const cachedPath = join(CACHE_DIR, cacheKey)

  if (existsSync(cachedPath)) {
    return cachedPath
  }
  return undefined
}

/**
 * Get authentication token for the given provider
 *
 * @param provider - Provider type ('github' or 'linear')
 * @returns Authentication token or undefined
 */
async function getAuthToken(provider: IssueProvider): Promise<string | undefined> {
  if (provider === 'github') {
    // Return cached token if available
    if (cachedGitHubToken !== undefined) {
      return cachedGitHubToken
    }

    try {
      // Execute `gh auth token` to get GitHub token
      const result = await execa('gh', ['auth', 'token'])
      cachedGitHubToken = result.stdout.trim()
      return cachedGitHubToken
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`Failed to get GitHub auth token via gh CLI: ${message}`)
      return undefined
    }
  }

  if (provider === 'linear') {
    // Linear token from environment variable
    return process.env.LINEAR_API_TOKEN
  }

  return undefined
}

/**
 * Clear the cached GitHub auth token (for testing purposes)
 */
export function clearCachedGitHubToken(): void {
  cachedGitHubToken = undefined
}

/**
 * Reset the periodic prune timestamp (for testing purposes)
 */
export function resetPruneFlagForTesting(): void {
  lastPruneAt = 0
}

/**
 * Reset the legacy-cleanup one-shot flag (for testing purposes)
 */
export function resetLegacyCleanupFlagForTesting(): void {
  legacyCleanedThisRun = false
}

/**
 * Delete cached image files older than CACHE_TTL_MS.
 * Fail-open: pruning errors must NEVER break the actual image-fetch flow.
 */
async function pruneStaleCache(cacheDir: string): Promise<void> {
  try {
    if (!existsSync(cacheDir)) {
      return
    }
    const entries = await readdir(cacheDir)
    const now = Date.now()
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(cacheDir, entry)
      try {
        const stats = await stat(entryPath)
        if (stats.isFile() && now - stats.mtimeMs > CACHE_TTL_MS) {
          await unlink(entryPath)
        }
      } catch (err) {
        // Per-entry failure is non-fatal; continue pruning others
        logger.debug(`pruneStaleCache: failed for ${entryPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }))
  } catch (err) {
    // Top-level failure is non-fatal; image fetch must proceed
    logger.debug(`pruneStaleCache: failed to read ${cacheDir}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Maximum number of redirects to follow before giving up.
 */
const MAX_REDIRECTS = 5

/**
 * Fetch the URL while following redirects manually so we can drop the
 * Authorization header on cross-origin redirects (e.g., GitHub
 * /user-attachments/assets/* 302s to S3 / objects.githubusercontent.com,
 * and we must not leak `Bearer <gh-token>` to AWS).
 */
async function fetchFollowingRedirects(
  initialUrl: string,
  initialHeaders: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let currentUrl = initialUrl
  let currentHeaders = { ...initialHeaders }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, {
      headers: currentHeaders,
      signal,
      redirect: 'manual',
    })

    const status = response.status
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308
    if (!isRedirect) {
      return response
    }

    const location = response.headers.get('Location') ?? response.headers.get('location')
    if (!location) {
      return response
    }

    const nextUrl = new URL(location, currentUrl).toString()
    const fromUrl = new URL(currentUrl)
    const toUrl = new URL(nextUrl)

    // Treat http→https on the same hostname as same-origin for auth purposes.
    // URL.origin includes the protocol, so a same-host upgrade would otherwise
    // strip auth and break the follow-up GET with 401.
    const isHttpsUpgrade =
      fromUrl.hostname === toUrl.hostname &&
      fromUrl.protocol === 'http:' &&
      toUrl.protocol === 'https:'
    const sameOrigin = fromUrl.origin === toUrl.origin || isHttpsUpgrade

    if (!sameOrigin) {
      // Drop auth header(s) case-insensitively on cross-origin redirect to avoid
      // leaking tokens to third parties. HTTP header names are case-insensitive
      // per spec — strip any key whose lowercased name is 'authorization'.
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(currentHeaders)) {
        if (k.toLowerCase() !== 'authorization') next[k] = v
      }
      currentHeaders = next
    }

    currentUrl = nextUrl
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) while downloading image`)
}

/**
 * Download image from URL and stream it directly to a file.
 *
 * Writes to a per-call temp file (`${destPath}.<uuid>.tmp`) and atomically
 * renames into place on success. This prevents torn writes when multiple
 * parallel callers race the same destPath (children processed in Promise.all,
 * plan + orchestrator in same process, etc.).
 *
 * @param url - Image URL to download
 * @param destPath - Destination file path
 * @param authHeader - Optional Authorization header value
 * @throws Error if download fails, times out, or exceeds size limit
 */
export async function downloadAndSaveImage(
  url: string,
  destPath: string,
  authHeader?: string
): Promise<void> {
  const headers: Record<string, string> = {}
  if (authHeader) {
    headers['Authorization'] = authHeader
  }

  // Set up abort controller for timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const tmpPath = `${destPath}.${randomUUID()}.tmp`

  try {
    const response = await fetchFollowingRedirects(url, headers, controller.signal)

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`)
    }

    // Check Content-Length header if available
    const contentLength = response.headers.get('Content-Length')
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${contentLength} bytes exceeds ${MAX_IMAGE_SIZE} byte limit`)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    // Convert ReadableStream to Node.js Readable
    const reader = response.body.getReader()
    let bytesWritten = 0

    const nodeReadable = new Readable({
      async read(): Promise<void> {
        try {
          const { done, value } = await reader.read()
          if (done) {
            this.push(null)
            return
          }

          bytesWritten += value.byteLength
          if (bytesWritten > MAX_IMAGE_SIZE) {
            reader.cancel()
            this.destroy(new Error(`Image too large: ${bytesWritten} bytes exceeds ${MAX_IMAGE_SIZE} byte limit`))
            return
          }

          this.push(Buffer.from(value))
        } catch (err) {
          this.destroy(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })

    ensureCacheDir()

    // Stream to per-call temp file, then atomically rename into place on success.
    const writeStream = createWriteStream(tmpPath)

    try {
      await pipeline(nodeReadable, writeStream)
      await rename(tmpPath, destPath)
    } catch (pipelineError) {
      // Clean up temp file on error (best-effort; ignore ENOENT).
      try {
        await unlink(tmpPath)
      } catch (unlinkError) {
        if (
          unlinkError instanceof TypeError ||
          unlinkError instanceof ReferenceError ||
          unlinkError instanceof SyntaxError
        ) {
          throw unlinkError
        }
        // ENOENT and similar fs errors are expected; nothing to clean up.
      }
      throw pipelineError
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Image download timed out after ${REQUEST_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Get the destination path for caching an image
 *
 * @param url - Original image URL (used to generate cache key)
 * @returns Local file path where image should be saved
 */
export function getCacheDestPath(url: string): string {
  ensureCacheDir()

  // Generate cache key from URL
  const cacheKey = getCacheKey(url)
  return join(CACHE_DIR, cacheKey)
}

/**
 * Rewrite image URLs in markdown content
 *
 * @param content - Original markdown content
 * @param urlMap - Map of original URLs to local file paths
 * @returns Content with URLs replaced
 */
export function rewriteMarkdownUrls(
  content: string,
  urlMap: Map<string, string>
): string {
  // Sort by descending key length so that when one URL is a prefix of another
  // (e.g., same image with and without `?query`), the longer one is replaced
  // first and isn't corrupted by an earlier replacement of the shorter one.
  const sorted = [...urlMap.entries()].sort(([a], [b]) => b.length - a.length)

  let result = content
  for (const [originalUrl, localPath] of sorted) {
    // split/join is literal — neither side interprets regex metacharacters
    // nor `String.prototype.replace`'s special replacement tokens ($&, $1, etc.).
    result = result.split(originalUrl).join(localPath)
  }

  return result
}

/**
 * Main entry point: process all images in markdown content
 * Downloads authenticated images (with caching), saves locally, rewrites URLs
 *
 * @param content - Markdown content to process
 * @param provider - Image provider for authentication ('github' or 'linear')
 * @returns Content with authenticated image URLs replaced with local file paths
 */
export async function processMarkdownImages(
  content: string,
  provider: IssueProvider
): Promise<string> {
  // Periodic stale-cache prune (fail-open). Long-running processes (orchestrator,
  // watch mode) need this to fire on a schedule, not just once per process.
  if (Date.now() - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now()
    await pruneStaleCache(CACHE_DIR).catch((error: unknown) => {
      if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) {
        throw error
      }
      logger.debug(`Cache prune failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Early return if empty
  if (!content) {
    return ''
  }

  // Extract all image URLs
  const images = extractMarkdownImageUrls(content)
  if (images.length === 0) {
    return content
  }

  // Filter to only authenticated URLs
  const authImages = images.filter(img => isAuthenticatedImageUrl(img.url))
  if (authImages.length === 0) {
    return content
  }

  // Get auth token for provider
  const authToken = await getAuthToken(provider)

  // Deduplicate URLs (same image might appear multiple times)
  const uniqueUrls = [...new Set(authImages.map(img => img.url))]

  // Build URL map - process all unique URLs in parallel
  const urlMap = new Map<string, string>()

  // Download/cache images in parallel
  const downloadPromises = uniqueUrls.map(async (url) => {
    try {
      // Check cache first
      const cachedPath = getCachedImagePath(url)
      if (cachedPath) {
        logger.debug(`Using cached image: ${cachedPath}`)
        return { url, localPath: cachedPath }
      }

      // Cache miss - download and stream directly to file
      logger.debug(`Downloading image: ${url}`)
      const destPath = getCacheDestPath(url)
      // Linear personal API keys (lin_api_*) require the raw token in the
      // Authorization header — Linear's docs reject `Bearer <key>` for personal
      // keys (only OAuth access tokens use the Bearer scheme). GitHub tokens
      // continue to use the standard `Bearer <token>` form.
      const authHeader = authToken
        ? provider === 'linear'
          ? authToken
          : `Bearer ${authToken}`
        : undefined
      await downloadAndSaveImage(url, destPath, authHeader)
      return { url, localPath: destPath }
    } catch (error) {
      // Graceful degradation - log warning, return null to keep original URL
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`Failed to download image ${url}: ${message}`)
      return null
    }
  })

  const results = await Promise.all(downloadPromises)

  // Build URL map from results
  for (const result of results) {
    if (result !== null) {
      urlMap.set(result.url, result.localPath)
    }
  }

  // Rewrite and return
  return rewriteMarkdownUrls(content, urlMap)
}
