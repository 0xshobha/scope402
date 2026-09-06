import { useEffect, useRef, useState } from 'react'
import { approveDemoRun, executeDemoAction, getDemoRun, prepareDemoRun, publicDemoAgentUrl,
  type DemoActionName, type DemoActionResult, type DemoRun } from './demo-api.js'

const steps = ['CHOOSE REPO', 'SEE TERMS', 'AGENT PAYS', 'PAYMENT CONFIRMED', 'SCAN FINISHED', 'PERMISSION READY']
const storedRunId = 'scope402-demo-run-id'
const storedRunToken = 'scope402-demo-run-token'

function activeStep(run: DemoRun | undefined, settling: boolean) {
  if (!run) return 0
  if (run.state === 'COMPLETE') return 5
  if (settling || run.state === 'SETTLING') return 2
  return 1
}

function short(value: string, start = 12, end = 8) {
  return value.length > start + end + 1 ? `${value.slice(0, start)}…${value.slice(-end)}` : value
}

function LeaseCountdown({ exp }: { exp: number }) {
  const [remaining, setRemaining] = useState(() => Math.max(0, exp - Math.floor(Date.now() / 1_000)))
  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(Math.max(0, exp - Math.floor(Date.now() / 1_000))), 1_000)
    return () => window.clearInterval(timer)
  }, [exp])
  const minutes = Math.floor(remaining / 60)
  const seconds = String(remaining % 60).padStart(2, '0')
  return <span className="mono">{minutes}:{seconds}</span>
}

function HoldToApprove({ amount, disabled, recovering, onApprove }: {
  amount: string
  disabled: boolean
  recovering: boolean
  onApprove: () => void
}) {
  const timer = useRef<number | undefined>(undefined)
  const [holding, setHolding] = useState(false)
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = undefined
    setHolding(false)
  }
  const start = () => {
    if (disabled || timer.current) return
    setHolding(true)
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      setHolding(false)
      onApprove()
    }, 700)
  }
  useEffect(() => clear, [])
  return <button className={`hold-button ${holding ? 'holding' : ''}`} type="button" disabled={disabled}
    onPointerDown={start} onPointerUp={clear} onPointerLeave={clear} onPointerCancel={clear}
    onKeyDown={(event) => { if (!event.repeat && ['Enter', ' '].includes(event.key)) start() }}
    onKeyUp={(event) => { if (['Enter', ' '].includes(event.key)) clear() }}>
    <span className="hold-sweep" aria-hidden="true" />
    <span className="hold-copy">{recovering ? 'HOLD TO RECOVER' : 'HOLD TO PAY'} <b className="mono">{Number(amount).toLocaleString()} TINYBARS</b></span>
  </button>
}

