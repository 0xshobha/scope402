import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { loadLiveState, publicApiUrl, type LiveState } from './api.js'
import { DemoPage } from './DemoPage.js'

const states = ['DISCOVER', 'PAY', 'WORK', 'AUTHORITY']

const denials = [
  { number: '01', label: 'STOLEN LEASE', status: '403', code: 'SUBJECT_KEY_MISMATCH',
    copy: 'The lease is bound to the subject key declared before payment. Possession of the token is not enough.' },
  { number: '02', label: 'REPLAYED CALL', status: '403', code: 'REPLAY_DETECTED',
    copy: 'Each signed invocation advances one atomic counter. The same request cannot spend authority twice.' },
  { number: '03', label: 'EXPIRED AUTHORITY', status: '410', code: 'LEASE_EXPIRED',
    copy: 'The server enforces expiry from persisted state. A valid signature cannot revive a dead lease.' },
]

function StatusRail({ live, checking, onRetry }: {
  live: LiveState
  checking: boolean
  onRetry: () => void
}) {
  const discovery = live.discovery
  const unavailable = checking || live.state === 'waking' ? 'WAITING FOR API' : 'UNAVAILABLE'
  return <div className="proof-strip" aria-label="Live Scope402 service status">
    <div><span className={`status-dot ${live.state}`} />
      <small>API</small><strong>{checking ? 'CHECKING' : live.state === 'online' ? 'ONLINE' : live.state.toUpperCase()}</strong>
      {live.state === 'online' && live.latencyMs !== undefined
        ? <button className="latency mono" type="button" onClick={onRetry}>{live.latencyMs} MS · REFRESH</button>
        : <button className="retry mono" type="button" onClick={onRetry} disabled={checking}>
          {checking ? 'CONTACTING…' : 'RETRY NOW'}</button>}</div>
    <div><small>PAID RESOURCE</small><strong className="mono">
      {live.state === 'online' ? discovery?.resources.repository_scan.path : unavailable}</strong></div>
    <div><small>AUTHORITY</small><strong className="mono">
      {live.state === 'online' ? discovery?.authorization.tools[0]?.id : unavailable}</strong></div>
    <div><small>NETWORK</small><strong className="mono">
      {live.state === 'online' ? discovery?.network : unavailable}</strong></div>
  </div>
}

function StateRail() {
  return <ol className="state-rail" aria-label="Scope402 run states">
    {states.map((state, index) => <motion.li key={state}
      initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }} transition={{ delay: index * 0.06, duration: 0.22 }}>
      <span>{String(index + 1).padStart(2, '0')}</span>{state}
    </motion.li>)}
  </ol>
}

