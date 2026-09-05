import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { loadLiveState, publicApiUrl, type LiveState } from './api.js'

const states = ['READY', 'PAYMENT REQUIRED', 'AGENT ACTION', 'SETTLED', 'SCAN COMPLETE', 'LEASE ACTIVE']

const denials = [
  { number: '01', label: 'STOLEN LEASE', status: '403', code: 'SUBJECT_KEY_MISMATCH',
    copy: 'The lease is bound to the payer agent’s P-256 key. Possession of the token is not enough.' },
  { number: '02', label: 'REPLAYED CALL', status: '403', code: 'REPLAY_DETECTED',
    copy: 'Each signed invocation advances one atomic counter. The same request cannot spend authority twice.' },
  { number: '03', label: 'EXPIRED AUTHORITY', status: '410', code: 'LEASE_EXPIRED',
    copy: 'The server enforces expiry from persisted state. A valid signature cannot revive a dead lease.' },
]

function StatusRail({ live }: { live: LiveState }) {
  const discovery = live.discovery
  return <div className="proof-strip" aria-label="Live Scope402 service status">
    <div><span className={`status-dot ${live.state}`} />
      <small>API</small><strong>{live.state === 'online' ? 'ONLINE' : live.state.toUpperCase()}</strong></div>
    <div><small>PAID RESOURCE</small><strong className="mono">
      {discovery?.resources.repository_scan.path ?? 'CHECKING…'}</strong></div>
    <div><small>AUTHORITY</small><strong className="mono">
      {discovery?.authorization.tools[0]?.id ?? 'CHECKING…'}</strong></div>
    <div><small>NETWORK</small><strong className="mono">{discovery?.network ?? 'CHECKING…'}</strong></div>
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
  const [live, setLive] = useState<LiveState>({ state: 'waking' })
  useEffect(() => { void loadLiveState().then(setLive) }, [])
  return <main>
    <header className="site-header">
      <a className="brand" href="#top">SCOPE<span>402</span></a>
      <nav aria-label="Primary navigation">
        <a href="#mechanism">MECHANISM</a>
        <a href="#denials">DENIALS</a>
      </nav>
      <div className="mode"><span className={`status-dot ${live.state}`} /> PUBLIC API</div>
    </header>

    <section className="hero" id="top">
      <div className="eyebrow">HEDERA TESTNET · X402 V2 · AUDITLAB</div>
      <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}>Payment is not<br/><em>authorization.</em></motion.h1>
      <p className="lede">A real HBAR payment buys useful work. Scope402 turns that purchase into narrow,
        key-bound authority that expires.</p>
      <div className="hero-actions">
        <a className="button primary" href="#proof">EXPLORE THE LIVE SYSTEM</a>
        <a className="button" href={`${publicApiUrl}/.well-known/scope402`}
          target="_blank" rel="noreferrer">READ LIVE CONTRACT <span aria-hidden="true">↗</span></a>
      </div>
      <div className="hero-index mono" aria-hidden="true"><span>PAY</span><span>WORK</span><span>AUTHORIZE</span></div>
    </section>

    <div id="proof"><StatusRail live={live} /></div>

    <section className="contrast" id="mechanism">
      <article className="problem-card">
        <span className="section-label">THE BEARER PROBLEM</span>
        <h2>Hold the key.<br/>Hold everything.</h2>
        <div className="token mono">sk_live_••••••••••••</div>
        <p>Copied credentials inherit the same authority. No subject binding. No call budget. No natural end.</p>
      </article>
      <article className="lease-card">
        <span className="section-label">THE SCOPE402 SWAP</span>
        <h2>Pay once.<br/>Receive boundaries.</h2>
        <dl>
          <div><dt>SUBJECT</dt><dd className="mono">P-256 KEY BOUND</dd></div>
          <div><dt>TOOLS</dt><dd className="mono">EXPLICIT ALLOWLIST</dd></div>
          <div><dt>BUDGET</dt><dd className="mono">ATOMIC COUNTER</dd></div>
          <div><dt>EXPIRY</dt><dd className="mono">SERVER ENFORCED</dd></div>
        </dl>
      </article>
    </section>

    <section className="flow-section">
      <div className="section-heading"><span className="section-label">ONE PURCHASE · SIX REAL STATES</span>
        <h2>The payment is only the middle.</h2></div>
      <StateRail />
    </section>

    <section className="purchase-section">
      <div className="purchase-intro">
        <span className="section-label">WHAT THE PAYMENT BINDS</span>
        <h2>A priced snapshot.<br/>Not a moving target.</h2>
        <p>The server-persisted x402 quote binds the repository, exact commit, metered workload,
          payer subject, merchant, and amount before the agent signs.</p>
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