export function DemoPage() {
  const [repoUrl, setRepoUrl] = useState('')
  const [run, setRun] = useState<DemoRun>()
  const [token, setToken] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [settling, setSettling] = useState(false)
  const [activeAction, setActiveAction] = useState<DemoActionName>()
  const [actions, setActions] = useState<Partial<Record<DemoActionName, DemoActionResult>>>({})
  const [error, setError] = useState('')
  const currentStep = activeStep(run, settling)

  useEffect(() => {
    const runId = window.sessionStorage.getItem(storedRunId)
    const runToken = window.sessionStorage.getItem(storedRunToken)
    if (!runId || !runToken) return
    void getDemoRun(runId, runToken).then((restored) => {
      setRun(restored)
      setToken(runToken)
      setActions(restored.actions ?? {})
    }).catch(() => {
      window.sessionStorage.removeItem(storedRunId)
      window.sessionStorage.removeItem(storedRunToken)
    })
  }, [])

  const prepare = async (event: React.FormEvent) => {
    event.preventDefault()
    setPreparing(true)
    setError('')
    setRun(undefined)
    setToken('')
    setActions({})
    try {
      const prepared = await prepareDemoRun(repoUrl)
      setRun(prepared.run)
      setToken(prepared.run_token)
      setActions(prepared.run.actions ?? {})
      window.sessionStorage.setItem(storedRunId, prepared.run.run_id)
      window.sessionStorage.setItem(storedRunToken, prepared.run_token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Demo preparation failed')
    } finally {
      setPreparing(false)
    }
  }

  const execute = async (action: DemoActionName) => {
    if (!run || !token) return
    setActiveAction(action)
    setError('')
    try {
      const result = await executeDemoAction(run.run_id, token, action)
      setActions((current) => ({ ...current, [action]: result }))
      if (action === 'legitimate' && run.result) {
        setRun({ ...run, result: { ...run.result,
          lease: { ...run.result.lease, remaining_calls: result.remaining_calls } } })
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Capability action failed')
    } finally {
      setActiveAction(undefined)
    }
  }

  const approve = async () => {
    if (!run || !token) return
    setSettling(true)
    setError('')
    try {
      const approved = await approveDemoRun(run.run_id, token)
      setRun(approved)
      setActions(approved.actions ?? {})
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Payment failed')
    } finally {
      setSettling(false)
    }
  }

  return <main className="demo-shell">
    <header className="site-header">
      <a className="brand" href="/">SCOPE<span>402</span></a>
      <nav aria-label="Demo navigation"><a href="/">HOME</a><a href="/tessera">CANVAS DEMO</a></nav>
      <div className="mode"><span className="status-dot online" /> DEMO AGENT · TESTNET</div>
    </header>

    <section className="demo-hero">
      <div><span className="section-label">LIVE REPOSITORY DEMO</span>
        <h1>Pay for a scan.<br/><em>Keep access limited.</em></h1></div>
      <p>Paste a public GitHub repository. You will see the price and limits before the demo agent pays,
        then watch valid access succeed while stolen, replayed, and expired access fails.</p>
    </section>

    <ol className="demo-state-rail" aria-label="Live demo progress">
      {steps.map((step, index) => <li className={index <= currentStep ? 'active' : ''} key={step}>
        <span className="mono">{String(index + 1).padStart(2, '0')}</span><strong>{step}</strong></li>)}
    </ol>

    <section className="demo-grid">
      <div className="demo-control">
        <span className="section-label">01 · CHOOSE A REPOSITORY</span>
        <h2>Paste a public GitHub repo.</h2>
        <form onSubmit={prepare}>
          <label htmlFor="repo-url">PUBLIC GITHUB REPOSITORY</label>
          <input id="repo-url" type="url" required value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/repository" disabled={preparing || settling} />
          <button className="button primary" type="submit" disabled={preparing || settling}>
            {preparing ? 'GETTING PRICE & TERMS…' : 'SEE PRICE & TERMS'}
          </button>
        </form>
        <div className="agent-boundary">
          <strong>SAFE DEMO PAYMENT</strong>
          <span>Hedera testnet only</span><span>AuditLab only</span><span>Hard spend limit: 150,000 tinybars</span>
        </div>
        {error && <div className="demo-error" role="alert"><strong>RUN STOPPED</strong><code>{error}</code></div>}
      </div>

      <div className={`quote-panel ${run ? 'visible' : ''}`} aria-live="polite">
        {!run ? <div className="empty-quote"><span className="mono">402</span>
          <p>No payment yet. The exact price and permission limits will appear here first.</p></div> : <>
          <div className="quote-title"><span className="section-label">02 · REVIEW BEFORE PAYMENT</span>
            <span className="quote-status">REAL 402</span></div>
          <h2>{run.quote.repository}</h2>
          <dl className="quote-facts">
            <div><dt>PRICE</dt><dd className="mono">{Number(run.quote.pricing.total_tinybars).toLocaleString()} tinybars</dd></div>
            <div><dt>ROOT FILES CONSIDERED</dt><dd className="mono">{run.quote.pricing.files_considered}</dd></div>
            <div><dt>COMMIT</dt><dd className="mono" title={run.quote.commit_sha}>{short(run.quote.commit_sha)}</dd></div>
            <div><dt>PAYER AGENT</dt><dd className="mono">{run.quote.payer}</dd></div>
            <div><dt>MERCHANT</dt><dd className="mono">{run.quote.merchant}</dd></div>
            <div><dt>RAIL</dt><dd className="mono">HBAR · {run.quote.network}</dd></div>
          </dl>
          {!['COMPLETE', 'FAILED'].includes(run.state) && <HoldToApprove amount={run.quote.pricing.total_tinybars}
            disabled={settling} recovering={run.state === 'PAYMENT_RECOVERY'} onApprove={approve} />}
          {run.state === 'PAYMENT_RECOVERY' && <p className="settling-copy mono">NO NEW TRANSFER · RETRIES THE SAME SIGNED HEDERA TRANSACTION</p>}
          {settling && <p className="settling-copy mono">AGENT IS REVALIDATING · SIGNING · SETTLING…</p>}
        </>}
      </div>
    </section>

    {run?.result && <section className="run-result">
      <article className="settlement-card">
        <div className="result-label"><span>SETTLED</span><b className="mono">200</b></div>
        <h2>Payment confirmed.</h2>
        <dl>
          <div><dt>AMOUNT</dt><dd className="mono">{Number(run.result.payment.amount_tinybars).toLocaleString()} tinybars</dd></div>
          <div><dt>PAYER</dt><dd className="mono">{run.result.payment.payer}</dd></div>
          <div><dt>MERCHANT</dt><dd className="mono">{run.result.payment.merchant}</dd></div>
          <div><dt>TRANSACTION</dt><dd className="mono" title={run.result.payment.transaction}>{short(run.result.payment.transaction, 16, 10)}</dd></div>
        </dl>
        <a className="hashscan-link" href={run.result.payment.hashscan_url} target="_blank" rel="noreferrer">
          VERIFY ON HASHSCAN ↗</a>
      </article>

      <article className="scan-card">
        <div className="result-label"><span>SCAN COMPLETE</span><b className="mono">{run.result.findings.length}</b></div>
        <h2>{run.result.findings.length ? 'Repository checked.' : 'Scan finished clean.'}</h2>
        {run.result.findings.length ? <div className="finding-list">{run.result.findings.map((finding) =>
          <div key={finding.id}><span className="mono">{finding.severity.toUpperCase()}</span><strong>{finding.message}</strong>
            <code>{finding.id}</code></div>)}</div> :
          <p className="clean-copy">The paid scan completed against the bound commit. This repository did not trigger the current deterministic check.</p>}
      </article>

      <article className="result-lease-card">
        <div className="result-label"><span>LEASE ACTIVE</span><b><LeaseCountdown exp={run.result.lease.exp} /></b></div>
        <h2>Your permission is limited.</h2>
        <dl>
          <div><dt>ALLOWED TOOL</dt><dd className="mono">{run.result.lease.tool_ids.join(', ')}</dd></div>
          <div><dt>CALL BUDGET</dt><dd className="mono">{run.result.lease.remaining_calls} / {run.result.lease.max_calls}</dd></div>
          <div><dt>SUBJECT</dt><dd className="mono" title={run.result.lease.subject_pubkey}>{short(run.result.lease.subject_pubkey)}</dd></div>
          <div><dt>LEASE ID</dt><dd className="mono">{short(run.result.lease.lease_id)}</dd></div>
        </dl>
        <p>The demo agent keeps the signing key and permission token. This browser never receives either one.</p>
      </article>
    </section>}

    {run?.result && <section className="capability-lab">
      <div className="capability-intro">
        <span className="section-label">PROVE THE LIMITS</span>
        <h2>Use it correctly.<br/>Then test misuse.</h2>
        <p>Run one allowed request, then try a stolen key, the same request twice, and an expired permission.
          Every result below comes from the API.</p>
      </div>
      {!run.result.findings.length ? <div className="clean-capability">
        <strong className="mono">SCAN_CLEAN</strong>
        <p>No finding-specific authority is needed for this repository. Choose a repository with a real finding
          to run the capability attacks.</p>
      </div> : <div className="action-stack">
        <ActionRow number="01" label="LEGITIMATE SUBJECT" action="legitimate" result={actions.legitimate}
          disabled={Boolean(activeAction)} onRun={execute} />
        <ActionRow number="02" label="WRONG SUBJECT KEY" action="wrong-key" result={actions['wrong-key']}
          disabled={Boolean(activeAction) || !actions.legitimate} onRun={execute} />
        <ActionRow number="03" label="BYTE-IDENTICAL REPLAY" action="replay" result={actions.replay}
          disabled={Boolean(activeAction) || !actions.legitimate} onRun={execute} />
        <ActionRow number="04" label="SERVER-SIDE EXPIRY" action="expire" result={actions.expire}
          disabled={Boolean(activeAction) || !actions['wrong-key'] || !actions.replay} onRun={execute} />
      </div>}
    </section>}

    <footer><span>Scope402 · guarded hosted agent</span>
      <a href={`${publicDemoAgentUrl}/health`} target="_blank" rel="noreferrer">AGENT HEALTH ↗</a>
      <a href="https://github.com/0xshobha/scope402" target="_blank" rel="noreferrer">SOURCE ↗</a></footer>
  </main>
}

function ActionRow({ number, label, action, result, disabled, onRun }: {
  number: string
  label: string
  action: DemoActionName
  result?: DemoActionResult
  disabled: boolean
  onRun: (action: DemoActionName) => void
}) {
  const copy = action === 'legitimate' ? 'USE LEASE' : action === 'wrong-key' ? 'TRY STOLEN LEASE' :
    action === 'replay' ? 'REPLAY SAME CALL' : 'EXPIRE AND RETRY'
  return <article className={`action-row ${result ? result.verdict.toLowerCase() : ''}`}>
    <span className="mono action-number">{number}</span>
    <div><small>{label}</small>{result ? <>
      <strong className="mono">{result.status} · {result.code}</strong>
      <p>{result.message}</p>
    </> : <strong>{action === 'legitimate' ? 'Declared key · counter 1' :
      action === 'wrong-key' ? 'Different P-256 key · same lease' :
        action === 'replay' ? 'Same signed bytes · same counter' : 'Persisted expiry · valid signature'}</strong>}</div>
    <button className="button" type="button" disabled={disabled || Boolean(result)} onClick={() => onRun(action)}>
      {result ? result.verdict : copy}
    </button>
  </article>
}