export function App() {
  if (window.location.pathname.startsWith('/demo')) return <DemoPage />
  const [live, setLive] = useState<LiveState>({ state: 'waking' })
  const [checking, setChecking] = useState(true)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    setChecking(true)
    void loadLiveState().then((result) => {
      if (cancelled) return
      setLive(result)
      setChecking(false)
      if (result.state !== 'online') {
        const delay = Math.min(5_000 * 2 ** Math.min(refresh, 2), 20_000)
        retry = setTimeout(() => setRefresh((value) => value + 1), delay)
      }
    })
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
    }
  }, [refresh])
  const retryStatus = () => {
    setLive({ state: 'waking' })
    setRefresh((value) => value + 1)
  }
  return <main>
    <header className="site-header">
      <a className="brand" href="#top" aria-label="Scope402 home">
        <span className="brand-mark" aria-hidden="true">
          <img src="/scope402-logo.png" width="78" height="78" alt="" />
        </span>
        <span className="brand-wordmark">SCOPE<span>402</span></span>
      </a>
      <nav aria-label="Primary navigation">
        <a href="/demo">LIVE DEMO</a>
        <a href="#mechanism">MECHANISM</a>
        <a href="#denials">DENIALS</a>
      </nav>
      <div className="mode"><span className={`status-dot ${live.state}`} /> PUBLIC API</div>
    </header>

    <section className="hero" id="top">
      <div className="eyebrow">HEDERA TESTNET · X402 V2 · AUDITLAB</div>
      <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}>Payment is not<br/><em>authorization.</em></motion.h1>
      <p className="lede">One HBAR payment buys useful work and a five-minute, three-call capability to one tool,
        usable only by the declared P-256 subject key.</p>
      <div className="hero-actions">
        <a className="button primary" href="/demo">RUN THE LIVE DEMO</a>
        <a className="button" href="#proof">CHECK API STATUS</a>
        <a className="button" href={`${publicApiUrl}/.well-known/scope402`}
          target="_blank" rel="noreferrer">READ LIVE CONTRACT <span aria-hidden="true">↗</span></a>
      </div>
      <div className="hero-index mono" aria-hidden="true"><span>PAY</span><span>WORK</span><span>AUTHORIZE</span></div>
    </section>

    <div id="proof"><StatusRail live={live} checking={checking} onRetry={retryStatus} /></div>

    <section className="protocol-gap">
      <span className="section-label">THE GAP</span>
      <div><strong className="mono">x402</strong><p>Settles the paid request.</p></div>
      <div><strong className="mono">Scope402</strong><p>Enforces which subject may use which tool, how often, and until when.</p></div>
    </section>

    <section className="contrast" id="mechanism">
      <article className="problem-card">
        <span className="section-label">THE BEARER PROBLEM</span>
        <h2>Hold the key.<br/>Hold everything.</h2>
        <div className="token mono">sk_live_••••••••••••</div>
        <p>Copied credentials inherit the same authority. No subject binding. No call budget. No natural end.</p>
      </article>
      <article className="lease-card">
        <span className="section-label">WHAT THE PAYMENT BUYS</span>
        <h2>One tool.<br/>Hard boundaries.</h2>
        <dl>
          <div><dt>SUBJECT</dt><dd className="mono">P-256 · DECLARED BEFORE PAY</dd></div>
          <div><dt>TOOL</dt><dd className="mono">finding_details</dd></div>
          <div><dt>BUDGET</dt><dd className="mono">3 CALLS</dd></div>
          <div><dt>EXPIRY</dt><dd className="mono">5 MINUTES</dd></div>
        </dl>
      </article>
    </section>

    <section className="flow-section">
      <div className="section-heading"><span className="section-label">ONE PURCHASE · FOUR DECISIONS</span>
        <h2>Discover. Pay. Work. Authorize.</h2></div>
      <StateRail />
    </section>

    <section className="purchase-section">
      <div className="purchase-intro">
        <span className="section-label">WHAT THE PAYMENT BINDS</span>
        <h2>A priced snapshot.<br/>Not a moving target.</h2>
        <p>The server-persisted x402 quote binds the repository, exact commit, metered workload,
          declared subject key, merchant, and amount before the agent signs.</p>
      </div>
      <div className="meter-card">
        <div className="meter-head"><span className="section-label">BOUNDED METER</span><strong>ROOT FILES</strong></div>
        <div className="formula mono"><span>BASE</span><b>+</b><span>UNIT × ROOT FILES</span><b>≤</b><span>CAP</span></div>
        <div className="binding-list mono">
          <span>REPOSITORY</span><strong>owner / repo</strong>
          <span>COMMIT</span><strong>immutable SHA</strong>
          <span>SUBJECT</span><strong>P-256 fingerprint</strong>
          <span>PAYMENT</span><strong>HBAR tinybars</strong>
        </div>
      </div>
    </section>

    <section className="denial-section" id="denials">
      <div className="section-heading"><span className="section-label">THE PROOF IS IN THE NO</span>
        <h2>Payment succeeds.<br/>The attacks still fail.</h2></div>
      <div className="denial-grid">
        {denials.map((denial, index) => <motion.article key={denial.code}
          initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}
          transition={{ delay: index * 0.08, duration: 0.24 }}>
          <div className="denial-top"><span className="mono">{denial.number}</span><span>{denial.label}</span></div>
          <div className="denial-code"><strong className="mono">{denial.status}</strong><code>{denial.code}</code></div>
          <p>{denial.copy}</p>
        </motion.article>)}
      </div>
    </section>

    <section className="custody-section">
      <div className="section-heading"><span className="section-label">WHO HOLDS WHAT</span>
        <h2>Keys stay out of the browser.</h2></div>
      <div className="custody-grid">
        <article><span>01</span><h3>PAYER AGENT</h3><p>Evaluates the quote, applies a spend policy, and signs the HBAR transfer.</p></article>
        <article><span>02</span><h3>AUDITLAB</h3><p>Settles through Blocky402, scans the bound commit, and signs the ToolLease.</p></article>
        <article><span>03</span><h3>HEDERA</h3><p>Records the real transfer. HashScan proves money moved; it does not grant authority.</p></article>
      </div>
    </section>

    <section className="honesty">
      <span className="section-label">CURRENT BOUNDARY</span>
      <h2>Real mechanism. Narrow merchant.</h2>
      <p>Public GitHub repositories, bounded root-file metering, Hedera testnet, one deterministic finding,
        and one lease-protected follow-up tool. No browser keys. No smart contract. No fake settlement.</p>
    </section>

    <footer><span>Scope402 · AuditLab</span><a href="https://github.com/0xshobha/scope402" target="_blank" rel="noreferrer">SOURCE ↗</a>
      <a href={`${publicApiUrl}/health`} target="_blank" rel="noreferrer">API HEALTH ↗</a>
      <a href={`${publicApiUrl}/.well-known/scope402`} target="_blank" rel="noreferrer">DISCOVERY ↗</a></footer>
  </main>
}
