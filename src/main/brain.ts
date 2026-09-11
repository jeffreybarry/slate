// Brain — runs the user's own local agent CLIs (Claude Code, Codex) in print mode,
// or any OpenAI-compatible local model server (Ollama, LM Studio, vLLM, llama.cpp…).
// No API keys are stored or used; billing rides on the user's existing subscriptions,
// and the local backend never leaves the machine.

import { execFile, spawn, ChildProcess } from 'child_process'
import { existsSync, readFileSync, rmSync } from 'fs'
import { join, extname, delimiter, dirname, resolve as resolvePath } from 'path'
import { homedir, tmpdir } from 'os'
import type { BrainBackend, BrainRequest, BrainResult, BrainStatus, BrainTier, LocalModelInfo } from '../shared/types'

// Electron apps launched from Finder/Dock inherit a minimal PATH that misses
// Homebrew and user bins — resolve the CLIs explicitly and augment PATH.
// On Windows the CLIs are npm shims (claude.cmd / codex.cmd) under %APPDATA%\npm,
// or claude.exe from the native installer under ~/.local/bin.
const IS_WIN = process.platform === 'win32'

const CLI_DIRS: string[] = IS_WIN
  ? [
      join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm'),
      join(homedir(), '.local', 'bin'),
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'claude'),
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs')
    ]
  : [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(homedir(), '.local', 'bin'),
      join(homedir(), 'bin'),
      join(homedir(), '.npm-global', 'bin'),
      '/usr/bin'
    ]

// Windows executable extensions worth trying, most direct first.
const WIN_EXTS = ['.exe', '.cmd', '.bat']

// The ChatGPT desktop app bundles a signed, version-matched codex that shares
// the user's ChatGPT sign-in — prefer it over any npm-installed copy.
const CODEX_BUNDLED = '/Applications/ChatGPT.app/Contents/Resources/codex'

/** A launchable CLI: the file to spawn plus any leading args (e.g. node + script). */
export interface ResolvedCli {
  file: string
  args: string[]
}

function searchDirs(): string[] {
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...CLI_DIRS, ...fromPath]
}

/** npm's Windows shims (`foo.cmd`) wrap `node "%dp0%\node_modules\<pkg>\cli.js" %*`.
 *  Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and a
 *  shell would mangle multi-line prompt args — so run the JS entry point directly. */
export function npmShimEntry(cmdPath: string): string | null {
  try {
    const text = readFileSync(cmdPath, 'utf8')
    const m = text.match(/"%dp0%\\([^"]+\.(?:c|m)?js)"/i)
    if (!m) return null
    const entry = resolvePath(dirname(cmdPath), m[1])
    return existsSync(entry) ? entry : null
  } catch {
    return null
  }
}

function nodeExe(): string {
  for (const dir of searchDirs()) {
    const p = join(dir, 'node.exe')
    if (existsSync(p)) return p
  }
  return 'node'
}

export function resolveCli(name: string): ResolvedCli {
  if (!IS_WIN) {
    if (name === 'codex' && existsSync(CODEX_BUNDLED)) return { file: CODEX_BUNDLED, args: [] }
    for (const dir of CLI_DIRS) {
      const p = join(dir, name)
      if (existsSync(p)) return { file: p, args: [] }
    }
    return { file: name, args: [] } // hope PATH has it
  }
  for (const dir of searchDirs()) {
    for (const ext of WIN_EXTS) {
      const p = join(dir, name + ext)
      if (!existsSync(p)) continue
      if (ext === '.exe') return { file: p, args: [] }
      const entry = npmShimEntry(p)
      if (entry) return { file: nodeExe(), args: [entry] }
    }
  }
  return { file: name, args: [] }
}

function brainEnv(): NodeJS.ProcessEnv {
  // Windows env keys are case-insensitive and usually spelled `Path`; reuse the
  // existing key so the child does not end up with two PATH variables.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const extra = CLI_DIRS.join(delimiter)
  return { ...process.env, [pathKey]: `${process.env[pathKey] ?? ''}${delimiter}${extra}` }
}

const CLAUDE_TIER_MODEL: Record<BrainTier, string | null> = {
  fast: 'haiku',
  standard: 'sonnet',
  top: null // user's configured default model — their best available
}

const running = new Map<string, ChildProcess>()
const runningLocal = new Map<string, AbortController>()

// ---- Local model backend (OpenAI-compatible localhost server) ----
// One adapter covers every mainstream local runtime — they all expose the same
// /v1/chat/completions protocol on a localhost port.
const LOCAL_CANDIDATES = [
  'http://localhost:11434/v1', // Ollama
  'http://localhost:1234/v1', // LM Studio
  'http://localhost:8000/v1', // vLLM
  'http://localhost:8080/v1' // llama.cpp server / KoboldCpp
]

function normalizeEndpoint(url: string): string {
  let u = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(u)) u = `http://${u}`
  if (!/\/v1$/.test(u)) u = `${u}/v1`
  return u
}

