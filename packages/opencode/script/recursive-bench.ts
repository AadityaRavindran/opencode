#!/usr/bin/env bun
import { createServer } from "node:net"
import path from "path"
import { cp, mkdir, rm } from "node:fs/promises"

const modes = ["off", "rlm", "rah", "hybrid"] as const
type Mode = (typeof modes)[number]

const packageRoot = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(packageRoot, "../..")

const args = parseArgs(Bun.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const started = new Date()
const stamp = started
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d{3}Z$/, "")
const outDir = path.resolve(repoRoot, args.out ?? path.join(".recursive-bench", stamp))
const worktreeRoot = path.join(outDir, "worktrees")
const artifactRoot = path.join(outDir, "artifacts")
const selectedModes = parseModes(args.modes)
const prompt = await readPrompt(args)
const model = args.model ? parseModel(args.model) : undefined
const runPlan = selectedModes.flatMap((mode) =>
  Array.from({ length: args.runs }, (_, index) => ({ mode, run: index + 1 })),
)

await mkdir(worktreeRoot, { recursive: true })
await mkdir(artifactRoot, { recursive: true })
await Bun.write(path.join(outDir, "prompt.txt"), prompt)
await Bun.write(
  path.join(outDir, "config.json"),
  JSON.stringify(
    {
      createdAt: started.toISOString(),
      base: args.base,
      modes: selectedModes,
      runs: args.runs,
      model: args.model,
      agent: args.agent,
      copyWorkingTree: args.copyWorkingTree,
      dangerouslySkipPermissions: args.dangerouslySkipPermissions,
      run: !args.noRun,
      promptFile: "prompt.txt",
    },
    undefined,
    2,
  ) + "\n",
)

const worktrees = [] as Array<{ mode: Mode; run: number; branch: string; directory: string }>
for (const item of runPlan) {
  const branch = `recbench-${stamp}-${item.mode}${item.run}`
  const directory = path.join(worktreeRoot, `${item.mode}-${item.run}`)
  console.log(`worktree ${item.mode}#${item.run}: ${directory}`)
  await command(["git", "worktree", "add", "-b", branch, directory, args.base], repoRoot)
  worktrees.push({ ...item, branch, directory })
}

if (args.copyWorkingTree) {
  console.log("copying current tracked/untracked changes into benchmark worktrees")
  await copyWorkingTreeChanges(worktrees.map((item) => item.directory))
}

await writeRunbook(outDir, worktrees, prompt)

if (args.noRun) {
  console.log(`created recursive benchmark setup: ${path.relative(repoRoot, outDir)}`)
  process.exit(0)
}

const server = await startServer(outDir)
try {
  const rows = [] as RunSummary[]
  for (const worktree of worktrees) {
    rows.push(await runBenchmark(server.url, worktree, prompt, model))
    await Bun.write(path.join(outDir, "summary.json"), JSON.stringify(rows, undefined, 2) + "\n")
    await Bun.write(path.join(outDir, "summary.csv"), csv(rows))
  }
  console.log(`recursive benchmark complete: ${path.relative(repoRoot, outDir)}`)
  console.log(`summary: ${path.relative(repoRoot, path.join(outDir, "summary.csv"))}`)
} finally {
  server.proc.kill()
  await server.proc.exited.catch(() => undefined)
}

type Args = {
  help: boolean
  modes: string
  runs: number
  base: string
  out?: string
  prompt?: string
  promptFile?: string
  model?: string
  agent?: string
  noRun: boolean
  copyWorkingTree: boolean
  dangerouslySkipPermissions: boolean
  timeoutMs: number
}

