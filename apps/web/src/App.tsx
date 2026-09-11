import { motion } from 'motion/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { loadLiveState, publicApiUrl, type LiveState } from './api.js'

const DemoPage = lazy(() => import('./DemoPage.js').then((module) => ({ default: module.DemoPage })))
const TesseraPage = lazy(() => import('./TesseraPage.js').then((module) => ({ default: module.TesseraPage })))

const states = ['AGREE TERMS', 'PAY', 'RECEIVE PERMISSION', 'ENFORCE EVERY CALL']

const denials = [
  { number: '01', label: 'STOLEN LEASE', status: '403', code: 'SUBJECT_KEY_MISMATCH',
    copy: 'The lease is bound to the subject key declared before payment. Possession of the token is not enough.' },
  { number: '02', label: 'REPLAYED CALL', status: '403', code: 'REPLAY_DETECTED',
    copy: 'Each signed invocation advances one atomic counter. The same request cannot spend authority twice.' },
  { number: '03', label: 'EXPIRED AUTHORITY', status: '410', code: 'LEASE_EXPIRED',
    copy: 'The server enforces expiry from persisted state. A valid signature cannot revive a dead lease.' },
]

const useCases = [
  { number: '01', title: 'AI APIs', copy: 'Buy a short session for selected models or tools instead of handing an agent a permanent API key.' },
  { number: '02', title: 'Developer tools', copy: 'Pay for analysis once, then inspect findings or export results only for the purchased repository.' },
  { number: '03', title: 'Agent teams', copy: 'Let a principal give a worker a smaller task, budget, and lifetime without sharing its wallet or root key.' },
  { number: '04', title: 'Cloud and data', copy: 'Grant temporary access to one environment, service, or dataset instead of exposing a broad bearer credential.' },
]

