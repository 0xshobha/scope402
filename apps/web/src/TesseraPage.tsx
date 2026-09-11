import { useEffect, useMemo, useRef, useState } from 'react'
import {
  approveTesseraRun, createTesseraRun, executeTesseraAction, getTesseraAgentHealth,
  getTesseraCanvas, getTesseraCanvases, getTesseraRun, paintTesseraPixel, runTesseraMission,
  publicTesseraAgentUrl, publicTesseraApiUrl, subscribeTesseraCanvas,
  type CanvasRegion, type TesseraActionName, type TesseraActionResult,
  type TesseraCanvas, type TesseraCanvasSummary, type TesseraCapability, type TesseraLocation, type TesseraRun,
} from './tessera-api.js'
import { TesseraWorldMap } from './TesseraWorldMap.js'

const storedRunId = 'scope402-tessera-run-id'
const storedRunToken = 'scope402-tessera-run-token'
const storedCanvasId = 'scope402-tessera-canvas-id'
const canvasIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/

function initialCanvasId() {
  const linked = new URL(window.location.href).searchParams.get('world')
  if (linked && canvasIdPattern.test(linked)) return linked
  const stored = window.sessionStorage.getItem(storedCanvasId)
  return stored && canvasIdPattern.test(stored) ? stored : 'main'
}