function parseArgs(argv: string[]): Args {
  const result: Args = {
    help: false,
    modes: "off,rlm,rah,hybrid",
    runs: 1,
    base: "HEAD",
    noRun: false,
    copyWorkingTree: true,
    dangerouslySkipPermissions: false,
    timeoutMs: 30 * 60 * 1000,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = () => {
      const next = argv[++index]
      if (!next) throw new Error(`missing value for ${arg}`)
      return next
    }
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true
        break
      case "--modes":
        result.modes = value()
        break
      case "--runs":
        result.runs = Number(value())
        break
      case "--base":
        result.base = value()
        break
      case "--out":
        result.out = value()
        break
      case "--prompt":
        result.prompt = value()
        break
      case "--prompt-file":
        result.promptFile = value()
        break
      case "--model":
      case "-m":
        result.model = value()
        break
      case "--agent":
        result.agent = value()
        break
      case "--no-run":
        result.noRun = true
        break
      case "--no-copy-working-tree":
        result.copyWorkingTree = false
        break
      case "--dangerously-skip-permissions":
        result.dangerouslySkipPermissions = true
        break
      case "--timeout-ms":
        result.timeoutMs = Number(value())
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) throw new Error("--runs must be a positive integer")
  return result
}

function printHelp() {
  console.log(`Usage:
  bun run bench:recursive -- --prompt-file ./prompt.txt --model provider/model

Options:
  --modes off,rlm,rah,hybrid       Modes to run. Default: all
  --runs 3                         Runs per mode. Default: 1
  --base dev                       Git ref for worktrees. Default: HEAD
  --out .recursive-bench/name      Output directory. Default: timestamped
  --prompt "..."                   Prompt text
  --prompt-file prompt.txt         Prompt file
  --model provider/model           Model for all runs
  --agent build                    Agent for all runs
  --no-run                         Only create worktrees/runbook
  --no-copy-working-tree           Do not copy current dirty worktree into targets
  --dangerously-skip-permissions   Auto-approve permission prompts
  --timeout-ms 1800000             Per-run timeout. Default: 30 minutes

Outputs:
  summary.csv/json                 Tokens, cost, duration, tool counts
  artifacts/<mode>-<run>/          Raw events, messages, session, children, diff
  worktrees/<mode>-<run>/          Final git worktrees for manual comparison
`)
}

function parseModes(value: string) {
  const selected = value.split(",").map((item) => item.trim())
  const invalid = selected.filter((item) => !modes.includes(item as Mode))
  if (invalid.length > 0) throw new Error(`invalid modes: ${invalid.join(", ")}`)
  return selected as Mode[]
}

async function readPrompt(input: Args) {
  if (input.prompt !== undefined) return input.prompt
  if (input.promptFile) return Bun.file(path.resolve(repoRoot, input.promptFile)).text()
  return `Inspect this repository and make one small, useful improvement. Keep changes minimal, then summarize what changed and how you verified it.`
}

function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) throw new Error("--model must use provider/model")
  return { providerID, modelID }
}

async function command(cmd: string[], cwd: string, options: { stdin?: string; allowFailure?: boolean } = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: Bun.env,
  })
  if (options.stdin !== undefined) {
    proc.stdin?.write(options.stdin)
    proc.stdin?.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0 && !options.allowFailure) throw new Error(`${cmd.join(" ")} failed (${code})\n${stderr || stdout}`)
  return { stdout, stderr, code }
}

async function copyWorkingTreeChanges(directories: string[]) {
  const patch = await command(["git", "diff", "--binary", "HEAD"], repoRoot)
  const untracked = await command(["git", "ls-files", "--others", "--exclude-standard", "-z"], repoRoot)
  const files = untracked.stdout.split("\0").filter((item) => item && !isBenchOutputPath(item))
  for (const directory of directories) {
    if (patch.stdout.trim()) {
      await command(["git", "apply", "--whitespace=nowarn", "-"], directory, { stdin: patch.stdout })
    }
    for (const file of files) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
      await cp(path.join(repoRoot, file), path.join(directory, file), { recursive: true })
    }
  }
}

function isBenchOutputPath(file: string) {
  const relativeOut = path.relative(repoRoot, outDir)
  return file === relativeOut || file.startsWith(`${relativeOut}/`) || file.startsWith(".recursive-bench/")
}