function StatusRail({ live, checking, onRetry }: {
  live: LiveState
  checking: boolean
  onRetry: () => void
}) {
  const discovery = live.discovery
  const unavailable = checking || live.state === 'waking' ? 'WAITING FOR API' : 'UNAVAILABLE'
  const findingTool = discovery?.authorization.tools.find((tool) => tool.id === 'finding_details')
  return <div className="proof-strip" aria-label="Live Scope402 service status">
    <div><span className={`status-dot ${live.state}`} />
      <small>HEALTH</small><strong>{checking ? 'CHECKING' : live.health === 'online' ? 'ONLINE' : live.state.toUpperCase()}</strong>
      {live.state === 'online' && live.latencyMs !== undefined
        ? <button className="latency mono" type="button" onClick={onRetry}>{live.latencyMs} MS · REFRESH</button>
        : <button className="retry mono" type="button" onClick={onRetry} disabled={checking}>
          {checking ? 'CONTACTING…' : 'RETRY NOW'}</button>}</div>
    <div><small>DISCOVERY</small><strong className="mono">
      {checking ? 'CHECKING' : live.contract === 'online' ? 'ONLINE' : unavailable}</strong></div>
    <div><small>PAID RESOURCE</small><strong className="mono">
      {live.contract === 'online' ? discovery?.resources.repository_scan.path : unavailable}</strong></div>
    <div><small>AUTHORITY</small><strong className="mono">
      {live.contract === 'online' ? findingTool?.id : unavailable}</strong></div>
    <div><small>NETWORK</small><strong className="mono">
      {live.contract === 'online' ? discovery?.network : unavailable}</strong></div>
    {live.message && <p className="proof-message mono">{live.message}</p>}
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
  if (window.location.pathname.startsWith('/tessera')) return <Suspense fallback={<main className="route-loading">LOADING TESSERA MAP…</main>}><TesseraPage /></Suspense>
  if (window.location.pathname.startsWith('/demo')) return <Suspense fallback={<main className="route-loading">LOADING LIVE DEMO…</main>}><DemoPage /></Suspense>
  const [live, setLive] = useState<LiveState>({ state: 'waking', health: 'unavailable', contract: 'unavailable' })
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
    setLive({ state: 'waking', health: 'unavailable', contract: 'unavailable' })
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
        <a href="/demo">AUDITLAB</a>
        <a href="/tessera">TESSERA</a>
        <a href="#use-cases">USE CASES</a>
        <a href="#denials">PROOF</a>
      </nav>
      <div className="mode"><span className={`status-dot ${live.state}`} /> PUBLIC API</div>
    </header>

    <section className="hero" id="top">
      <div className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow">PAY ON HEDERA · CONTROL WHAT HAPPENS NEXT</div>
          <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}>Payment is not{' '}<br/><em>authorization.</em></motion.h1>
          <p className="lede">Agents can already pay for services. Scope402 makes sure that payment unlocks
            only the intended work—for the intended agent, within a clear budget and deadline.</p>
          <div className="hero-actions">
            <a className="button primary" href="/tessera">SEE TESSERA PROVE IT</a>
            <a className="button" href="#mechanism">WHY SCOPE402</a>
            <a className="button" href={`${publicApiUrl}/.well-known/scope402`}
              target="_blank" rel="noreferrer">OPEN AGENT CONTRACT <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <aside className="authority-preview" aria-label="What a Scope402 purchase creates">
          <div className="authority-preview-head"><span>WHAT ONE PAYMENT CREATES</span><b>scope402</b></div>
          <div className="authority-path" aria-hidden="true">
            <span>HBAR PAYMENT</span><i>→</i><strong>LIMITED PERMISSION</strong>
          </div>
          <p>The service receives proof of payment. For later actions, the agent receives only the permission written below.</p>
          <dl>
            <div><dt>WHO</dt><dd>one declared agent key</dd></div>
            <div><dt>WHERE</dt><dd>one purchased resource</dd></div>
            <div><dt>CAN DO</dt><dd>approved actions only</dd></div>
            <div><dt>LIMITS</dt><dd>call budget + expiry</dd></div>
          </dl>
          <div className="authority-delegation"><span>PRINCIPAL</span><i>narrows</i><span>WORKER</span></div>
        </aside>
      </div>
    </section>

    <section className="protocol-gap" id="mechanism">
      <span className="section-label">THE GAP</span>
      <div><strong className="mono">x402</strong><p>Answers: did the payment settle?</p></div>
      <div><strong className="mono">Scope402</strong><p>Answers: who can do what next—and for how long?</p></div>
    </section>

    <section className="contrast">
      <article className="problem-card">
        <span className="section-label">THE BEARER PROBLEM</span>
        <h2>Copied keys<br/>copy power.</h2>
        <div className="token mono" aria-label="Example bearer credential">bearer_token_••••••••</div>
        <p>A bearer token does not prove who is using it. If it is copied, another caller can try every action
          it allows—often without a built-in call limit or expiry.</p>
      </article>
      <article className="lease-card">
        <span className="section-label">WHAT THE PAYMENT BUYS</span>
        <h2>Permission<br/>with limits.</h2>
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
        <h2>Agree. Pay. Work. Enforce.</h2></div>
      <StateRail />
    </section>

    <section className="use-cases" id="use-cases">
      <div className="section-heading"><span className="section-label">WHERE IT FITS</span>
        <h2>Pay once. Work safely within limits.</h2></div>
      <div className="use-case-grid">
        {useCases.map((useCase) => <article key={useCase.number}>
          <span className="mono">{useCase.number}</span>
          <h3>{useCase.title}</h3>
          <p>{useCase.copy}</p>
        </article>)}
      </div>
    </section>

    <section className="denial-section" id="denials">
      <div className="section-heading"><span className="section-label">THE PROOF IS IN THE NO</span>
        <h2>The payment succeeds.<br/>Forbidden actions do not.</h2></div>
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

    <section className="tessera-invitation">
      <div>
        <span className="section-label">THE INTERACTIVE PROOF</span>
        <h2>Tessera makes permission visible.</h2>
        <p>A principal agent buys an 8 × 8 region, then gives a different worker only a 4 × 4 region and one
          call. Inside the worker’s boundary succeeds. Outside it is denied.</p>
      </div>
      <div className="tessera-shape" aria-label="A smaller worker region inside a purchased principal region">
        <span>PRINCIPAL · 8 × 8</span>
        <div><span>WORKER · 4 × 4 · 1 CALL</span><i aria-hidden="true" /></div>
      </div>
      <a className="button primary" href="/tessera">OPEN TESSERA</a>
    </section>

    <div id="status"><StatusRail live={live} checking={checking} onRetry={retryStatus} /></div>

    <section className="custody-section">
      <div className="section-heading"><span className="section-label">WHO HOLDS WHAT</span>
        <h2>Private keys never enter this page.</h2></div>
      <div className="custody-grid">
        <article><span>01</span><h3>PAYER AGENT</h3><p>Evaluates the quote, applies a spend policy, and signs the HBAR transfer.</p></article>
        <article><span>02</span><h3>PROTECTED SERVICE</h3><p>Settles the payment, performs the purchased work, and signs limited permission.</p></article>
        <article><span>03</span><h3>HEDERA</h3><p>Records the real transfer. The public Mirror Node proves money moved; it does not grant authority.</p>
          <a className="evidence-link mono"
            href="https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1788595940-223982333"
            target="_blank" rel="noreferrer">VERIFY ON HEDERA MIRROR NODE ↗</a></article>
      </div>
    </section>

    <section className="honesty">
      <span className="section-label">CURRENT BOUNDARY</span>
      <h2>A real payment.<br/>A narrow promise.</h2>
      <p>Public GitHub repositories, bounded root-file metering, Hedera testnet, one deterministic finding,
        and one lease-protected follow-up tool. No browser keys. No smart contract required for this enforcement
        path. No fake settlement.</p>
    </section>

    <footer><span>Scope402 · Limited permission after payment</span><a href="https://github.com/0xshobha/scope402" target="_blank" rel="noreferrer">SOURCE ↗</a>
      <a href={`${publicApiUrl}/health`} target="_blank" rel="noreferrer">API HEALTH ↗</a>
      <a href={`${publicApiUrl}/.well-known/scope402`} target="_blank" rel="noreferrer">DISCOVERY ↗</a></footer>
  </main>
}
