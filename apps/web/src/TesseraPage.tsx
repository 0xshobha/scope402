import { useEffect, useMemo, useRef, useState } from 'react'
import {
  approveTesseraRun, createTesseraRun, executeTesseraAction, getTesseraAgentHealth,
  getTesseraCanvas, getTesseraRun,
  publicTesseraAgentUrl, publicTesseraApiUrl,
  type CanvasRegion, type TesseraActionName, type TesseraActionResult,
  type TesseraCanvas, type TesseraCapability, type TesseraRun,
} from './tessera-api.js'

const storedRunId = 'scope402-tessera-run-id'
const storedRunToken = 'scope402-tessera-run-token'
const actionLabels: Record<TesseraActionName, string> = {
  delegate: 'DELEGATE CHILD', 'place-outside': 'PROBE OUTSIDE',
  'wrong-key': 'TRY WRONG KEY', 'place-inside': 'PLACE INSIDE', replay: 'REPLAY CALL',
  expire: 'EXPIRE ROOT',
}

function short(value: string | undefined, start = 13, end = 8) {
  if (!value) return '—'
  return value.length > start + end + 1 ? `${value.slice(0, start)}…${value.slice(-end)}` : value
}

function LeaseCountdown({ exp }: { exp: number }) {
  const [seconds, setSeconds] = useState(() => Math.max(0, exp - Math.floor(Date.now() / 1_000)))
  useEffect(() => {
    const timer = window.setInterval(() =>
      setSeconds(Math.max(0, exp - Math.floor(Date.now() / 1_000))), 1_000)
    return () => window.clearInterval(timer)
  }, [exp])
  return <span className={seconds === 0 ? 'expired-value' : ''}>
    {seconds === 0 ? 'EXPIRED' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}
  </span>
}

function regionLabel(region: CanvasRegion | undefined) {
  return region ? `${region.width} × ${region.height} · (${region.x}, ${region.y})` : '—'
}

function capabilityValue(capability: TesseraCapability | undefined, field: keyof TesseraCapability) {
  if (!capability) return '—'
  if (field === 'resource') return regionLabel(capability.resource)
  if (field === 'tool_ids') return capability.tool_ids.join(', ')
  if (field === 'remaining_calls') return `${capability.remaining_calls} / ${capability.max_calls}`
  if (field === 'exp') return <LeaseCountdown exp={capability.exp} />
  if (field === 'subject') return capability.subject
  if (field === 'payment_quote_id') return short(capability.payment_quote_id)
  if (field === 'hedera_tx_id') return short(capability.hedera_tx_id)
  if (field === 'policy_hash') return short(capability.policy_hash, 15, 8)
  return String(capability[field] ?? '—')
}

function CapabilityTree({ run }: { run?: TesseraRun }) {
  const root = run?.root
  const child = run?.child
  const rows: Array<[string, keyof TesseraCapability]> = [
    ['SUBJECT', 'subject'], ['REGION', 'resource'], ['CALLS', 'remaining_calls'], ['EXPIRY', 'exp'],
    ['TOOL', 'tool_ids'], ['PAYMENT LINEAGE', 'hedera_tx_id'], ['POLICY HASH', 'policy_hash'],
  ]
  return <section className="tessera-tree" aria-label="Scope402 capability tree">
    <div className="tessera-tree-heading"><span className="section-label">THE AUTHORITY IS THE PRODUCT</span>
      <h2>One purchase.<br/><em>Two bounded actors.</em></h2>
      <p>Root authority narrows into a worker capability. Every value below is rendered from the hosted agent’s persisted response.</p>
    </div>
    <div className="tree-table-wrap">
      <table className="tree-table"><thead><tr><th>DIMENSION</th><th>ROOT · PRINCIPAL A</th><th>CHILD · WORKER B</th></tr></thead>
        <tbody>{rows.map(([label, field]) => <tr key={label}><th scope="row">{label}</th>
          <td className="mono">{capabilityValue(root, field)}</td><td className="mono">{capabilityValue(child, field)}</td></tr>)}</tbody>
      </table>
      <div className="tree-lineage mono"><span>ROOT {short(root?.root_lease_id)}</span><b>→</b><span>CHILD {short(child?.lease_id)}</span></div>
    </div>
  </section>
}

