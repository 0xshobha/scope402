export async function fetchReadOnly(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 10_000) {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status < 500 || attempt === 1) return response
      lastError = new Error(`Upstream returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 1) throw error
    }
    await new Promise((resolve) => window.setTimeout(resolve, 350))
  }
  throw lastError
}