async function writeRunbook(
  dir: string,
  worktrees: Array<{ mode: Mode; run: number; branch: string; directory: string }>,
  promptText: string,
) {
  const rows = worktrees
    .map(
      (item) =>
        `| ${item.mode} | ${item.run} | ${item.branch} | \`${path.relative(repoRoot, item.directory)}\` |`,
    )
    .join("\n")
  await Bun.write(
    path.join(dir, "README.md"),
    `# Recursive Bench ${stamp}

## Runs
| Mode | Run | Branch | Worktree |
|---|---:|---|---|
${rows}

## Prompt
\`\`\`text
${promptText}
\`\`\`

## Compare Manually
- Inspect final diffs: \`git -C <worktree> diff\`
- Compare summaries: \`summary.csv\` and \`summary.json\`
- Inspect raw event streams: \`artifacts/<mode>-<run>/events.jsonl\`
- Remove worktrees when done: \`git worktree remove <worktree>\`
`,
  )
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (!address || typeof address === "string") throw new Error("failed to allocate port")
  return address.port
}

async function startServer(dir: string) {
  const port = await freePort()
  const log = Bun.file(path.join(dir, "server.log")).writer()
  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: Bun.env,
    },
  )
  void pump(proc.stdout, log)
  void pump(proc.stderr, log)
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 200; attempt++) {
    const ok = await fetch(`${url}/path?directory=${encodeURIComponent(repoRoot)}`).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) return { proc, url }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error(`server did not become ready on ${url}`)
}

async function pump(stream: ReadableStream<Uint8Array>, writer: { write: (input: string) => unknown; flush: () => unknown }) {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      writer.write(decoder.decode(chunk.value, { stream: true }))
    }
  } finally {
    writer.flush()
  }
}

type RunSummary = {
  mode: Mode
  run: number
  branch: string
  worktree: string
  sessionID: string
  durationMs: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  assistantMessages: number
  toolCalls: number
  taskCalls: number
  contextCalls: number
  delegateCalls: number
  children: number
  error: string
}

async function runBenchmark(
  baseURL: string,
  worktree: { mode: Mode; run: number; branch: string; directory: string },
  promptText: string,
  selectedModel: { providerID: string; modelID: string } | undefined,
): Promise<RunSummary> {
  const id = `${worktree.mode}-${worktree.run}`
  const dir = path.join(artifactRoot, id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const start = performance.now()
  const events = subscribe(baseURL, worktree.directory, dir)
  await events.ready

  const session = await request(baseURL, worktree.directory, "POST", "/session", {
    title: `recursive bench ${worktree.mode} #${worktree.run}`,
    agent: args.agent,
    model: selectedModel ? { providerID: selectedModel.providerID, id: selectedModel.modelID } : undefined,
  })
  const sessionID = session.id as string
  await request(baseURL, worktree.directory, "POST", `/session/${sessionID}/recursive`, recursivePayload(worktree.mode))
  await request(baseURL, worktree.directory, "POST", `/session/${sessionID}/prompt_async`, {
    agent: args.agent,
    model: selectedModel,
    parts: [{ type: "text", text: promptText }],
  })

  const eventResult = await events.done(sessionID)
  const [finalSession, messages, children, diff] = await Promise.all([
    request(baseURL, worktree.directory, "GET", `/session/${sessionID}`),
    request(baseURL, worktree.directory, "GET", `/session/${sessionID}/message`),
    request(baseURL, worktree.directory, "GET", `/session/${sessionID}/children`),
    command(["git", "diff", "--stat"], worktree.directory, { allowFailure: true }),
  ])
  await Bun.write(path.join(dir, "session.json"), JSON.stringify(finalSession, undefined, 2) + "\n")
  await Bun.write(path.join(dir, "messages.json"), JSON.stringify(messages, undefined, 2) + "\n")
  await Bun.write(path.join(dir, "children.json"), JSON.stringify(children, undefined, 2) + "\n")
  await Bun.write(path.join(dir, "diff.stat.txt"), diff.stdout + diff.stderr)

  const stats = summarize(finalSession, messages, children)
  return {
    mode: worktree.mode,
    run: worktree.run,
    branch: worktree.branch,
    worktree: path.relative(repoRoot, worktree.directory),
    sessionID,
    durationMs: Math.round(performance.now() - start),
    ...stats,
    error: eventResult.error,
  }
}

function recursivePayload(mode: Mode) {
  if (mode === "off") return { enabled: false }
  return { enabled: true, strategy: mode }
}

async function request(baseURL: string, directory: string, method: string, route: string, body?: unknown) {
  const url = new URL(route, baseURL)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(dropUndefined(body)),
  })
  if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined
  return response.json() as Promise<any>
}

