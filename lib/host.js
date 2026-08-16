// dsh-image-skin host half.
// Registers one HTTP route (/api/dsh-image-skin) that the browser UI calls to
// generate a Q-version (chibi) pet illustration through a user-configured
// image-generation API (MiniMax image-01 protocol by default, OpenAI-style
// JSON body). Everything else — image import, palette extraction, theme token
// overrides, background layer, procedural pet — lives in the client half.
//
// The proxy exists because the browser page cannot call third-party image
// APIs directly (CORS); the harness host process can.

export const name = 'dsh-image-skin'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

/** Hard per-request timeout for the upstream image API. */
const DEFAULT_TIMEOUT_MS = 150000
/** Reference image (base64 data URL) size cap — 6 MB is generous. */
const MAX_REF_CHARS = 6 * 1024 * 1024
/** Cap on the whole request body (JSON with an embedded reference). */
const MAX_BODY_CHARS = 12 * 1024 * 1024

function sameOrigin(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

async function readBody(req) {
  let buf = ''
  for await (const chunk of req) {
    buf += chunk
    if (buf.length > MAX_BODY_CHARS) throw new Error('请求体过大')
  }
  if (!buf) return {}
  return JSON.parse(buf)
}

/** bytes → data URL (assume PNG; most providers emit PNG or JPEG). */
function bytesToDataUrl(bytes, mime) {
  return 'data:' + (mime || 'image/png') + ';base64,' + Buffer.from(bytes).toString('base64')
}

/**
 * Call the configured image-generation API and return a data URL.
 * Protocol: POST { model, prompt, n, response_format, image_urls? } with
 * `Authorization: Bearer <key>` — the MiniMax image-01 shape, which most
 * OpenAI-compatible image endpoints accept. `image_urls` carries the
 * reference image when the user uploads one (MiniMax image-01 reference).
 */
async function generateImage(args) {
  const baseUrl = String(args.baseUrl || '').trim()
  const key = String(args.key || '').trim()
  const model = String(args.model || '').trim() || 'image-01'
  const prompt = String(args.prompt || '').trim()
  if (!baseUrl) throw new Error('缺少 API 地址（设置里填写）')
  if (!key) throw new Error('缺少 API Key（设置里填写）')
  if (!prompt) throw new Error('缺少提示词（设置里填写）')
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('API 地址格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API 地址必须是 http(s) 链接')
  }

  const body = { model, prompt, n: 1, response_format: 'b64_json' }
  const reference = String(args.reference || '')
  if (reference.startsWith('data:image/') && reference.length < MAX_REF_CHARS) {
    body.image_urls = [reference]
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const resp = await fetch(url.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await resp.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
    if (!resp.ok) {
      const detail = json && (json.message || (json.error && json.error.message) || json.error) || text.slice(0, 300)
      throw new Error('生图 API ' + resp.status + ': ' + detail)
    }
    const data = json && (json.data || json.output || [])
    const item = Array.isArray(data) ? data[0] : null
    if (item && item.b64_json) {
      return 'data:image/png;base64,' + String(item.b64_json)
    }
    if (item && item.url) {
      // Providers may return a URL instead of inline base64: fetch and inline.
      const dl = await fetch(String(item.url), { signal: AbortSignal.timeout(60000) })
      if (!dl.ok) throw new Error('下载生成图片失败: HTTP ' + dl.status)
      const bytes = new Uint8Array(await dl.arrayBuffer())
      const mime = String(dl.headers.get('content-type') || '').split(';')[0] || 'image/png'
      return bytesToDataUrl(bytes, mime)
    }
    throw new Error('生图 API 返回了无法识别的数据（未找到 b64_json 或 url）')
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('生图请求超时（' + Math.round(DEFAULT_TIMEOUT_MS / 1000) + 's），请检查网络或 API 配置')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  webServer.register({
    kind: 'exact',
    path: '/api/dsh-image-skin',
    handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'probe') {
          return sendJson(res, 200, { ok: true, node: process.version, name })
        }
        if (method === 'generate') {
          const image = await generateImage(body)
          return sendJson(res, 200, { ok: true, image })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method ' + method })
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  })
}