async function probeLocal(endpoint: string): Promise<LocalModelInfo[] | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(`${endpoint}/models`, {
      headers: { Authorization: 'Bearer slate' },
      signal: ctrl.signal
    })
    clearTimeout(t)
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const models = (body.data ?? []).filter((m) => m.id).map((m) => ({ id: String(m.id) }))
    return models
  } catch {
    return null
  }
}

/** Find a live local server: the user's configured endpoint first, then common ports. */
export async function detectLocal(
  preferred?: string
): Promise<{ endpoint: string | null; models: LocalModelInfo[] }> {
  const candidates = preferred
    ? [normalizeEndpoint(preferred)]
    : LOCAL_CANDIDATES
  for (const ep of candidates) {
    const models = await probeLocal(ep)
    if (models !== null) return { endpoint: ep, models }
  }
  return { endpoint: null, models: [] }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

type ChatContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>

function localMessages(req: BrainRequest): Array<{ role: string; content: ChatContent }> {
  let user: ChatContent = req.prompt
  if (req.images && req.images.length > 0) {
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: req.prompt }
    ]
    for (const img of req.images) {
      const mime = IMAGE_MIME[extname(img).toLowerCase()]
      if (!mime || !existsSync(img)) continue
      const b64 = readFileSync(img).toString('base64')
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } })
    }
    user = parts
  }
  return [
    { role: 'system', content: req.system },
    { role: 'user', content: user }
  ]
}

async function runLocalOnce(
  req: BrainRequest,
  endpoint: string,
  model: string,
  extraNudge?: string
): Promise<string> {
  const messages = localMessages(req)
  if (extraNudge) messages.push({ role: 'user', content: extraNudge })
  const ctrl = new AbortController()
  runningLocal.set(req.id, ctrl)
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer slate' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`Local model server responded ${res.status} at ${endpoint}. ${detail}`)
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      error?: { message?: string }
    }
    if (body.error?.message) throw new Error(body.error.message)
    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('Local model returned an empty response.')
    }
    return text.trim()
  } finally {
    runningLocal.delete(req.id)
  }
}

async function runLocal(req: BrainRequest, started: number): Promise<BrainResult> {
  const { endpoint, models } = await detectLocal(req.localEndpoint)
  if (!endpoint) {
    return {
      id: req.id,
      ok: false,
      text: '',
      error:
        'No local model server found. Start Ollama, LM Studio, vLLM, or llama.cpp (or set a custom endpoint in Project Settings → Brain), then retry.',
      elapsedMs: Date.now() - started
    }
  }
  const model = req.localModel?.trim() || models[0]?.id
  if (!model) {
    return {
      id: req.id,
      ok: false,
      text: '',
      error: `Local server at ${endpoint} has no models loaded. Pull or load a model, then retry.`,
      elapsedMs: Date.now() - started
    }
  }
  try {
    let text = await runLocalOnce(req, endpoint, model)
    let json: unknown
    if (req.expectJson) {
      try {
        json = extractJson(text)
      } catch {
        text = await runLocalOnce(
          req,
          endpoint,
          model,
          'IMPORTANT: Respond with ONLY the requested JSON. No prose, no code fences.'
        )
        json = extractJson(text)
      }
    }
    return { id: req.id, ok: true, text, json, elapsedMs: Date.now() - started }
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      text: '',
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started
    }
  }
}

function which(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const cli = resolveCli(cmd)
    execFile(cli.file, [...cli.args, ...args], { timeout: 15000, env: brainEnv(), windowsHide: true }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(stdout.trim().split('\n')[0] || 'available')
    })
  })
}

export async function brainStatus(localEndpoint?: string): Promise<BrainStatus> {
  const [claudeV, codexV, local] = await Promise.all([
    which('claude', ['--version']),
    which('codex', ['--version']),
    detectLocal(localEndpoint)
  ])
  return {
    claude: { available: claudeV !== null, version: claudeV },
    codex: { available: codexV !== null, version: codexV },
    local: {
      available: local.endpoint !== null,
      version: local.endpoint
        ? `${local.models.length} model(s) @ ${local.endpoint.replace(/^https?:\/\//, '')}`
        : null,
      endpoint: local.endpoint
    }
  }
}