function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .map(([key, item]) => [key, dropUndefined(item)]),
  )
}

function subscribe(baseURL: string, directory: string, dir: string) {
  let ready!: () => void
  let done!: (sessionID: string) => Promise<{ error: string }>
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  const events = [] as unknown[]
  const errors = [] as string[]
  const idle = new Map<string, () => void>()
  const controller = new AbortController()
  const task = (async () => {
    const url = new URL("/event", baseURL)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, { signal: controller.signal })
    if (!response.body) throw new Error("event stream missing body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      const parts = buffer.split("\n\n")
      buffer = parts.pop() ?? ""
      for (const part of parts) {
        const data = parseSse(part)
        if (!data) continue
        const event = JSON.parse(data) as any
        events.push(event)
        if (event.type === "server.connected") ready()
        if (event.type === "session.error") errors.push(errorText(event.properties?.error))
        if (event.type === "permission.asked") await replyPermission(baseURL, directory, event)
        if (event.type === "session.status" && event.properties?.status?.type === "idle") {
          idle.get(event.properties.sessionID)?.()
        }
      }
    }
  })().catch((error) => {
    if (controller.signal.aborted) return
    throw error
  })
  done = async (sessionID: string) => {
    await Promise.race([
      new Promise<void>((resolve) => idle.set(sessionID, resolve)),
      task.then(() => undefined),
      Bun.sleep(args.timeoutMs).then(() => {
        throw new Error(`timed out waiting for ${sessionID}`)
      }),
    ])
    controller.abort()
    await Bun.write(path.join(dir, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n")
    return { error: errors.join("\n") }
  }
  return { ready: readyPromise, done }
}

function parseSse(part: string) {
  return part
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
}

async function replyPermission(baseURL: string, directory: string, event: any) {
  await request(baseURL, directory, "POST", `/permission/${event.properties.id}/reply`, {
    reply: args.dangerouslySkipPermissions ? "once" : "reject",
  })
}

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error)
  const record = error as Record<string, any>
  return record.data?.message ? String(record.data.message) : String(record.name ?? "unknown error")
}

function summarize(session: any, messages: any[], children: any[]) {
  const assistant = messages.filter((message) => message.info?.role === "assistant")
  const tools = messages.flatMap((message) => message.parts ?? []).filter((part) => part.type === "tool")
  const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  return {
    totalTokens:
      (tokens.input ?? 0) +
      (tokens.output ?? 0) +
      (tokens.reasoning ?? 0) +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0),
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    reasoningTokens: tokens.reasoning ?? 0,
    cacheReadTokens: tokens.cache?.read ?? 0,
    cacheWriteTokens: tokens.cache?.write ?? 0,
    cost: session.cost ?? 0,
    assistantMessages: assistant.length,
    toolCalls: tools.length,
    taskCalls: tools.filter((part) => part.tool === "task").length,
    contextCalls: tools.filter((part) => String(part.tool).startsWith("context_")).length,
    delegateCalls: tools.filter((part) => part.tool === "delegate_task").length,
    children: children.length,
  }
}

function csv(rows: RunSummary[]) {
  const columns = [
    "mode",
    "run",
    "branch",
    "worktree",
    "sessionID",
    "durationMs",
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cost",
    "assistantMessages",
    "toolCalls",
    "taskCalls",
    "contextCalls",
    "delegateCalls",
    "children",
    "error",
  ] as const
  return [columns.join(","), ...rows.map((row) => columns.map((column) => JSON.stringify(row[column] ?? "")).join(","))].join(
    "\n",
  )
}