function PurchaseProof({ run }: { run?: TesseraRun }) {
  const quote = run?.quote
  const payment = run?.payment
  return <section className="tessera-purchase-proof" aria-label="Tessera purchase terms and settlement">
    <div className="purchase-proof-heading"><span className="section-label">PURCHASE POLICY</span>
      <h2>Know the authority<br/><em>before paying.</em></h2></div>
    <dl className="purchase-proof-grid">
      <div><dt>PRICE</dt><dd className="mono">{quote ? `${quote.pricing.total_tinybars} TINYBARS` : '—'}</dd></div>
      <div><dt>PAYER</dt><dd className="mono">{quote?.payer ?? '—'}</dd></div>
      <div><dt>MERCHANT</dt><dd className="mono">{quote?.merchant ?? '—'}</dd></div>
      <div><dt>NETWORK</dt><dd className="mono">{quote?.network?.toUpperCase() ?? '—'}</dd></div>
      <div><dt>RESOURCE</dt><dd className="mono">{quote ? `${quote.canvas_id} · ${regionLabel(quote.region)}` : '—'}</dd></div>
      <div><dt>POLICY HASH</dt><dd className="mono" title={quote?.policy_hash}>{short(quote?.policy_hash, 18, 10)}</dd></div>
    </dl>
    <div className={`settlement-proof ${payment ? 'settled' : ''}`}>
      <span className="mono">{payment ? `${payment.amount_tinybars} TINYBARS SETTLED` :
        quote ? 'NOT SETTLED · APPROVAL REQUIRED' : 'PREPARE A QUOTE TO INSPECT TERMS'}</span>
      {payment && <a className="button" href={payment.hashscan_url} target="_blank" rel="noreferrer">
        VERIFY ON HASHSCAN ↗</a>}
    </div>
  </section>
}

function CanvasPanel({ canvas, run, action }: {
  canvas?: TesseraCanvas
  run?: TesseraRun
  action?: TesseraActionResult
}) {
  const pixels = useMemo(() => new Map((canvas?.pixels ?? []).map((pixel) => [`${pixel.x}:${pixel.y}`, pixel.color])), [canvas])
  const root = run?.root?.resource
  const child = run?.child?.resource
  const cells = Array.from({ length: 32 * 32 }, (_, index) => {
    const x = index % 32
    const y = Math.floor(index / 32)
    const pixel = pixels.get(`${x}:${y}`)
    const rootCell = root && x >= root.x && x < root.x + root.width && y >= root.y && y < root.y + root.height
    const childCell = child && x >= child.x && x < child.x + child.width && y >= child.y && y < child.y + child.height
    return <span key={`${x}:${y}`} className={`canvas-cell ${rootCell ? 'root-cell' : ''} ${childCell ? 'child-cell' : ''}`}
      style={pixel ? { backgroundColor: pixel } : undefined} title={`${x},${y}${pixel ? ` · ${pixel}` : ''}`} />
  })
  return <section className="tessera-canvas-card" aria-label="Server authoritative canvas">
    <div className="tessera-panel-head"><div><span className="section-label">SERVER CANVAS</span><h2>Authority has edges.</h2></div>
      <span className="mono canvas-size">32 × 32</span></div>
    <div className="canvas-wrap"><div className="canvas-grid">{cells}</div></div>
    <div className="canvas-key mono"><span><i className="root-key" />ROOT REGION</span><span><i className="child-key" />CHILD REGION</span><span><i className="pixel-key" />SERVER PIXEL</span></div>
    {canvas ? <p className="canvas-note mono">POLLING SERVER STATE · {canvas.pixels.length} PIXELS · {canvas.regions.length} ALLOCATED REGIONS</p> :
      <p className="canvas-note mono">WAITING FOR CANVAS STATE</p>}
    {action && <div className={`tessera-action-result ${action.verdict.toLowerCase()}`} role="status">
      <strong className="mono">{action.status} · {action.code}</strong><span>{action.message}</span>
    </div>}
  </section>
}

function ActionButton({ action, disabled, onClick }: { action: TesseraActionName; disabled: boolean; onClick: () => void }) {
  return <button className="button" type="button" disabled={disabled} onClick={onClick}>{actionLabels[action]}</button>
}

