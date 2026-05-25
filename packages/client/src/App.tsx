import { useState, type FormEvent } from 'react'
import './App.css'

// The shape the API returns per rate — mirrors SearchRow in packages/api.
type SearchRow = {
  hospital: string
  borough: string | null
  code: string
  code_type: string | null
  description: string | null
  setting: string | null
  payer: string
  plan_name: string | null
  estimated_dollar: number | null
  is_exact_dollar: boolean
  methodology: string | null
}

type SearchResponse = { code: string; count: number; results: SearchRow[] }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

function App() {
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>(
    'idle',
  )
  const [data, setData] = useState<SearchResponse | null>(null)
  const [error, setError] = useState('')

  async function search(e: FormEvent) {
    e.preventDefault()
    const q = code.trim()
    if (!q) return

    setStatus('loading')
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/search?code=${encodeURIComponent(q)}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Search failed (${res.status})`)
      }
      setData((await res.json()) as SearchResponse)
      setStatus('done')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setStatus('error')
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Medicost</h1>
        <p>Search NYC hospital prices by billing code.</p>
      </header>

      <form className="search" onSubmit={search}>
        <input
          className="search-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Billing code, e.g. 70551"
          inputMode="text"
          autoFocus
          spellCheck={false}
        />
        <button className="search-btn" type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? 'Searching…' : 'Search'}
        </button>
      </form>

      <section className="results">
        {status === 'error' && <p className="msg error">{error}</p>}

        {status === 'done' && data && (
          <>
            <p className="msg count">
              {data.count === 0
                ? `No prices found for code ${data.code}.`
                : `${data.count} ${data.count === 1 ? 'rate' : 'rates'} for code ${data.code}, cheapest first.`}
            </p>

            {data.results.length > 0 && (
              <table className="results-table">
                <thead>
                  <tr>
                    <th>Price</th>
                    <th>Hospital</th>
                    <th>Payer</th>
                    <th>Procedure</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => (
                    <tr key={i}>
                      <td className="price">
                        {r.estimated_dollar == null ? (
                          <span className="no-price">{r.methodology ?? '—'}</span>
                        ) : (
                          <>
                            {dollars.format(r.estimated_dollar)}
                            {!r.is_exact_dollar && <span className="est">est.</span>}
                          </>
                        )}
                      </td>
                      <td>
                        {r.hospital}
                        {r.borough && <span className="sub">{r.borough}</span>}
                      </td>
                      <td>
                        {r.payer}
                        {r.plan_name && <span className="sub">{r.plan_name}</span>}
                      </td>
                      <td>
                        {r.description ?? '—'}
                        {r.setting && <span className="sub">{r.setting}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </main>
  )
}

export default App
