// dsh-image-skin host half.
// Registers one HTTP route (/api/dsh-image-skin) that the browser UI calls to
// generate a Q-version (chibi) pet illustration through a user-configured
// image-generation API (MiniMax image-01 protocol by default, OpenAI-style
// JSON body). Also exposes the agent busy status (pet "thinking" state) and
// launches/stops the standalone desktop pet window (WPF, always-on-top).
// Everything else — image import, palette extraction, theme token overrides,
// background layer, procedural pet — lives in the client half.
//
// The proxy exists because the browser page cannot call third-party image
// APIs directly (CORS); the harness host process can.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-image-skin'

/** Hard dependency: the HTTP carrier must exist before the route registers. */
export const inject = ['webServer']

/** Hard per-request timeout for the upstream image API. */
const DEFAULT_TIMEOUT_MS = 150000
/** Reference image (base64 data URL) size cap — 6 MB is generous. */
const MAX_REF_CHARS = 6 * 1024 * 1024
/** Cap on the whole request body (JSON with an embedded reference). */
const MAX_BODY_CHARS = 12 * 1024 * 1024
/** The pet app lives beside this package: <pkg>/pet/dsh-pet.ps1 */
const PET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'pet')
const PET_PID_FILE = join(PET_DIR, 'pet.pid')

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

  // --- agent activity tracking (pet "thinking" + info panel) ---
  // `agent/status` emits on every agent scope and bubbles to the root; keep a
  // simple running-agent counter (no agent object references retained).
  let runningAgents = 0
  let busy = false
  let busySince = 0
  let activity = ''
  let activityAt = 0
  let uiVisible = true // browser page visibility, heartbeated by the client

  function setActivity(text) {
    activity = String(text || '').slice(0, 120)
    activityAt = Date.now()
  }

  ctx.on('agent/status', (payload) => {
    try {
      const status = payload && payload.status
      if (status === 'running') {
        runningAgents++
        if (!busy) { busy = true; busySince = Date.now(); setActivity('正在处理你的请求…') }
      } else if (status === 'idle' && runningAgents > 0) {
        runningAgents--
        if (runningAgents === 0) { busy = false; busySince = 0; activity = ''; activityAt = 0 }
      }
    } catch { /* keep the pet alive */ }
  })

  // Tool dispatch -> "正在执行 X …" (waterfall: must call next()).
  ctx.on('tools/execute', (exec, next) => {
    try {
      if (busy && exec && exec.name) setActivity('正在执行 ' + String(exec.name) + ' …')
    } catch { /* keep the pet alive */ }
    return next()
  })

  ctx.on('agent/error', (payload) => {
    try { if (payload) setActivity('遇到错误，正在处理…') } catch { /* keep the pet alive */ }
  })

  // --- desktop pet window lifecycle ---
  let petPid = null
  function stopPet() {
    const candidates = []
    if (petPid) candidates.push(petPid)
    try {
      const saved = String(readFileSync(PET_PID_FILE, 'utf8')).trim()
      const n = Number(saved)
      if (n > 0 && n !== petPid) candidates.push(n)
    } catch { /* no pid file */ }
    for (const pid of candidates) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
    petPid = null
    try { writeFileSync(PET_PID_FILE, '') } catch { /* ignore */ }
  }
  function launchPet(preset, size) {
    const script = join(PET_DIR, 'dsh-pet.ps1')
    if (!existsSync(script)) return { ok: false, error: '未找到桌面宠物脚本：' + script }
    stopPet()
    // Note: no `detached: true` — on Windows, powershell.exe spawned with
    // DETACHED_PROCESS exits immediately without executing anything.
    // unref() is enough: the pet keeps running after the harness exits.
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script, '-Preset', preset, '-Size', String(size),
    ], { stdio: 'ignore', windowsHide: true })
    child.unref()
    petPid = child.pid
    try { writeFileSync(PET_PID_FILE, String(child.pid)) } catch { /* ignore */ }
    return { ok: true, pid: child.pid, preset, size, script }
  }

  // GET /api/dsh-image-skin/busy — no origin check (the desktop pet window
  // polls it from outside the browser).
  webServer.register({
    kind: 'exact',
    path: '/api/dsh-image-skin/busy',
    handler: (req, res) => {
      sendJson(res, 200, { ok: true, busy, since: busySince, activity, activityAt, uiVisible })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/dsh-image-skin',
    handler: async (req, res) => {
      try {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = await readBody(req)
        const method = String(body.method || '')
        if (method === 'probe') {
          return sendJson(res, 200, { ok: true, node: process.version, name, petDir: PET_DIR })
        }
        if (method === 'busy') {
          return sendJson(res, 200, { ok: true, busy, since: busySince, activity, activityAt, uiVisible })
        }
        // Browser page visibility heartbeat (the pet shows its info panel
        // only while DSH is minimized / hidden).
        if (method === 'ui-state') {
          uiVisible = body.visible !== false
          return sendJson(res, 200, { ok: true, uiVisible })
        }
        if (method === 'pet-launch') {
          const preset = /^[a-z]+$/.test(String(body.preset || '')) ? String(body.preset) : 'cat'
          const size = Math.max(60, Math.min(240, Number(body.size) || 150))
          const result = launchPet(preset, size)
          return sendJson(res, 200, result)
        }
        if (method === 'pet-stop') {
          stopPet()
          return sendJson(res, 200, { ok: true })
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