export function TesseraPage() {
  const [run, setRun] = useState<TesseraRun>()
  const [canvas, setCanvas] = useState<TesseraCanvas>()
  const [runId, setRunId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [agentHealth, setAgentHealth] = useState<'CHECKING' | 'WAKING' | 'ONLINE' | 'UNAVAILABLE'>('CHECKING')
  const [canvasHealth, setCanvasHealth] = useState<'CHECKING' | 'ONLINE' | 'UNAVAILABLE'>('CHECKING')
  const agentProbeFailures = useRef(0)

  const resetRun = () => {
    window.sessionStorage.removeItem(storedRunId)
    window.sessionStorage.removeItem(storedRunToken)
    setRun(undefined)
    setRunId('')
    setToken('')
    setError('')
  }

  const refresh = async (id = runId, credential = token) => {
    if (!id || !credential) return
    const [runResult, canvasResult] = await Promise.allSettled([
      getTesseraRun(id, credential), getTesseraCanvas(),
    ])
    if (canvasResult.status === 'fulfilled') {
      setCanvas(canvasResult.value)
      setCanvasHealth('ONLINE')
    } else setCanvasHealth('UNAVAILABLE')
    if (runResult.status === 'fulfilled') {
      setRun(runResult.value)
      setAgentHealth('ONLINE')
      return
    }
    throw runResult.reason
  }

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    const probe = async () => {
      const [agent, board] = await Promise.allSettled([getTesseraAgentHealth(), getTesseraCanvas()])
      if (cancelled) return
      if (agent.status === 'fulfilled') {
        agentProbeFailures.current = 0
        setAgentHealth('ONLINE')
      } else {
        agentProbeFailures.current += 1
        setAgentHealth(agentProbeFailures.current >= 3 ? 'UNAVAILABLE' : 'WAKING')
      }
      if (board.status === 'fulfilled') { setCanvas(board.value); setCanvasHealth('ONLINE') }
      else setCanvasHealth('UNAVAILABLE')
      const healthy = agent.status === 'fulfilled' && board.status === 'fulfilled'
      timer = window.setTimeout(probe, healthy ? 10_000 : 3_000)
    }
    void probe()
    const storedId = window.sessionStorage.getItem(storedRunId)
    const storedToken = window.sessionStorage.getItem(storedRunToken)
    if (storedId && storedToken) {
      setRunId(storedId); setToken(storedToken)
      void getTesseraRun(storedId, storedToken).then((restored) => {
        setRun(restored); setAgentHealth('ONLINE')
      }).catch(() => {
        window.sessionStorage.removeItem(storedRunId)
        window.sessionStorage.removeItem(storedRunToken)
        setRunId(''); setToken('')
      })
    }
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    if (!runId || !token) return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      const runResult = await Promise.resolve(getTesseraRun(runId, token)).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      if (cancelled) return
      if (runResult.status === 'fulfilled') {
        setRun(runResult.value); setAgentHealth('ONLINE'); setError('')
      } else {
        setError(runResult.reason instanceof Error ? runResult.reason.message : 'Tessera run refresh failed')
      }
      const delay = runResult.status === 'fulfilled' && runResult.value.state === 'COMPLETE' ? 5_000 : 2_000
      if (!cancelled) timer = window.setTimeout(poll, delay)
    }
    timer = window.setTimeout(poll, 2_000)
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [runId, token])

  const start = async () => {
    setLoading(true); setError('')
    try {
      const created = await createTesseraRun()
      setAgentHealth('ONLINE')
      setRunId(created.run.run_id); setToken(created.run_token); setRun(created.run)
      window.sessionStorage.setItem(storedRunId, created.run.run_id)
      window.sessionStorage.setItem(storedRunToken, created.run_token)
      await refresh(created.run.run_id, created.run_token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tessera hosted agent is unavailable')
    } finally { setLoading(false) }
  }

  const approve = async () => {
    if (!runId || !token || busy) return
    setBusy(true); setError('')
    try {
      setRun((current) => current ? { ...current, state: 'SETTLING' } : current)
      setRun(await approveTesseraRun(runId, token))
      await refresh(runId, token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tessera payment failed')
      try { await refresh(runId, token) } catch { /* Preserve the payment error. */ }
    } finally { setBusy(false) }
  }

  const act = async (action: TesseraActionName) => {
    if (!runId || !token || busy) return
    setBusy(true); setError('')
    try {
      await executeTesseraAction(runId, token, action)
      await refresh(runId, token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tessera action failed')
      try { await refresh() } catch { /* Preserve the original action error. */ }
    } finally { setBusy(false) }
  }

  const rootReady = Boolean(run?.root)
  const childReady = Boolean(run?.child)
  const completed = new Set(run?.actions.map((item) => item.action) ?? [])
  const action = run?.last_action
  const state = run?.state ?? 'READY'
  const agentDot = agentHealth === 'ONLINE' ? 'online' :
    ['CHECKING', 'WAKING'].includes(agentHealth) ? 'waking' : 'offline'

  return <main className="tessera-shell">
    <header className="site-header"><a className="brand" href="/">SCOPE<span>402</span></a>
      <nav aria-label="Tessera navigation"><a href="/">AUDITLAB</a><a href="/demo">LIVE DEMO</a></nav>
      <div className="mode"><span className={`status-dot ${agentDot}`} /> TESSERA · {agentHealth}</div>
    </header>

    <section className="tessera-hero"><div><span className="eyebrow">HEDERA TESTNET · TESSERA · SCOPE402</span>
      <h1>The canvas is the instrument.<br/><em>The lease is the product.</em></h1></div>
      <div className="tessera-hero-copy"><p>A guarded hosted agent buys one real 8 × 8 root capability, delegates a contained worker capability, and asks the server to prove every boundary.</p>
        <div className="tessera-hero-actions"><button className="button primary" type="button" onClick={start}
          disabled={loading || Boolean(runId) || agentHealth !== 'ONLINE'}>
          {loading ? 'CONTACTING AGENT…' : runId ? 'RUN IN PROGRESS' :
            agentHealth === 'UNAVAILABLE' ? 'TESSERA AGENT UNAVAILABLE' :
            agentHealth === 'WAKING' ? 'WAKING TESSERA AGENT…' :
            agentHealth === 'CHECKING' ? 'CHECKING TESSERA AGENT…' : 'START REAL TESSERA RUN'}</button>
          {runId && (state === 'COMPLETE' || state === 'FAILED' || error.includes('DEMO_RUN_EXPIRED')) &&
            <button className="button" type="button" onClick={resetRun}>START NEW RUN</button>}
          <a className="button" href={`${publicTesseraApiUrl}/v1/canvas`} target="_blank" rel="noreferrer">READ CANVAS ↗</a></div>
        <p className="tessera-boundary mono">PAYER: PLATFORM-FUNDED TESTNET · KEYS STAY SERVER-SIDE</p></div></section>

    <div className="tessera-status-strip"><div><small>HOSTED STATE</small><strong className="mono">{state}</strong></div>
      <div><small>RUN</small><strong className="mono">{runId ? short(runId) : 'NOT STARTED'}</strong></div>
      <div><small>POLICY HASH</small><strong className="mono">{short(run?.quote?.policy_hash ?? run?.root?.policy_hash, 14, 8)}</strong></div>
      <div><small>CANVAS</small><strong className="mono">{canvasHealth}</strong></div></div>

    <PurchaseProof run={run} />

    <div className="tessera-main-grid"><CapabilityTree run={run} /><CanvasPanel canvas={canvas} run={run} action={action} /></div>

    <section className="tessera-control"><div className="section-label">FIXED HOSTED-AGENT ACTIONS</div><h2>Ask the agent.<br/><em>Never sign in the tab.</em></h2>
      <p>Buttons request named scenarios only. The agent owns payment, P-256 subjects, delegation signatures, lease tokens, counters, and coordinates.</p>
      <div className="tessera-action-grid"><button className="button primary" type="button"
        disabled={busy || !['PAYMENT_REQUIRED', 'PAYMENT_RECOVERY'].includes(state)} onClick={() => void approve()}>
        {state === 'PAYMENT_RECOVERY' ? 'RECOVER PAID ROOT' : 'PAY FOR ROOT'}</button>
        <ActionButton action="delegate" disabled={busy || !rootReady || childReady} onClick={() => void act('delegate')} />
        <ActionButton action="place-outside" disabled={busy || !childReady || completed.has('place-outside')} onClick={() => void act('place-outside')} />
        <ActionButton action="wrong-key" disabled={busy || !completed.has('place-outside') || completed.has('wrong-key')} onClick={() => void act('wrong-key')} />
        <ActionButton action="place-inside" disabled={busy || !completed.has('wrong-key') || completed.has('place-inside')} onClick={() => void act('place-inside')} />
        <ActionButton action="replay" disabled={busy || !completed.has('place-inside') || completed.has('replay')} onClick={() => void act('replay')} />
        <ActionButton action="expire" disabled={busy || !completed.has('replay') || completed.has('expire')} onClick={() => void act('expire')} />
      </div>
      {error && <div className="demo-error" role="alert"><strong>
        {error.startsWith('TESSERA_AGENT_REVISION_UNAVAILABLE') ? 'TESSERA AGENT UPDATE REQUIRED' : 'RUN STOPPED'}
      </strong><code>{error}</code></div>}
    </section>

    <footer><span>Scope402 · Tessera capability tree</span><a href={`${publicTesseraAgentUrl}/health`} target="_blank" rel="noreferrer">AGENT HEALTH ↗</a><a href="/demo">AUDITLAB DEMO ↗</a></footer>
  </main>
}