function updateWorldUrl(canvasId: string) {
  const url = new URL(window.location.href)
  if (canvasId === 'main') url.searchParams.delete('world')
  else url.searchParams.set('world', canvasId)
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

const actionLabels: Record<TesseraActionName, string> = {
  delegate: '2 · GIVE WORKER LESS ACCESS', 'place-inside': '3 · PLACE ALLOWED PIXEL',
  replay: '4 · REPLAY SAME REQUEST', 'place-outside': '5 · TRY OUTSIDE ITS AREA',
  'wrong-key': '6 · TRY A DIFFERENT KEY', expire: '7 · EXPIRE AND RETRY',
}

type MissionTemplate = { id: string; name: string; description: string; principalColor: string;
  targets: Array<{ dx: number; dy: number; worker?: boolean }> }

const missionTemplates: MissionTemplate[] = [
  { id: 'spark', name: 'SIGNAL SPARK', description: 'The principal paints five amber pixels while a separate worker paints four violet pixels inside narrower authority.',
    principalColor: '#FFB020',
    targets: [
      { dx: 2, dy: 0 }, { dx: 2, dy: 1, worker: true }, { dx: 0, dy: 2 }, { dx: 1, dy: 2, worker: true },
      { dx: 2, dy: 2, worker: true }, { dx: 3, dy: 2, worker: true }, { dx: 4, dy: 2 },
      { dx: 2, dy: 3 }, { dx: 2, dy: 4 },
    ] },
]

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

function sameActor(capabilitySubject: string | undefined, pixelAgent: string | undefined) {
  if (!capabilitySubject || !pixelAgent) return false
  const capabilityDigest = capabilitySubject.split(':').at(-1)
  const pixelDigest = pixelAgent.split(':').at(-1)
  return Boolean(capabilityDigest && pixelDigest &&
    (capabilityDigest.startsWith(pixelDigest) || pixelDigest.startsWith(capabilityDigest)))
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
    <div className="tessera-tree-heading"><span className="section-label">ONE PAYMENT · TWO AGENTS</span>
      <h2>The worker gets<br/><em>less access.</em></h2>
      <p>The principal buys one area, then gives a different worker a smaller area, fewer calls, and less time.
        These values come from the server.</p>
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
    <div className="purchase-proof-heading"><span className="section-label">WHAT THIS PAYMENT BUYS</span>
      <h2>Check the limits<br/><em>before paying.</em></h2></div>
    <dl className="purchase-proof-grid">
      <div><dt>PRICE</dt><dd className="mono">{quote ? `${quote.pricing.total_tinybars} TINYBARS` : '—'}</dd></div>
      <div><dt>PAYER</dt><dd className="mono">{quote?.payer ?? '—'}</dd></div>
      <div><dt>MERCHANT</dt><dd className="mono">{quote?.merchant ?? '—'}</dd></div>
      <div><dt>NETWORK</dt><dd className="mono">{quote?.network?.toUpperCase() ?? '—'}</dd></div>
      <div><dt>RESOURCE</dt><dd className="mono">{quote ? `${quote.canvas_id} · ${regionLabel(quote.region)}${quote.location ? ` · ${quote.location.latitude.toFixed(4)}, ${quote.location.longitude.toFixed(4)}` : ''}` : '—'}</dd></div>
      <div><dt>POLICY HASH</dt><dd className="mono" title={quote?.policy_hash}>{short(quote?.policy_hash, 18, 10)}</dd></div>
    </dl>
    <div className={`settlement-proof ${payment ? 'settled' : ''}`}>
      <span className="mono">{payment ? `${payment.amount_tinybars} TINYBARS SETTLED` :
        quote ? 'NOT PAID · YOUR APPROVAL IS REQUIRED' : 'START TO SEE THE PRICE AND LIMITS'}</span>
      {payment && <a className="button" href={payment.hashscan_url} target="_blank" rel="noreferrer">
        VERIFY ON HASHSCAN ↗</a>}
    </div>
  </section>
}

function MissionReceipt({ run }: { run?: TesseraRun }) {
  const mission = run?.mission
  const receipt = mission?.receipt
  const painted = mission?.events.filter((event) => event.code === 'PIXEL_PLACED').length ?? 0
  const boundary = mission?.events.some((event) => event.code === 'OUT_OF_SCOPE') ?? false
  return <section className={`mission-receipt ${mission?.state.toLowerCase() ?? 'waiting'}`}
    aria-label="Autonomous mission progress and receipt">
    <div className="mission-receipt-head"><div><span className="section-label">MISSION RECEIPT</span>
      <h2>{mission?.state === 'COMPLETE' ? 'Signal built.' : mission?.state === 'RUNNING' ?
        'Agents are building.' : 'Ready after approval.'}</h2></div>
      <strong className="mono">{mission?.state ?? 'WAITING'}</strong></div>
    <div className="mission-score mono"><span>{painted} / {mission?.plan.requiredCalls ?? 9} PIXELS</span>
      <span>{boundary ? 'BOUNDARY ENFORCED' : 'BOUNDARY PENDING'}</span></div>
    <div className="mission-handoff"><div><small>PRINCIPAL</small><strong>5 amber pixels</strong></div>
      <b>→ 4 CALLS →</b><div><small>WORKER</small><strong>4 violet pixels</strong></div></div>
    {receipt && <dl><div><dt>PAYMENT</dt><dd className="mono">{short(receipt.payment_transaction, 13, 8)}</dd></div>
      <div><dt>ROOT</dt><dd className="mono">{short(receipt.root_lease_id, 13, 8)}</dd></div>
      <div><dt>WORKER</dt><dd className="mono">{short(receipt.worker_lease_id, 13, 8)}</dd></div>
      <div><dt>RESULT</dt><dd>{receipt.pixels_placed} pixels · 1 denial</dd></div></dl>}
  </section>
}

function eventTime(value: string | number | undefined) {
  if (value === undefined) return '—'
  const date = new Date(typeof value === 'number' ? value * 1_000 : value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function LiveProofLog({ run }: { run?: TesseraRun }) {
  const events: Array<{ key: string; time: string; actor: string; status: string; code: string; detail: string;
    tone: 'pending' | 'allowed' | 'denied'; href?: string }> = []
  if (run?.quote) events.push({ key: 'quote', time: eventTime(run.created_at), actor: 'PAYER AGENT',
    status: '402', code: 'TERMS PREPARED', tone: 'pending',
    detail: `${run.quote.canvas_id} · ${regionLabel(run.quote.region)} · ${run.quote.pricing.total_tinybars} tinybars · ${short(run.quote.policy_hash, 11, 6)}` })
  if (run?.payment) events.push({ key: 'payment', time: 'CHAIN', actor: 'HEDERA', status: '200',
    code: 'PAYMENT SETTLED', tone: 'allowed', href: run.payment.hashscan_url,
    detail: `${run.payment.amount_tinybars} tinybars · ${short(run.payment.transaction, 12, 8)}` })
  if (run?.root) events.push({ key: 'root', time: 'SERVER', actor: 'PRINCIPAL A', status: '201',
    code: 'ROOT CAPABILITY', tone: 'allowed',
    detail: `${regionLabel(run.root.resource)} · ${run.root.max_calls} calls · ${short(run.root.lease_id, 10, 6)}` })
  for (const paint of run?.paint_events ?? []) events.push({ key: `paint:${paint.request_id}`,
    time: eventTime(paint.pixel.updated_at), actor: 'PRINCIPAL A', status: String(paint.status),
    code: paint.code, tone: 'allowed',
    detail: `${paint.pixel.x},${paint.pixel.y} · ${paint.pixel.color} · ${paint.remaining_calls} calls left` })
  for (const item of run?.actions ?? []) events.push({ key: `action:${item.sequence}`, time: eventTime(item.at),
    actor: item.action === 'delegate' ? 'PRINCIPAL A' : item.action === 'expire' ? 'SERVER' : 'WORKER B',
    status: String(item.status), code: item.code, tone: item.verdict === 'ALLOWED' ? 'allowed' : 'denied',
    detail: item.pixel ? `${item.pixel.x},${item.pixel.y} · ${item.message}` : item.message })
  for (const item of run?.mission.events ?? []) events.push({ key: `mission:${item.sequence}`,
    time: eventTime(item.at), actor: item.actor.toUpperCase(),
    status: item.verdict === 'DENIED' ? '403' : item.code === 'MISSION_PLANNED' ? 'PLAN' : '200',
    code: item.code, tone: item.verdict === 'DENIED' ? 'denied' :
      item.verdict === 'PLANNED' ? 'pending' : 'allowed',
    detail: item.pixel ? `${item.pixel.x},${item.pixel.y} · ${item.message}` : item.message })
  return <section className="live-proof-log" aria-label="Persisted Scope402 proof log">
    <div className="live-proof-head"><div><span className="section-label">PERSISTED RUN LOG</span>
      <h2>See every decision.</h2></div><span className="live-indicator mono"><i /> LIVE</span></div>
    {events.length ? <ol>{events.map((event) => <li key={event.key} className={event.tone}>
      <div className="proof-event-meta mono"><time>{event.time}</time><span>{event.actor}</span></div>
      <div className="proof-event-result"><strong className="mono">{event.status} · {event.code}</strong>
        <p>{event.detail}</p>{event.href && <a href={event.href} target="_blank" rel="noreferrer">HASHSCAN ↗</a>}</div>
    </li>)}</ol> : <div className="proof-log-empty"><strong>NO RUN YET</strong>
      <p>Select open land and prepare its quote. Payment, authority, delegation, allowed actions, and denials will appear here.</p></div>}
  </section>
}

function CanvasPanel({ canvas, run, action, selected, onSelect, selectedSlot, onSlotSelect,
  selectedColor, onColor, onPaint, onPrepare, paintDisabled, preparing, previewWorld, liveTransport }: {
  canvas?: TesseraCanvas
  run?: TesseraRun
  action?: TesseraActionResult
  selected?: { x: number; y: number }
  onSelect(x: number, y: number): void
  selectedSlot?: number
  onSlotSelect(slot: number): void
  selectedColor: string
  onColor(color: string): void
  onPaint(): void
  onPrepare(): void
  paintDisabled: boolean
  preparing: boolean
  previewWorld?: { canvas_id: string; name: string }
  liveTransport: 'CONNECTING' | 'LIVE' | 'POLLING'
}) {
  const [zoom, setZoom] = useState(1)
  const missionId = 'spark'
  const pixels = useMemo(() => new Map((canvas?.pixels ?? []).map((pixel) => [`${pixel.x}:${pixel.y}`, pixel])), [canvas])
  const root = run?.root?.resource
  const child = run?.child?.resource
  const quotedRegion = run?.quote?.region
  const quotedSlot = quotedRegion ? Math.floor(quotedRegion.y / 8) * 4 + Math.floor(quotedRegion.x / 8) : undefined
  const chosenSlot = quotedSlot ?? selectedSlot
  const mission = missionTemplates.find((item) => item.id === missionId) ?? missionTemplates[0]!
  const missionOrigin = root ?? quotedRegion ?? (chosenSlot === undefined ? undefined : {
    x: (chosenSlot % 4) * 8, y: Math.floor(chosenSlot / 4) * 8,
  })
  const missionTargets = new Map(missionOrigin ? mission.targets.map((target) => [
    `${missionOrigin.x + target.dx}:${missionOrigin.y + target.dy}`, target,
  ]) : [])
  const missionComplete = missionOrigin ? mission.targets.filter((target) => {
    const pixel = pixels.get(`${missionOrigin.x + target.dx}:${missionOrigin.y + target.dy}`)
    const requiredColor = target.worker ? '#7C4DFF' : mission.principalColor
    return pixel?.color === requiredColor &&
      sameActor(target.worker ? run?.child?.subject : run?.root?.subject, pixel.agent)
  }).length : 0
  const territories = Array.from({ length: 16 }, (_, slot) => {
    const column = String.fromCharCode(65 + slot % 4)
    const row = Math.floor(slot / 4) + 1
    const active = canvas?.regions.find((region) => region.slot === slot && region.active)
    const expired = canvas?.regions.find((region) => region.slot === slot && !region.active)
    const reserved = canvas?.reservations.find((region) => region.slot === slot)
    const selectable = !run && !active && !reserved
    const status = active ? 'CLAIMED' : reserved ? 'RESERVED' : expired ? 'OPEN AGAIN' : 'AVAILABLE'
    const actor = active?.agent ?? reserved?.agent
    const expiresAt = active?.expires_at ?? reserved?.expires_at
    return { slot, label: `${column}${row}`, selectable, status, actor, expiresAt }
  })
  const cells = Array.from({ length: 32 * 32 }, (_, index) => {
    const x = index % 32
    const y = Math.floor(index / 32)
    const pixel = pixels.get(`${x}:${y}`)
    const missionTarget = missionTargets.get(`${x}:${y}`)
    const missionTargetColor = missionTarget?.worker ? '#7C4DFF' : mission.principalColor
    const missionTargetComplete = Boolean(missionTarget &&
      pixel?.color === missionTargetColor &&
      sameActor(missionTarget.worker ? run?.child?.subject : run?.root?.subject, pixel.agent))
    const claim = canvas?.regions.find((region) => region.active && x >= region.x && x < region.x + region.width &&
      y >= region.y && y < region.y + region.height)
    const reservation = canvas?.reservations.find((region) => x >= region.x && x < region.x + region.width &&
      y >= region.y && y < region.y + region.height)
    const slot = Math.floor(y / 8) * 4 + Math.floor(x / 8)
    const desiredCell = !root && chosenSlot === slot
    const desiredX = (slot % 4) * 8
    const desiredY = Math.floor(slot / 4) * 8
    const rootCell = root && x >= root.x && x < root.x + root.width && y >= root.y && y < root.y + root.height
    const childCell = child && x >= child.x && x < child.x + child.width && y >= child.y && y < child.y + child.height
    const chosen = selected?.x === x && selected.y === y
    return <button type="button" key={`${x}:${y}`}
      className={`canvas-cell ${missionTarget ? 'mission-target' : ''} ${missionTarget?.worker ? 'mission-worker' : ''} ${missionTargetComplete ? 'mission-complete' : ''} ${claim ? 'claimed-cell' : ''} ${claim && y === claim.y ? 'claim-top' : ''} ${claim && y === claim.y + claim.height - 1 ? 'claim-bottom' : ''} ${claim && x === claim.x ? 'claim-left' : ''} ${claim && x === claim.x + claim.width - 1 ? 'claim-right' : ''} ${reservation && y === reservation.y ? 'reservation-top' : ''} ${reservation && y === reservation.y + reservation.height - 1 ? 'reservation-bottom' : ''} ${reservation && x === reservation.x ? 'reservation-left' : ''} ${reservation && x === reservation.x + reservation.width - 1 ? 'reservation-right' : ''} ${desiredCell && y === desiredY ? 'desired-top' : ''} ${desiredCell && y === desiredY + 7 ? 'desired-bottom' : ''} ${desiredCell && x === desiredX ? 'desired-left' : ''} ${desiredCell && x === desiredX + 7 ? 'desired-right' : ''} ${rootCell ? 'root-cell' : ''} ${childCell ? 'child-cell' : ''} ${chosen ? 'selected-cell' : ''}`}
      style={pixel ? { backgroundColor: pixel.color } : undefined}
      title={`${x},${y}${missionTarget ? ` · mission needs ${missionTargetColor}` : ''}${pixel ? ` · ${pixel.color} · ${pixel.agent ?? 'pseudonymous painter'}` :
        claim ? ` · claimed by ${claim.agent ?? 'pseudonymous agent'}` :
          reservation ? ` · quote reserved by ${reservation.agent}` : ''}`}
      aria-label={`Pixel ${x}, ${y}${rootCell ? ' in your region' : ''}${missionTarget ?
        missionTarget.worker ? ' worker mission target' : ' principal mission target' : ''}`}
      disabled={root ? (!rootCell || run?.state === 'COMPLETE' || Boolean(missionTarget?.worker)) :
        (!canvas && !previewWorld) || Boolean(claim) || Boolean(reservation) || Boolean(run)}
      onClick={() => {
        if (!root) return onSlotSelect(slot)
        onSelect(x, y)
        if (missionTarget && !missionTarget.worker) onColor(missionTargetColor)
      }} />
  })
  return <section className="tessera-canvas-card" aria-label="Server authoritative canvas">
    <div className="tessera-panel-head"><div><span className="section-label">SHARED AGENT WORLD</span>
      <h2>{canvas?.world.name ?? previewWorld?.name ?? 'Claim it. Paint it. Delegate it.'}</h2></div>
      <div className="world-nav mono"><span className="canvas-size">32 × 32</span>
        <div className="zoom-controls" aria-label="World zoom">
          {[1, 2, 4].map((level) => <button type="button" key={level}
            aria-pressed={zoom === level} onClick={() => setZoom(level)}>{level}×</button>)}</div></div></div>
    <div className="mission-console" aria-label="Autonomous agent mission">
      <div><span className="section-label">AUTONOMOUS MISSION</span><strong>{mission.name}</strong>
        <p>{mission.description}</p></div>
      <div className="mission-progress mono"><span>{missionOrigin ? `${missionComplete} / ${mission.targets.length} CORRECT AGENT + COLOR` :
        'SELECT A TERRITORY TO PLACE THE GUIDE'}</span><span>■ PRINCIPAL {mission.principalColor} · ◆ WORKER #7C4DFF</span></div>
    </div>
    <div className="canvas-wrap" aria-label={`Opal World viewport at ${zoom} times zoom`}>
      <div className="canvas-grid" style={{ width: `${zoom * 100}%` }}>{cells}</div></div>
    <div className="paint-console" aria-label="Paint controls">
      <div className="pixel-palette">{(canvas?.palette ?? []).map((color) =>
        <button type="button" key={color} className={selectedColor === color ? 'selected-color' : ''}
          style={{ backgroundColor: color }} aria-label={`Select ${color}`} title={color}
          onClick={() => onColor(color)} />)}</div>
      <div className="paint-selection mono"><span>{selected ? `SELECTED · ${selected.x}, ${selected.y}` :
        run?.root ? 'SELECT A PIXEL INSIDE YOUR OUTLINED REGION' : chosenSlot === undefined ?
          'SELECT AN UNCLAIMED 8 × 8 TERRITORY' : run ? `TERRITORY ${chosenSlot + 1} RESERVED · REVIEW TERMS ABOVE` :
            `TERRITORY ${chosenSlot + 1} SELECTED`}</span>
        {root ? <button className="button primary" type="button" onClick={onPaint} disabled={paintDisabled}>
          PAINT WITH ROOT CAPABILITY</button> : <button className="button primary" type="button"
          onClick={onPrepare} disabled={preparing || chosenSlot === undefined || Boolean(run)}>
          {preparing ? 'PREPARING QUOTE…' : 'PREPARE SELECTED TERRITORY'}</button>}</div>
    </div>
    <div className="canvas-key mono"><span><i className="root-key" />YOUR ROOT</span><span><i className="child-key" />WORKER</span><span><i className="claim-key" />CLAIMED</span><span><i className="reservation-key" />QUOTE RESERVED</span><span><i className="pixel-key" />PIXEL</span></div>
    {canvas ? <p className="canvas-note mono">SHARED SERVER STATE · {liveTransport === 'LIVE' ? 'LIVE EVENT STREAM' :
      liveTransport === 'CONNECTING' ? 'CONNECTING LIVE UPDATES' : 'SAFE POLLING FALLBACK'} · {canvas.world.active_territories} CLAIMED · {canvas.world.reserved_territories} RESERVED · {canvas.pixels.length} PIXELS</p> :
      previewWorld ? <p className="canvas-note mono">NEW WORLD PREVIEW · ITS FIRST QUOTE CREATES THIS WORLD</p> :
        <p className="canvas-note mono">WAITING FOR CANVAS STATE</p>}
    {(canvas || previewWorld) && <div className="territory-roster" aria-label="World territories">
      <div className="territory-roster-head"><div><span className="section-label">16 TERRITORIES</span>
        <h3>Choose open land. Inspect every boundary.</h3></div>
        <p>Claims expire automatically. Reserved land is waiting for payment; open land can be quoted.</p></div>
      <div className="territory-grid">{territories.map((territory) =>
        <button type="button" key={territory.slot}
          className={`${selectedSlot === territory.slot ? 'selected' : ''} ${territory.status.toLowerCase().replace(' ', '-')}`}
          disabled={!territory.selectable || Boolean(run)} onClick={() => onSlotSelect(territory.slot)}>
          <span><strong>{territory.label}</strong><small>{territory.status}</small></span>
          {territory.actor ? <code>{territory.actor}</code> : <code>8 × 8 · 12 calls</code>}
          {territory.expiresAt !== undefined && <em><LeaseCountdown exp={territory.expiresAt} /> left</em>}
        </button>)}</div>
    </div>}
    {canvas && <div className="world-pulse" aria-label="Opal World activity">
      <div className="world-stats"><div><small>WORLD</small><strong>{canvas.world.name}</strong></div>
        <div><small>PAINTED</small><strong>{canvas.world.painted_pixels} / {canvas.world.total_pixels}</strong></div>
        <div><small>PAINT ACTIONS</small><strong>{canvas.world.total_placements}</strong></div>
        <div><small>COMPLETE</small><strong>{canvas.world.completion_percent}%</strong></div>
        <div><small>PIXEL OWNERS</small><strong>{canvas.world.current_painters}</strong></div></div>
      <div className="world-lists"><div><h3>TOP CONTRIBUTORS</h3>
        {canvas.leaderboard.length ? <ol>{canvas.leaderboard.slice(0, 5).map((entry) =>
          <li key={entry.agent}><code>{entry.agent}</code><b>{entry.placements} paints</b></li>)}</ol> :
          <p>Paint the first claimed pixel.</p>}</div>
        <div><h3>RECENT WORLD ACTIVITY</h3>
          {canvas.recent_activity.length ? <ol>{canvas.recent_activity.slice(0, 5).map((entry) =>
            <li key={`${entry.x}:${entry.y}:${entry.painted_at}:${entry.counter}`}><span><i style={{ backgroundColor: entry.color }} />
              <code>{entry.x},{entry.y}</code></span><code>{entry.agent}</code></li>)}</ol> :
          <p>No committed activity yet.</p>}</div></div>
    </div>}
    {action && <div className={`tessera-action-result ${action.verdict.toLowerCase()}`} role="status">
      <strong className="mono">{action.status} · {action.code}</strong><span>{action.message}</span>
    </div>}
  </section>
}

function ActionButton({ action, disabled, onClick }: { action: TesseraActionName; disabled: boolean; onClick: () => void }) {
  return <button className="button" type="button" disabled={disabled} onClick={onClick}>{actionLabels[action]}</button>
}

function ProofControls({ state, missionState, busy, rootReady, childReady, completed, error,
  onApprove, onMission, onAction }: {
  state: TesseraRun['state'] | 'READY'
  missionState: 'PLANNED' | 'RUNNING' | 'COMPLETE'
  busy: boolean
  rootReady: boolean
  childReady: boolean
  completed: Set<TesseraActionName>
  error: string
  onApprove(): void
  onMission(): void
  onAction(action: TesseraActionName): void
}) {
  return <section className="tessera-control" aria-label="Scope402 live proof controls">
    <div className="section-label">GOAL-FIRST AGENT MISSION</div>
    <h2>Approve once.<br/><em>Watch agents build.</em></h2>
    <p>The principal plans the Signal Spark, gives four contained calls to a different worker key,
      recovers from a denied boundary, and completes the artwork.</p>
    <div className="tessera-action-grid mission-actions"><button className="button primary" type="button"
      disabled={busy || !['PAYMENT_REQUIRED', 'PAYMENT_RECOVERY'].includes(state)} onClick={onApprove}>
      {state === 'PAYMENT_RECOVERY' ? '1 · RECOVER PAYMENT' : '1 · PAY FOR 8 × 8 AREA'}</button>
      <button className="button mission-run" type="button" disabled={busy || !rootReady ||
        missionState !== 'PLANNED' || completed.size > 0} onClick={onMission}>
        {missionState === 'RUNNING' ? 'AGENTS ARE BUILDING…' : missionState === 'COMPLETE' ?
          'MISSION COMPLETE' : '2 · RUN THE AGENT MISSION'}</button>
    </div>
    <details className="manual-proof"><summary>Manual security proof controls</summary>
      <p>Use these only instead of the autonomous mission. They expose each capability check separately.</p>
      <div className="tessera-action-grid">
        <ActionButton action="delegate" disabled={busy || !rootReady || childReady || missionState !== 'PLANNED'} onClick={() => onAction('delegate')} />
        <ActionButton action="place-inside" disabled={busy || !childReady || completed.has('place-inside') || missionState !== 'PLANNED'} onClick={() => onAction('place-inside')} />
        <ActionButton action="replay" disabled={busy || !completed.has('place-inside') || completed.has('replay') || missionState !== 'PLANNED'} onClick={() => onAction('replay')} />
        <ActionButton action="place-outside" disabled={busy || !completed.has('replay') || completed.has('place-outside') || missionState !== 'PLANNED'} onClick={() => onAction('place-outside')} />
        <ActionButton action="wrong-key" disabled={busy || !completed.has('place-outside') || completed.has('wrong-key') || missionState !== 'PLANNED'} onClick={() => onAction('wrong-key')} />
        <ActionButton action="expire" disabled={busy || !completed.has('wrong-key') || completed.has('expire') || missionState !== 'PLANNED'} onClick={() => onAction('expire')} />
      </div>
    </details>
    {error && <div className="demo-error" role="alert"><strong>{runErrorHeading(error)}</strong>
      <code>{error}</code></div>}
  </section>
}

function runErrorHeading(error: string) {
  if (error.startsWith('TESSERA_AGENT_REVISION_UNAVAILABLE')) return 'TESSERA AGENT UPDATE REQUIRED'
  if (error.startsWith('DEMO_RATE_LIMITED') || error.startsWith('DEMO_SPEND_LIMITED')) {
    return 'HOSTED DEMO CAPACITY REACHED'
  }
  if (error.startsWith('DEMO_RUN_ACTIVE')) return 'ANOTHER RUN IS STILL ACTIVE'
  if (error.startsWith('DEMO_BALANCE_FLOOR')) return 'DEMO WALLET SAFETY FLOOR REACHED'
  return 'RUN STOPPED'
}

export function TesseraPage() {
  const [run, setRun] = useState<TesseraRun>()
  const [canvas, setCanvas] = useState<TesseraCanvas>()
  const [canvases, setCanvases] = useState<TesseraCanvasSummary[]>([])
  const [canvasId, setCanvasId] = useState(initialCanvasId)
  const [worldInput, setWorldInput] = useState('')
  const [shareStatus, setShareStatus] = useState('COPY WORLD LINK')
  const [runId, setRunId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [agentHealth, setAgentHealth] = useState<'CHECKING' | 'WAKING' | 'ONLINE' | 'RETRYING' | 'UPDATE_REQUIRED'>('CHECKING')
  const [canvasHealth, setCanvasHealth] = useState<'CHECKING' | 'ONLINE' | 'NEW WORLD' | 'UNAVAILABLE'>('CHECKING')
  const [liveTransport, setLiveTransport] = useState<'CONNECTING' | 'LIVE' | 'POLLING'>('CONNECTING')
  const [selectedPixel, setSelectedPixel] = useState<{ x: number; y: number }>()
  const [selectedSlot, setSelectedSlot] = useState<number>()
  const [selectedColor, setSelectedColor] = useState('#7C4DFF')
  const [worldLocation, setWorldLocation] = useState<TesseraLocation>({ latitude: 19.076, longitude: 72.8777 })
  const agentProbeFailures = useRef(0)

  const resetRun = () => {
    window.sessionStorage.removeItem(storedRunId)
    window.sessionStorage.removeItem(storedRunToken)
    setRun(undefined)
    setRunId('')
    setToken('')
    setError('')
    setSelectedPixel(undefined)
    setSelectedSlot(undefined)
  }

  const refresh = async (id = runId, credential = token) => {
    if (!id || !credential) return
    const [runResult, canvasResult] = await Promise.allSettled([
      getTesseraRun(id, credential), getTesseraCanvas(canvasId),
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
      const [agent, catalogue] = await Promise.allSettled([
        getTesseraAgentHealth(), getTesseraCanvases(),
      ])
      if (cancelled) return
      if (agent.status === 'fulfilled') {
        agentProbeFailures.current = 0
        setAgentHealth('ONLINE')
      } else {
        const message = agent.reason instanceof Error ? agent.reason.message : ''
        if (message.startsWith('TESSERA_AGENT_REVISION_UNAVAILABLE')) {
          setAgentHealth('UPDATE_REQUIRED')
        } else {
          agentProbeFailures.current += 1
          setAgentHealth(agentProbeFailures.current >= 3 ? 'RETRYING' : 'WAKING')
        }
      }
      if (catalogue.status === 'fulfilled') setCanvases(catalogue.value)
      const healthy = agent.status === 'fulfilled' && catalogue.status === 'fulfilled'
      timer = window.setTimeout(probe, healthy ? 10_000 : 3_000)
    }
    void probe()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let streamHealthy = false
    const closeStream = subscribeTesseraCanvas(canvasId, {
      onCanvas: (board) => {
        if (cancelled) return
        streamHealthy = true
        setCanvas(board)
        setCanvasHealth('ONLINE')
      },
      onStatus: (status) => {
        if (cancelled) return
        streamHealthy = status === 'LIVE'
        setLiveTransport(status === 'LIVE' ? 'LIVE' : status === 'CONNECTING' ? 'CONNECTING' : 'POLLING')
      },
    })
    const pollCanvas = async () => {
      try {
        const board = await getTesseraCanvas(canvasId)
        if (cancelled) return
        setCanvas(board)
        setCanvasHealth('ONLINE')
      } catch {
        try {
          const catalogue = await getTesseraCanvases()
          if (cancelled) return
          setCanvases(catalogue)
          if (!catalogue.some((item) => item.canvas_id === canvasId)) {
            setCanvas(undefined)
            setCanvasHealth('NEW WORLD')
          } else setCanvasHealth('UNAVAILABLE')
        } catch {
          if (!cancelled) setCanvasHealth('UNAVAILABLE')
        }
      }
      if (!cancelled) timer = window.setTimeout(pollCanvas, streamHealthy ? 15_000 :
        document.visibilityState === 'hidden' ? 10_000 : 3_000)
    }
    void pollCanvas()
    return () => { cancelled = true; closeStream(); if (timer) window.clearTimeout(timer) }
  }, [canvasId])

  useEffect(() => {
    let cancelled = false
    const storedId = window.sessionStorage.getItem(storedRunId)
    const storedToken = window.sessionStorage.getItem(storedRunToken)
    if (storedId && storedToken) {
      setRunId(storedId); setToken(storedToken)
      void getTesseraRun(storedId, storedToken).then((restored) => {
        if (cancelled) return
        setRun(restored); setAgentHealth('ONLINE')
        if (restored.quote?.canvas_id && restored.quote.canvas_id !== canvasId) {
          setCanvasId(restored.quote.canvas_id)
          window.sessionStorage.setItem(storedCanvasId, restored.quote.canvas_id)
          updateWorldUrl(restored.quote.canvas_id)
        }
      }).catch(() => {
        if (cancelled) return
        window.sessionStorage.removeItem(storedRunId)
        window.sessionStorage.removeItem(storedRunToken)
        setRunId(''); setToken('')
      })
    }
    return () => { cancelled = true }
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
    if (selectedSlot === undefined) return
    setLoading(true); setError('')
    try {
      const created = await createTesseraRun(selectedSlot, canvasId,
        knownWorld ? undefined : worldLocation)
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

  const runMission = async () => {
    if (!runId || !token || busy) return
    setBusy(true); setError('')
    try {
      setRun((current) => current ? { ...current, state: 'MISSION_RUNNING',
        mission: { ...current.mission, state: 'RUNNING' } } : current)
      setRun(await runTesseraMission(runId, token))
      await refresh(runId, token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tessera mission failed')
      try { await refresh() } catch { /* Preserve the mission error. */ }
    } finally { setBusy(false) }
  }

  const paint = async () => {
    if (!runId || !token || !selectedPixel || busy) return
    setBusy(true); setError('')
    try {
      await paintTesseraPixel(runId, token, { request_id: crypto.randomUUID(),
        ...selectedPixel, color: selectedColor })
      await refresh(runId, token)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Tessera could not place the pixel')
      try { await refresh() } catch { /* Preserve the original paint error. */ }
    } finally { setBusy(false) }
  }

  const rootReady = Boolean(run?.root)
  const childReady = Boolean(run?.child)
  const completed = new Set(run?.actions.map((item) => item.action) ?? [])
  const action = run?.last_action
  const state = run?.state ?? 'READY'
  const agentDot = agentHealth === 'ONLINE' ? 'online' : 'waking'
  const agentHealthLabel = agentHealth === 'UPDATE_REQUIRED' ? 'UPDATE REQUIRED' : agentHealth
  const knownWorld = canvases.find((item) => item.canvas_id === canvasId)
  const previewWorld = canvasHealth === 'NEW WORLD' ? { canvas_id: canvasId,
    name: canvasId.split('-').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ') } : undefined
  const worldShareUrl = new URL(window.location.href)
  if (canvasId === 'main') worldShareUrl.searchParams.delete('world')
  else worldShareUrl.searchParams.set('world', canvasId)

  const chooseWorld = (nextCanvasId: string) => {
    if (runId || !canvasIdPattern.test(nextCanvasId)) return
    setCanvasId(nextCanvasId)
    setCanvas(undefined)
    setSelectedSlot(undefined)
    setSelectedPixel(undefined)
    setError('')
    setShareStatus('COPY WORLD LINK')
    const location = canvases.find((item) => item.canvas_id === nextCanvasId)?.location
    if (location) setWorldLocation(location)
    window.sessionStorage.setItem(storedCanvasId, nextCanvasId)
    updateWorldUrl(nextCanvasId)
  }

  const shareWorld = async () => {
    try {
      await navigator.clipboard.writeText(worldShareUrl.href)
      setShareStatus('WORLD LINK COPIED')
    } catch {
      setShareStatus('COPY FAILED · USE ADDRESS BAR')
    }
  }

  return <main className="tessera-shell">
    <header className="site-header"><a className="brand" href="/">SCOPE<span>402</span></a>
      <nav aria-label="Tessera navigation"><a href="/">HOME</a><a href="/demo">REPOSITORY DEMO</a></nav>
      <div className="mode"><span className={`status-dot ${agentDot}`} /> TESSERA · {agentHealthLabel}</div>
    </header>

    <section className="tessera-hero"><div><span className="eyebrow">LIVE MULTI-AGENT DEMO · HEDERA TESTNET</span>
      <h1>Buy an area.<br/><em>Share less access.</em></h1></div>
      <div className="tessera-hero-copy"><p>Watch one agent pay for an 8 × 8 canvas area, give a smaller 4 × 4 area to another agent,
        and prove that neither agent can exceed its limits. Choose an unclaimed territory on the world map first.</p>
        <div className="tessera-hero-actions"><button className="button primary" type="button" onClick={start}
          disabled={loading || Boolean(runId) || selectedSlot === undefined || ['CHECKING', 'WAKING'].includes(agentHealth)}>
          {loading ? 'CONTACTING AGENT…' : runId ? 'RUN IN PROGRESS' :
            agentHealth === 'UPDATE_REQUIRED' ? 'AGENT UPDATE REQUIRED' :
            agentHealth === 'RETRYING' ? 'RETRY & PREPARE QUOTE' :
            agentHealth === 'WAKING' ? 'WAKING TESSERA AGENT…' :
            agentHealth === 'CHECKING' ? 'CHECKING TESSERA AGENT…' : selectedSlot === undefined ?
              'SELECT A TERRITORY BELOW' : `SEE TERMS FOR TERRITORY ${selectedSlot + 1}`}</button>
          {runId && (state === 'MISSION_COMPLETE' || state === 'COMPLETE' || state === 'FAILED' || error.includes('DEMO_RUN_EXPIRED')) &&
            <button className="button" type="button" onClick={resetRun}>START NEW RUN</button>}
          <a className="button" href={`${publicTesseraApiUrl}/v1/canvas${canvasId === 'main' ? '' :
            `/${encodeURIComponent(canvasId)}`}`} target="_blank" rel="noreferrer">READ THIS WORLD ↗</a></div>
        <p className="tessera-boundary mono">DEMO AGENT PAYS ON TESTNET · PRIVATE KEYS NEVER ENTER THIS PAGE</p></div></section>

    <TesseraWorldMap canvases={canvases} selectedId={canvasId} canvas={canvas}
      draftLocation={canvas?.location ?? knownWorld?.location ?? worldLocation} locked={Boolean(runId)}
      selectedSlot={selectedSlot} onChooseWorld={chooseWorld} onChooseLocation={setWorldLocation}
      onChooseTerritory={(slot) => { setSelectedSlot(slot); setSelectedPixel(undefined) }} />

    <div className="tessera-status-strip"><div><small>HOSTED STATE</small><strong className="mono">{state}</strong></div>
      <div><small>RUN</small><strong className="mono">{runId ? short(runId) : 'NOT STARTED'}</strong></div>
      <div><small>POLICY HASH</small><strong className="mono">{short(run?.quote?.policy_hash ?? run?.root?.policy_hash, 14, 8)}</strong></div>
      <div><small>CANVAS</small><strong className="mono">{canvasHealth}</strong></div></div>

    <section className="mission-intent" aria-label="Signal Spark agent mission">
      <div><span className="section-label">MISSION · SIGNAL SPARK</span>
        <h2>Two agents. One paid territory. One finished mark.</h2>
        <p>The principal will plan and paint five amber pixels. It will give a second P-256 key only the
          3 × 2 area and four calls needed for the violet pixels. One attempted escape must fail without spending a call.</p></div>
      <ol className="mono"><li>INSPECT WORLD</li><li>CHECK QUOTE</li><li>APPROVE HBAR</li>
        <li>DELEGATE LESS</li><li>BUILD + PROVE</li></ol>
    </section>

    <section className="world-picker" aria-label="Choose an Opal World canvas">
      <div><span className="section-label">PUBLIC WORLDS</span><h2>Choose a world—or name a new one.</h2>
        <p>The first territory quote creates a new world. Every later payment and paint remains bound to that exact world.</p></div>
      <div className="world-picker-controls">
        <label>EXISTING WORLD<select value={knownWorld ? canvasId : ''} disabled={Boolean(runId)}
          onChange={(event) => chooseWorld(event.target.value)}>
          {!knownWorld && <option value="">NEW · {canvasId}</option>}
          {canvases.map((item) => <option key={item.canvas_id} value={item.canvas_id}>
            {item.name} · {item.painted_pixels} pixels</option>)}</select></label>
        <div className="world-share-row"><button className="button world-share" type="button"
          onClick={() => void shareWorld()}>{shareStatus}</button>
          <a href={worldShareUrl.href} aria-label={`Open shareable link for ${canvas?.world.name ?? previewWorld?.name ?? canvasId}`}>
            OPEN SHARE LINK ↗</a></div>
        <form onSubmit={(event) => { event.preventDefault(); chooseWorld(worldInput); setWorldInput('') }}>
          <label>NEW WORLD SLUG<input value={worldInput} disabled={Boolean(runId)} maxLength={32}
            pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?" placeholder="agent-garden"
            onChange={(event) => setWorldInput(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} /></label>
          <button className="button" type="submit" disabled={Boolean(runId) ||
            !canvasIdPattern.test(worldInput)}>PREVIEW NEW WORLD</button>
        </form>
      </div>
    </section>

    <div className="tessera-main-grid"><CanvasPanel canvas={canvas} run={run} action={action}
      selected={selectedPixel} onSelect={(x, y) => setSelectedPixel({ x, y })}
      selectedSlot={selectedSlot} onSlotSelect={setSelectedSlot}
      selectedColor={selectedColor} onColor={setSelectedColor} onPaint={() => void paint()}
      onPrepare={() => void start()} preparing={loading}
      previewWorld={previewWorld} liveTransport={liveTransport}
      paintDisabled={busy || !rootReady || !selectedPixel || state === 'COMPLETE' ||
        run?.mission.state !== 'PLANNED' ||
        (!childReady && (run?.root?.remaining_calls ?? 0) <= 1) || (run?.root?.remaining_calls ?? 0) < 1} />
      <aside className="tessera-proof-stack" aria-label="Purchase and capability proof">
        <PurchaseProof run={run} />
        <MissionReceipt run={run} />
        <ProofControls state={state} missionState={run?.mission.state ?? 'PLANNED'} busy={busy}
          rootReady={rootReady} childReady={childReady}
          completed={completed} error={error} onApprove={() => void approve()}
          onMission={() => void runMission()}
          onAction={(nextAction) => void act(nextAction)} />
        <LiveProofLog run={run} />
        <CapabilityTree run={run} />
      </aside></div>

    <section className="agent-entry" aria-label="Use Tessera from an external agent">
      <div><span className="section-label">BUILD ON SCOPE402</span>
        <h2>Your own agent can join.</h2>
        <p>Read live worlds without payment, plan available territory, validate the exact quote, then explicitly
          approve HBAR. The reference SDK handles P-256 subjects, counters, retries, and narrower delegation.</p></div>
      <div className="agent-entry-code"><code>scope402 watch {canvasId}</code>
        <span>READ-ONLY · NO HBAR MOVED</span>
        <div><a className="button" href="/docs/agent-quickstart.md" target="_blank" rel="noreferrer">
          AGENT QUICKSTART ↗</a><a href="/openapi.json" target="_blank" rel="noreferrer">OPENAPI ↗</a></div></div>
    </section>

    <footer><span>Scope402 · Tessera capability tree</span><a href={`${publicTesseraAgentUrl}/health`} target="_blank" rel="noreferrer">AGENT HEALTH ↗</a><a href="/demo">AUDITLAB DEMO ↗</a></footer>
  </main>
}
