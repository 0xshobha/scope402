import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TesseraCanvas, TesseraCanvasSummary, TesseraLocation } from './tessera-api.js'

const WORLD_SPAN = 0.018

function worldBounds(location: TesseraLocation): L.LatLngBoundsLiteral {
  return [[location.latitude - WORLD_SPAN / 2, location.longitude - WORLD_SPAN / 2],
    [location.latitude + WORLD_SPAN / 2, location.longitude + WORLD_SPAN / 2]]
}

export function TesseraWorldMap({ canvases, selectedId, canvas, draftLocation, locked,
  onChooseWorld, onChooseLocation }: { canvases: TesseraCanvasSummary[]; selectedId: string;
    canvas?: TesseraCanvas; draftLocation: TesseraLocation; locked: boolean;
    onChooseWorld(id: string): void; onChooseLocation(location: TesseraLocation): void }) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layers = useRef<L.LayerGroup | null>(null)
  const focusedWorld = useRef('')
  const interaction = useRef({ canvases, selectedId, locked, onChooseLocation, onChooseWorld })
  interaction.current = { canvases, selectedId, locked, onChooseLocation, onChooseWorld }

  useEffect(() => {
    if (!container.current || map.current) return
    const instance = L.map(container.current, { minZoom: 2, maxZoom: 18, worldCopyJump: true,
      zoomControl: true }).setView([draftLocation.latitude, draftLocation.longitude], 13)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(instance)
    layers.current = L.layerGroup().addTo(instance)
    instance.on('click', (event) => {
      const current = interaction.current
      if (current.locked || current.canvases.some((item) => item.canvas_id === current.selectedId)) return
      current.onChooseLocation({ latitude: Number(event.latlng.lat.toFixed(5)),
        longitude: Number(event.latlng.lng.toFixed(5)) })
    })
    map.current = instance
    return () => { instance.remove(); map.current = null; layers.current = null }
  }, [])

  useEffect(() => {
    const group = layers.current
    const instance = map.current
    if (!group || !instance) return
    group.clearLayers()
    for (const world of canvases) {
      const marker = L.circleMarker([world.location.latitude, world.location.longitude], {
        radius: world.canvas_id === selectedId ? 10 : 7, color: '#0b0b0c', weight: 2,
        fillColor: world.canvas_id === selectedId ? '#c6f432' : '#7c4dff', fillOpacity: 0.95,
      }).bindTooltip(`${world.name} · ${world.painted_pixels} pixels`)
      marker.on('click', () => { if (!interaction.current.locked) interaction.current.onChooseWorld(world.canvas_id) })
      marker.addTo(group)
    }
    const location = canvas?.location ?? canvases.find((item) => item.canvas_id === selectedId)?.location ?? draftLocation
    const bounds = L.latLngBounds(worldBounds(location))
    L.rectangle(bounds, { color: '#c6f432', weight: 3, fillColor: '#7c4dff', fillOpacity: 0.12 }).addTo(group)
    for (let row = 0; row < 4; row += 1) for (let column = 0; column < 4; column += 1) {
      const south = bounds.getSouth() + row * WORLD_SPAN / 4
      const west = bounds.getWest() + column * WORLD_SPAN / 4
      L.rectangle([[south, west], [south + WORLD_SPAN / 4, west + WORLD_SPAN / 4]], {
        color: '#ffffff', weight: 1, opacity: 0.55, fillOpacity: 0,
      }).addTo(group)
    }
    for (const pixel of canvas?.pixels ?? []) {
      const cell = WORLD_SPAN / 32
      const north = bounds.getNorth() - pixel.y * cell
      const west = bounds.getWest() + pixel.x * cell
      L.rectangle([[north - cell, west], [north, west + cell]], {
        stroke: false, fillColor: pixel.color, fillOpacity: 1,
      }).bindTooltip(`${pixel.x},${pixel.y} · ${pixel.agent ?? 'agent'}`).addTo(group)
    }
    if (!canvases.some((item) => item.canvas_id === selectedId)) {
      L.circleMarker([location.latitude, location.longitude], { radius: 8, color: '#0b0b0c',
        fillColor: '#ffb020', fillOpacity: 1 }).bindTooltip('New world anchor').addTo(group)
    }
    const focusKey = `${selectedId}:${location.latitude}:${location.longitude}`
    if (focusedWorld.current !== focusKey) {
      instance.fitBounds(bounds.pad(1.7), { animate: false, maxZoom: 14 })
      focusedWorld.current = focusKey
    }
    window.setTimeout(() => instance.invalidateSize(), 0)
  }, [canvas, canvases, draftLocation, selectedId])

  return <section className="geo-world" aria-label="Geographic Tessera world map">
    <div className="geo-world-head"><div><span className="section-label">REAL-WORLD MAP</span>
      <h2>Choose where agents paint.</h2></div>
      <p>{canvases.some((item) => item.canvas_id === selectedId) ?
        'This marker is a persistent server world. Zoom and pan to inspect it.' :
        'Click anywhere on the map to anchor this new world before preparing its first quote.'}</p></div>
    <div ref={container} className="geo-map" />
    <div className="geo-location mono"><span>SELECTED WORLD · {selectedId}</span>
      <span>{draftLocation.latitude.toFixed(5)}, {draftLocation.longitude.toFixed(5)}</span></div>
  </section>
}
