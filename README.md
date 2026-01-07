# Catho Jobs Scraper

Extract comprehensive job listings from **Catho.com.br** — Brazil's premier job platform. Collect detailed job data including salaries, descriptions, locations, and company information for market research, recruitment, and career analytics.

---

## Features

- **Fast Extraction** — Collects jobs quickly from listing pages
- **Comprehensive Data** — Job title, company, location, salary, description, and more
- **Brazilian Job Market** — Access Brazil's largest job platform with millions of listings
- **Flexible Search** — Filter by keywords, location, or use direct search URLs
- **Scalable** — Extract from 10 to thousands of jobs per run
- **Production Ready** — Optimized for reliability with built-in retry logic

---

## Use Cases

- **Recruitment Agencies** — Monitor job postings and company hiring trends
- **Market Research** — Analyze salary ranges and job requirements by region
- **Career Platforms** — Aggregate Brazilian job data for your users
- **HR Analytics** — Track employment trends and skill demands
- **Competitive Intelligence** — Monitor competitor hiring activities

---

## Input Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `keyword` | String | Job title or skills to search | *(empty)* |
| `location` | String | City or state filter | *(empty)* |
| `startUrl` | String | Direct Catho search URL (overrides keyword/location) | - |
| `results_wanted` | Integer | Maximum jobs to collect | `50` |
| `max_pages` | Integer | Maximum listing pages to process | `5` |
| `proxyConfiguration` | Object | Proxy settings for reliability | Apify Residential |

---

## Usage Examples

### Basic Search — Developer Jobs in São Paulo

```json
{
  "keyword": "desenvolvedor",
  "location": "São Paulo",
  "results_wanted": 100
}
```

### Engineering Positions in Rio

```json
{
  "keyword": "engenheiro",
  "location": "Rio de Janeiro",
  "results_wanted": 50,
  "max_pages": 3
}
```

### Direct URL Scraping

```json
{
  "startUrl": "https://www.catho.com.br/vagas/?q=analista&cidade=Curitiba",
  "results_wanted": 30
}
```

### Nationwide Search — All Locations

```json
{
  "keyword": "gerente de projetos",
  "results_wanted": 200,
  "max_pages": 10
}
```

---

## Output Data

Each extracted job contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Unique job identifier |
| `title` | String | Job position title |
| `company` | String | Hiring company name |
| `location` | String | City and state |
| `salary` | String | Salary range (when available) |
| `employment_type` | String | Contract type (CLT, PJ, etc.) |
| `description` | String | Job description (plain text) |
| `date_posted` | String | Publication date |
| `url` | String | Job detail page URL |
| `apply_url` | String | Application URL |
| `fetched_at` | String | Extraction timestamp |

### Sample Output

```json
{
  "id": "34842019",
  "title": "Desenvolvedor Full Stack",
  "company": "Tech Solutions Brasil",
  "location": "São Paulo, SP",
  "salary": "R$ 8.000 - R$ 12.000",
  "employment_type": "CLT",
  "description": "Buscamos profissional com experiência em React e Node.js para atuar em projetos inovadores...",
  "date_posted": "2026-01-06",
  "url": "https://www.catho.com.br/vagas/desenvolvedor-full-stack/34842019/",
  "fetched_at": "2026-01-07T08:30:00.000Z"
}
```

---

## Performance

| Scenario | Results | Pages | Est. Time |
|----------|---------|-------|-----------|
| Quick Test | 20 | 2 | ~20 seconds |
| Basic Research | 50 | 3 | ~30 seconds |
| Standard Collection | 100 | 5 | ~1 minute |
| Large Dataset | 500 | 25 | ~5 minutes |

### Tips for Best Results

1. **Start Small** — Test with `results_wanted: 20` before scaling up
2. **Use Proxies** — Enable Apify Proxy for reliable collection
3. **Monitor Runs** — Check logs for any warning messages

---

## Integrations

Export your data in multiple formats:

- **JSON** — For programmatic access and API integrations
- **CSV / Excel** — For spreadsheet analysis
- **Webhook** — Trigger workflows when extraction completes
- **Google Sheets** — Direct export to spreadsheets
- **Database** — PostgreSQL, MongoDB, and more via integrations

---

## Frequently Asked Questions

### How often is the data updated?

Job listings are fetched in real-time from Catho.com.br. Data reflects what is currently published on the platform.

### What locations are supported?

All Brazilian states and cities are supported. Use city names like "São Paulo", "Rio de Janeiro", or state abbreviations.

### Why are some salaries not shown?

Some employers choose not to disclose salary information. The `salary` field will show "A combinar" (To be negotiated) or be empty for these listings.

### Can I scrape specific job categories?

Yes, use specific keywords in your search. For example: "desenvolvedor python", "analista financeiro", "gerente comercial".

---

## Legal and Compliance

This actor extracts publicly available job listings from Catho.com.br. Users are responsible for ensuring their use complies with applicable laws and terms of service.

---

## Support

For issues or feature requests, please contact the developer through Apify's support channels.