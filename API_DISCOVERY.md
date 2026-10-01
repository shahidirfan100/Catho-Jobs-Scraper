# API Discovery - Catho.com.br

## Summary

Catho is **not** a Next.js site. The previous actor assumed `script#__NEXT_DATA__`, hydration globals, and JSON-LD on listing pages; none of those exist, which is why extraction failed. The site is server-rendered HTML behind an AWS ELB / WAF (`server: awselb/2.0`) that returns `403 Forbidden` for non-Brazilian / datacenter traffic and for non-browser TLS fingerprints.

A browser is **not required**. Two HTTP endpoints return all required data when requested through a country-matched Brazil residential proxy with a real browser TLS/HTTP profile.

## Selected endpoints

| Purpose | Endpoint | Method | Auth |
|---|---|---|---|
| Listing (offer ids + card fallback) | `https://www.catho.com.br/vagas/<keyword>[/<location>]/?page=N&lastdays=D` | GET | None |
| Offer detail (rich JSON) | `https://oferta.catho.com.br/offer/<offerId>/d/j?ipo=42&iapo=1` | GET | None |

- **Listing pagination:** `page` query parameter, 20 offers per page. The next page is also discoverable from `nav.pagination a.next-page[href]`.
- **Date filter:** parameter is lowercase **`lastdays`** (values `0,1,2,7,15,30`). The previous actor used camelCase `lastDays`, which the server silently ignored.
- **Offer ids:** listing cards expose `<li data-offer-item="<id>">`. The detail URL template is published in the page as `window.offersgriddata.urloffdet`.
- **Detail endpoint** returns `text/plain` JSON (`{ o, c, e, s, sk, kq }`). `o` is the offer, `c` the company.

### Detail JSON field map (`o` / `c`)

| Output field | Source |
|---|---|
| `id` | `o.eoi` |
| `title` | `o.t` / `o.ltr` |
| `company` | `c.cn` / `o.cn` |
| `location` | `o.cins[0]` (city) + `o.lab[0]` (UF) / `o.lns[0]` |
| `salary` | `o.smin`/`o.smax` (numeric) or `o.sn` (e.g. "A Combinar") |
| `employment_type` | `o.lsj` / `o.ctns[0]` (e.g. "CLT (Efetivo)") |
| `description` | `o.ld` |
| `date_posted` | `o.dlu` / `o.pt` / `o.dluf` |
| `url` / `apply_url` | `https://www.catho.com.br/vagas` + `o.ur` |
| (extra) `vacancies` | `o.v` |
| (extra) benefits | `o.bns[]` |

## Request requirements (evidence-based)

- **impit browser profile:** `chrome` (also `chrome142`, `chrome151`, `firefox`, `firefox144`, `ios18` work). `okhttp5` returns `403` - do not use an app profile.
- **Proxy:** Apify `RESIDENTIAL` with `apifyProxyCountry: "BR"`. Direct requests and non-Brazil exits return `403`.
- **Headers:** only `accept-language: pt-BR,pt;q=0.9`. impit provides the coherent browser TLS/header profile; no manual `user-agent`/`sec-ch-ua` overrides.
- **HTTP client count:** one shared `Impit` instance, rotated only when a request is blocked.

## Evidence matrix

| Candidate | Profile / context | Status | Offers/fields | Decision |
|---|---|---|---|---|
| Listing HTML `/vagas/desenvolvedor/` | impit `chrome` + BR residential | 200 (298 KB) | 20 `li[data-offer-item]`, total 8.697 | selected |
| Listing HTML, no proxy | impit `chrome`, local/host IP | 403 (520 B) | 0 | rejected (WAF) |
| Listing HTML | impit `okhttp5` + BR residential | 403 | 0 | rejected |
| Listing HTML, no `/vagas/` | home page | 200 | no jobs | not a source |
| `?lastDays=7` | impit `chrome` + BR | 200 | total unchanged 8.697 | rejected (ignored) |
| `?lastdays=7` | filter builder + BR | 200 | URL `/vagas/desenvolvedor/?lastdays=7` | selected |
| `?work_model[0]=remote` | impit `chrome` + BR | 200 | total 66 | works (filters are bracketed) |
| Detail HTML `/vagas/<slug>/<id>` | impit `chrome` + BR | 200 | JSON-LD `JobPosting` | fallback |
| Detail JSON `oferta.catho.com.br/offer/<id>/d/j` | impit `chrome` + BR | 200 `text/plain` JSON | all required fields | selected |
| `POST /searchbox/seturlsearchboxoffergrid` | impit `chrome` + BR | 200 `{success,url}` | - | used to confirm date param |

## Rejected candidates

- `script#__NEXT_DATA__`, `window.__INITIAL_STATE__`, `window.__APOLLO_STATE__`, `script[type="application/ld+json"]` on listing pages: absent (`jsonLd = 0`, `__NEXT_DATA__ = false`).
- `lastDays`, `publication_date`, `publicationDate`, `published`, `pubdate`, `date`, `days`, `period`, `range` query params: all ignored.
- `api-collector.catho.com.br` (analytics beacon) and `/OffersGrid/GetContentFilterSector`: not job data.

## Result

The actor is fully HTTP-based (impit). Playwright was removed entirely (browser not compulsory); the Docker base image is `apify/actor-node:22`. Playwright vs Patchright is moot because no browser is needed.
