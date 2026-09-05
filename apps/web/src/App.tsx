import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { loadLiveState, publicApiUrl, type LiveState } from './api.js'

const states = ['READY', 'PAYMENT REQUIRED', 'AGENT ACTION', 'SETTLED', 'SCAN COMPLETE', 'LEASE ACTIVE']

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
      <div className="mode"><span className={`status-dot ${live.state}`} /> PUBLIC API</div>
    </header>

    <section className="hero" id="top">
      <div className="eyebrow">HEDERA TESTNET · X402 V2 · AUDITLAB</div>
      <motion.h1 initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}>Payment is not<br/><em>authorization.</em></motion.h1>
      <p className="lede">A real HBAR payment buys useful work. Scope402 turns that purchase into narrow,
        key-bound authority that expires.</p>
      <div className="hero-actions">
        <a className="button primary" href="#mechanism">SEE THE MECHANISM</a>
        <a className="button" href={`${publicApiUrl}/.well-known/scope402`}
          target="_blank" rel="noreferrer">OPEN DISCOVERY ↗</a>
      </div>
    </section>

    <StatusRail live={live} />

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

    <footer><span>Scope402 · AuditLab</span><a href={`${publicApiUrl}/health`} target="_blank" rel="noreferrer">API HEALTH ↗</a>
      <a href={`${publicApiUrl}/.well-known/scope402`} target="_blank" rel="noreferrer">DISCOVERY ↗</a></footer>
  </main>
}