/** Extract the first balanced JSON object or array from text. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const starts: Array<[string, string]> = [
    ['{', '}'],
    ['[', ']']
  ]
  for (const [open, close] of starts) {
    const i = cleaned.indexOf(open)
    if (i === -1) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < cleaned.length; j++) {
      const ch = cleaned[j]
      if (esc) {
        esc = false
        continue
      }
      if (ch === '\\') {
        esc = true
        continue
      }
      if (ch === '"') inStr = !inStr
      if (inStr) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(i, j + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  throw new Error('No valid JSON found in response')
}

interface CliCall {
  cmd: string
  args: string[]
  input?: string
}

function buildClaudeCall(req: BrainRequest): CliCall {
  const args = ['-p', '--output-format', 'json']
  const model = CLAUDE_TIER_MODEL[req.tier]
  if (model) args.push('--model', model)
  if (req.images && req.images.length > 0) {
    // Pre-approve Read so the model can open reference frames without a permission prompt.
    args.push('--allowedTools', 'Read')
  }
  args.push('--append-system-prompt', req.system)
  let prompt = req.prompt
  if (req.images && req.images.length > 0) {
    prompt +=
      '\n\nReference media frames to view (use the Read tool on each before answering):\n' +
      req.images.map((p) => `- ${p}`).join('\n')
  }
  return { cmd: 'claude', args, input: prompt }
}

function buildCodexCall(req: BrainRequest, lastMessageFile: string): CliCall {
  // codex exec runs a one-shot task; the clean final answer lands in
  // --output-last-message (stdout interleaves streaming/progress noise).
  const args = ['exec', '--skip-git-repo-check', '--output-last-message', lastMessageFile]
  if (req.images && req.images.length > 0) {
    for (const img of req.images) args.push('-i', img)
  }
  args.push('-')
  const prompt = `${req.system}\n\n---\n\n${req.prompt}`
  return { cmd: 'codex', args, input: prompt }
}

function parseClaudeOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.is_error) {
      const msg: string = typeof parsed.result === 'string' ? parsed.result : 'Claude Code returned an error.'
      if (/authenticat|oauth|401|logged? ?in|revoked/i.test(msg)) {
        throw new Error(
          `Claude Code's sign-in has expired or been revoked. Open Terminal, run: claude auth login  — approve in the browser, then retry. (${msg})`
        )
      }
      throw new Error(msg)
    }
    if (typeof parsed?.result === 'string') return parsed.result
  } catch (e) {
    if (e instanceof Error && e.message.includes('claude auth login')) throw e
    if (e instanceof Error && !(e instanceof SyntaxError)) throw e
    /* fall through — some versions emit plain text on error */
  }
  return raw.trim()
}

export async function brainRun(req: BrainRequest, backend: BrainBackend): Promise<BrainResult> {
  const started = Date.now()

  // Demo mode (SLATE_BRAIN_MOCK=<dir>): serve canned responses keyed by task
  // prefix after a short realistic delay. Used by the capture rig only.
  if (process.env.SLATE_BRAIN_MOCK) {
    const dir = process.env.SLATE_BRAIN_MOCK
    const key = ['first-ad', 'reference-analysis', 'score-compile', 'voice-compile', 'compile', 'directors-note']
      .find((k) => req.task.startsWith(k))
    const file = join(dir, `${key ?? 'default'}.json`)
    if (existsSync(file)) {
      await new Promise((r) => setTimeout(r, 1200))
      const canned = JSON.parse((await import('fs')).readFileSync(file, 'utf8'))
      return {
        id: req.id,
        ok: true,
        text: typeof canned === 'string' ? canned : JSON.stringify(canned),
        json: typeof canned === 'string' ? undefined : canned,
        elapsedMs: Date.now() - started
      }
    }
  }
  if (backend === 'local') return runLocal(req, started)

  const lastMessageFile = join(tmpdir(), `slate-codex-${req.id}.txt`)
  const call = backend === 'claude' ? buildClaudeCall(req) : buildCodexCall(req, lastMessageFile)

  const codexResult = (rawStdout: string): string => {
    try {
      const msg = readFileSync(lastMessageFile, 'utf8').trim()
      rmSync(lastMessageFile, { force: true })
      if (msg) return msg
    } catch {
      /* fall back to stdout */
    }
    return rawStdout.trim()
  }

  const runOnce = (extraNudge?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const cli = resolveCli(call.cmd)
      const child = spawn(cli.file, [...cli.args, ...call.args], {
        env: brainEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      running.set(req.id, child)
      let out = ''
      let errOut = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (errOut += d))
      child.on('error', (e) => {
        running.delete(req.id)
        reject(new Error(`Could not launch ${call.cmd}: ${e.message}`))
      })
      child.on('close', (code) => {
        running.delete(req.id)
        if (code !== 0 && !out.trim()) {
          reject(new Error(errOut.trim() || `${call.cmd} exited with code ${code}`))
        } else {
          try {
            resolve(backend === 'claude' ? parseClaudeOutput(out) : codexResult(out))
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        }
      })
      const input = extraNudge ? `${call.input}\n\n${extraNudge}` : call.input
      child.stdin.write(input ?? '')
      child.stdin.end()
    })

  try {
    let text = await runOnce()
    let json: unknown
    if (req.expectJson) {
      try {
        json = extractJson(text)
      } catch {
        // One retry with an explicit nudge — models occasionally wrap JSON in prose.
        text = await runOnce('IMPORTANT: Respond with ONLY the requested JSON. No prose, no code fences.')
        json = extractJson(text)
      }
    }
    return { id: req.id, ok: true, text, json, elapsedMs: Date.now() - started }
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      text: '',
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - started
    }
  }
}

export function brainCancel(id: string): void {
  const child = running.get(id)
  if (child) {
    child.kill('SIGTERM')
    running.delete(id)
  }
  const ctrl = runningLocal.get(id)
  if (ctrl) {
    ctrl.abort()
    runningLocal.delete(id)
  }
}
