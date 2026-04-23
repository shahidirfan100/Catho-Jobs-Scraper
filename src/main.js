// Catho Jobs Scraper - Fast, Stealthy, Production-Ready
// Extracts all data from __NEXT_DATA__ on listing pages only
// Fixed: Path-based URLs + strict location filtering
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, sleep } from 'crawlee';

const BASE_URL = 'https://www.catho.com.br/vagas/';
const MAX_CONCURRENCY = 5;
const JOBS_PER_PAGE = 20; // Catho shows ~15-20 jobs per page

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

const STATE_ABBREVS = ['sp', 'rj', 'mg', 'ba', 'pr', 'rs', 'sc', 'go', 'df', 'ce', 'pe', 'pa', 'ma', 'mt', 'ms', 'es', 'pb', 'rn', 'al', 'se', 'pi', 'am', 'ro', 'ac', 'ap', 'rr', 'to'];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Convert text to URL-safe slug (e.g., "São Paulo" → "sao-paulo")
const normalizeToSlug = (text) => {
    if (!text) return '';
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except hyphens
        .trim()
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-'); // Collapse multiple hyphens
};

// Normalize text for comparison (remove accents, lowercase, trim)
const normalizeForComparison = (text) => {
    if (!text) return '';
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/-/g, ' ') // Convert hyphens to spaces (for URL slugs)
        .replace(/[^a-z0-9\s,]/g, '') // Keep letters, numbers, spaces, commas
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
};

// Check if job location matches the requested location
const matchesRequestedLocation = (jobLocation, requestedLocation) => {
    if (!requestedLocation) return true; // No filter requested
    if (!jobLocation) return true; // Keep item when source has no location details

    const jobNorm = normalizeForComparison(jobLocation);
    const reqNorm = normalizeForComparison(requestedLocation);

    // Extract city name from request (handle formats like "sao-paulo-sp", "São Paulo, SP", "sp/sao-paulo")
    const statePattern = /,?\s*(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)\s*$/i;
    const statePrefixPattern = /^(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)\s+/i;

    const reqCity = reqNorm
        .replace(statePattern, '') // Remove state suffix
        .replace(statePrefixPattern, '') // Remove state prefix  
        .trim();

    // Extract city from job location (usually "City, STATE" format)
    const jobCity = jobNorm.split(',')[0].trim();

    // Direct match
    if (jobCity === reqCity) return true;

    // Partial match (one contains the other)
    if (jobCity.includes(reqCity) || reqCity.includes(jobCity)) return true;

    // Word-by-word match (handles different word order)
    const reqWords = reqCity.split(' ').filter(w => w.length > 2);
    const jobWords = jobCity.split(' ').filter(w => w.length > 2);
    const matchedWords = reqWords.filter(w => jobWords.includes(w));
    if (matchedWords.length >= Math.min(reqWords.length, jobWords.length) && matchedWords.length > 0) {
        return true;
    }

    return false;
};

// Build search URL using Catho's path-based structure
const buildSearchUrl = ({ keyword, location, page = 1, baseDirectUrl = null, lastDays = null }) => {
    // If we have a direct URL (user-provided), use it with pagination only
    if (baseDirectUrl) {
        const cleanUrl = baseDirectUrl.replace(/\?.*$/, '').replace(/\/$/, '') + '/';
        const queryParams = [];
        if (page > 1) queryParams.push(`page=${page}`);
        if (lastDays !== null && lastDays !== 'anytime') queryParams.push(`lastDays=${lastDays}`);
        return queryParams.length > 0 ? `${cleanUrl}?${queryParams.join('&')}` : cleanUrl;
    }

    let path = BASE_URL;
    const keywordSlug = normalizeToSlug(keyword);
    const locationSlug = normalizeToSlug(location);

    // Catho URL patterns:
    // - /vagas/keyword/ (keyword only)
    // - /vagas/keyword/city-state/ (keyword + location)
    // - /vagas/state/city/ (location only, but city-state also works)
    if (keywordSlug && locationSlug) {
        // Combined: /vagas/keyword/location/
        path += `${keywordSlug}/${locationSlug}/`;
    } else if (keywordSlug) {
        // Keyword only: /vagas/keyword/
        path += `${keywordSlug}/`;
    } else if (locationSlug) {
        // Location only: /vagas/location/
        path += `${locationSlug}/`;
    }

    // Add query parameters
    const queryParams = [];
    if (page > 1) queryParams.push(`page=${page}`);
    if (lastDays !== null && lastDays !== 'anytime') queryParams.push(`lastDays=${lastDays}`);
    
    if (queryParams.length > 0) {
        path += `?${queryParams.join('&')}`;
    }

    return path;
};

// Parse URL to extract search parameters from path-based URLs
const parseSearchUrl = (urlString) => {
    try {
        const url = new URL(urlString);
        const pathname = url.pathname.replace(/^\/vagas\/?/, '').replace(/\/$/, '');
        const segments = pathname.split('/').filter(Boolean);

        // Query param for keyword (fallback)
        const keywordFromQuery = url.searchParams.get('q') || '';
        const page = parseInt(url.searchParams.get('page') || '1', 10);

        // For direct URLs, we keep the path segments as-is
        // The URL structure is the source of truth
        return {
            keyword: keywordFromQuery,
            location: '', // Don't infer - use the full URL
            page,
            pathSegments: segments,
            isDirectUrl: segments.length > 0,
        };
    } catch {
        return { keyword: '', location: '', page: 1, pathSegments: [], isDirectUrl: false };
    }
};

const safeJsonParse = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

const pickFirst = (...values) => values.find((value) => value !== null && value !== undefined && String(value).trim() !== '');

const looksLikeJobObject = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const hasId = ['id', 'jobId', 'job_id', 'codigo', 'codigoVaga'].some((key) => keys.includes(key));
    const hasTitle = ['titulo', 'title', 'cargo', 'nome'].some((key) => keys.includes(key));
    const hasJobContext = ['descricao', 'description', 'vagas', 'localizacao', 'cidade', 'contratante', 'anunciante', 'empresa'].some((key) => keys.includes(key));
    return hasId && (hasTitle || hasJobContext);
};

const scoreJobArray = (items) => {
    if (!Array.isArray(items) || items.length === 0) return 0;
    const sample = items.slice(0, 5);
    let score = 0;
    for (const item of sample) {
        if (looksLikeJobObject(item)) score += 3;
        if (item?.vagas) score += 2;
        if (item?.titulo || item?.title) score += 2;
        if (item?.descricao || item?.description) score += 1;
    }
    return score;
};

const findBestJobArray = (payload, maxDepth = 8) => {
    if (!payload || typeof payload !== 'object') return [];

    const visited = new WeakSet();
    const queue = [{ value: payload, depth: 0 }];
    let bestArray = [];
    let bestScore = 0;
    let scannedNodes = 0;

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) continue;

        const { value, depth } = current;
        if (!value || typeof value !== 'object') continue;

        scannedNodes += 1;
        if (scannedNodes > 5000) break;

        if (Array.isArray(value)) {
            const score = scoreJobArray(value);
            if (score > bestScore) {
                bestScore = score;
                bestArray = value;
            }

            if (depth < maxDepth) {
                for (const item of value.slice(0, 30)) {
                    if (item && typeof item === 'object') {
                        queue.push({ value: item, depth: depth + 1 });
                    }
                }
            }
            continue;
        }

        if (visited.has(value)) continue;
        visited.add(value);

        if (depth < maxDepth) {
            for (const child of Object.values(value)) {
                if (child && typeof child === 'object') {
                    queue.push({ value: child, depth: depth + 1 });
                }
            }
        }
    }

    return bestScore >= 3 ? bestArray : [];
};

const extractJobsFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return [];

    const candidates = [
        payload?.props?.pageProps?.jobSearch?.jobSearchResult?.data,
        payload?.props?.pageProps?.jobs,
        payload?.props?.pageProps?.data,
        payload?.pageProps?.jobs,
        payload?.data?.jobs,
        payload?.data?.results,
        payload?.data,
        payload?.jobs,
        payload?.results,
    ];

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) return candidate;
        if (candidate && typeof candidate === 'object') {
            if (Array.isArray(candidate.jobs) && candidate.jobs.length > 0) return candidate.jobs;
            if (Array.isArray(candidate.data) && candidate.data.length > 0) return candidate.data;
            if (Array.isArray(candidate.results) && candidate.results.length > 0) return candidate.results;
        }
    }

    return findBestJobArray(payload);
};

const extractHydrationPayload = async (page) => {
    try {
        return await page.evaluate(() => {
            const candidates = ['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__NUXT__'];
            for (const key of candidates) {
                const state = window[key];
                if (!state) continue;
                try {
                    return JSON.parse(JSON.stringify(state));
                } catch {
                    continue;
                }
            }
            return null;
        });
    } catch (error) {
        log.warning(`Failed to extract hydration state: ${error.message}`);
        return null;
    }
};

const extractJobsFromJsonLd = async (page) => {
    try {
        return await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            const jobs = [];

            const toText = (value) => {
                if (typeof value !== 'string') return null;
                return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null;
            };

            const pushNode = (node) => {
                if (!node || typeof node !== 'object') return;
                if (node['@type'] !== 'JobPosting') return;

                const city = node?.jobLocation?.address?.addressLocality || null;
                const state = node?.jobLocation?.address?.addressRegion || null;
                const location = [city, state].filter(Boolean).join(', ') || city || state || null;

                jobs.push({
                    id: typeof node.identifier === 'string' ? node.identifier : node?.identifier?.value || null,
                    title: node.title || node.name || null,
                    company: node?.hiringOrganization?.name || null,
                    location,
                    salary: node?.baseSalary?.value?.value || node?.baseSalary?.value?.minValue || null,
                    employment_type: Array.isArray(node.employmentType) ? node.employmentType.join(', ') : node.employmentType || null,
                    description: toText(node.description),
                    date_posted: node.datePosted || null,
                    url: node.url || null,
                    apply_url: node.url || null,
                    source: 'json-ld',
                });
            };

            for (const script of scripts) {
                try {
                    const parsed = JSON.parse(script.textContent || 'null');
                    const queue = [parsed];
                    while (queue.length > 0) {
                        const current = queue.shift();
                        if (!current) continue;
                        if (Array.isArray(current)) {
                            queue.push(...current);
                            continue;
                        }
                        if (typeof current === 'object') {
                            pushNode(current);
                            for (const child of Object.values(current)) {
                                if (child && typeof child === 'object') queue.push(child);
                            }
                        }
                    }
                } catch {
                    continue;
                }
            }

            return jobs;
        });
    } catch (error) {
        log.warning(`Failed to extract JSON-LD jobs: ${error.message}`);
        return [];
    }
};

const extractJobsFromAnchors = async (page) => {
    try {
        return await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/vagas/"]'));
            const seen = new Set();
            const jobs = [];

            for (const anchor of anchors) {
                const href = anchor.href || '';
                if (!href.includes('/vagas/')) continue;

                const idMatch = href.match(/\/vagas\/[^/]+\/(\d+)\/?/i);
                const title = (anchor.getAttribute('title') || anchor.textContent || '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 3) continue;
                if (!idMatch) continue;
                if (/\/vagas\/?$/i.test(href)) continue;

                const id = idMatch ? idMatch[1] : null;
                const key = id || href;
                if (seen.has(key)) continue;
                seen.add(key);

                jobs.push({
                    id,
                    title,
                    url: href,
                    apply_url: href,
                    source: 'dom-anchor',
                });

                if (jobs.length >= 200) break;
            }

            return jobs;
        });
    } catch (error) {
        log.warning(`Failed to extract jobs from anchors: ${error.message}`);
        return [];
    }
};

const extractJobsFromHtmlPatterns = async (page) => {
    try {
        const html = await page.content();
        const matches = [...html.matchAll(/"id"\s*:\s*"?(\d{5,})"?[^\n\r]{0,400}?"titulo"\s*:\s*"([^"\\]{3,200})"/gi)];
        const jobs = [];
        const seen = new Set();

        for (const match of matches.slice(0, 150)) {
            const id = match[1] || null;
            const title = (match[2] || '').replace(/\\u003c[^>]*>/gi, '').replace(/\\n|\\r|\\t/g, ' ').trim();
            if (!title || title.length < 3) continue;

            if (id && seen.has(id)) continue;
            if (id) seen.add(id);

            jobs.push({
                id,
                title,
                url: id ? `https://www.catho.com.br/vagas/${normalizeToSlug(title)}/${id}/` : null,
                apply_url: id ? `https://www.catho.com.br/vagas/${normalizeToSlug(title)}/${id}/` : null,
                source: 'html-regex',
            });
        }

        return jobs;
    } catch (error) {
        log.warning(`Failed to extract jobs from raw HTML: ${error.message}`);
        return [];
    }
};

// Extract __NEXT_DATA__ from page
const extractNextData = async (page) => {
    try {
        const nextDataStr = await page.evaluate(() => {
            const exact = document.querySelector('script#__NEXT_DATA__');
            if (exact?.textContent) return exact.textContent;

            const scripts = Array.from(document.querySelectorAll('script:not([src])'));
            const candidate = scripts
                .map((script) => script.textContent || '')
                .find((text) => text.includes('"pageProps"') && text.includes('"props"') && text.length > 200);

            return candidate || null;
        });
        if (nextDataStr) return safeJsonParse(nextDataStr);
    } catch (error) {
        log.warning(`Failed to extract __NEXT_DATA__: ${error.message}`);
    }
    return null;
};

// Extract all job data from listing __NEXT_DATA__
const parseJobFromListing = (job) => {
    if (!job || typeof job !== 'object') return null;

    const data = job.job_customized_data || job;
    const title = pickFirst(
        data.titulo,
        data.title,
        data.cargo,
        data.nome,
        job.titulo,
        job.title,
        job.cargo,
        job.nome,
    );
    const titleText = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : null;
    if (!titleText || titleText.length < 2) return null;

    const parsedId = pickFirst(
        data.id,
        data.jobId,
        data.job_id,
        data.codigo,
        data.codigoVaga,
        job.id,
        job.jobId,
    );

    const urlFromSource = pickFirst(data.url, data.link, data.jobUrl, job.url, job.link, job.apply_url);
    let id = parsedId ? String(parsedId) : null;

    const externalUrl = typeof urlFromSource === 'string' ? urlFromSource : null;
    if (!id && externalUrl) {
        const urlIdMatch = externalUrl.match(/\/vagas\/[^/]+\/(\d+)\/?/i);
        id = urlIdMatch ? urlIdMatch[1] : null;
    }

    if (!id && !externalUrl) return null;

    // Build clean URL
    const slug = titleText.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const normalizedExternalUrl = externalUrl?.startsWith('http')
        ? externalUrl
        : (externalUrl?.startsWith('/') ? `https://www.catho.com.br${externalUrl}` : null);
    const url = normalizedExternalUrl || `https://www.catho.com.br/vagas/${slug}/${id}/`;

    // Extract company (anunciante = advertiser, contratante = employer)
    let company = null;
    if (data.contratante?.nome && data.contratante.nome !== 'Confidencial') {
        company = data.contratante.nome;
    } else if (data.anunciante?.nome && data.anunciante.nome !== 'Confidencial') {
        company = data.anunciante.nome;
    } else if (typeof data.company === 'string' && data.company !== 'Confidencial') {
        company = data.company;
    } else if (typeof data.empresa === 'string' && data.empresa !== 'Confidencial') {
        company = data.empresa;
    } else if (data.empresa?.nome && data.empresa.nome !== 'Confidencial') {
        company = data.empresa.nome;
    } else if (data.contratante?.nome) {
        company = data.contratante.nome; // Use even if confidential
    } else if (data.anunciante?.nome) {
        company = data.anunciante.nome;
    } else if (typeof data.company === 'string') {
        company = data.company;
    } else if (typeof data.empresa === 'string') {
        company = data.empresa;
    } else if (data.empresa?.nome) {
        company = data.empresa.nome;
    }

    // Extract location (from vagas array first, then fallbacks)
    let location = null;
    if (data.vagas?.[0]) {
        const loc = data.vagas[0];
        location = [loc.cidade, loc.uf].filter(Boolean).join(', ');
    } else if (data.cidade && data.uf) {
        location = `${data.cidade}, ${data.uf}`;
    } else if (data.localizacao) {
        location = data.localizacao;
    } else if (data.location) {
        location = data.location;
    } else if (job.location) {
        location = job.location;
    }

    // Extract salary
    const salary = pickFirst(data.faixaSalarial, data.salario, data.salary, job.salary) || null;

    // Extract employment type
    const employmentType = pickFirst(data.regimeContrato, data.tipoContrato, data.contractType, data.employmentType, job.employment_type) || null;

    // Extract description (plain text)
    const description = pickFirst(data.descricao, data.description, data.resumo, job.description) || null;

    // Extract date
    const datePosted = pickFirst(data.dataAtualizacao, data.dataPublicacao, data.publicadoEm, data.createdAt, data.publishedAt, job.date_posted) || null;

    return {
        id: id ? String(id) : null,
        title: titleText,
        company,
        location,
        salary,
        employment_type: employmentType,
        description,
        date_posted: datePosted,
        url,
        apply_url: url,
        source: job.source || data.source || null,
        fetched_at: new Date().toISOString(),
    };
};

// Initialize Actor
await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        startUrl,
        keyword = '',
        location = '',
        lastDays: lastDaysInput = 'anytime',
        results_wanted: resultsWantedRaw = 20,
        proxyConfiguration,
    } = input;

    // Convert lastDays string to numeric value
    const lastDaysMap = {
        'today': 0,
        '2days': 1,
        '3days': 2,
        'week': 7,
        'month': 30,
        'anytime': null,
    };
    const lastDaysValue = lastDaysMap[lastDaysInput] !== undefined ? lastDaysMap[lastDaysInput] : null;

    const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 20;
    // Auto-calculate max pages based on results wanted (Catho shows ~15 jobs per page)
    const maxPages = Math.ceil(resultsWanted / 15) + 2; // Add buffer for duplicates
    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

    // Determine search parameters from startUrl or inputs
    let keywordValue = keyword.trim();
    let locationValue = location.trim();
    let startPage = 1;
    let directBaseUrl = null; // Store user-provided URL for pagination
    let locationFilter = locationValue; // Location to filter results by

    if (startUrl && startUrl.includes('catho.com.br/vagas')) {
        // User provided a direct URL - use it as-is
        directBaseUrl = startUrl;
        const parsed = parseSearchUrl(startUrl);
        if (parsed.keyword) keywordValue = parsed.keyword;
        if (parsed.page > 1) startPage = parsed.page;

        // Extract location from URL path for filtering
        // e.g., /vagas/administrativo/sao-jose-dos-campos-sp/ -> "sao-jose-dos-campos-sp"
        // e.g., /vagas/sp/sao-jose-dos-campos/ -> "sao-jose-dos-campos"
        if (parsed.pathSegments.length > 0) {
            // Last segment is usually the location, or second-to-last if there's a state prefix
            const segments = parsed.pathSegments;
            // Check if first segment looks like a state abbreviation
            if (segments.length >= 2 && STATE_ABBREVS.includes(segments[0].toLowerCase())) {
                // Format: /vagas/sp/sao-jose-dos-campos/
                locationFilter = segments[1];
            } else if (segments.length >= 2) {
                // Format: /vagas/keyword/city-state/ - last segment is location
                locationFilter = segments[segments.length - 1];
            } else if (segments.length === 1) {
                // Could be keyword or location - check if it contains state suffix
                const seg = segments[0];
                if (seg.match(/-(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)$/i)) {
                    locationFilter = seg;
                }
            }
            log.info(`📍 Detected location filter from URL: ${locationFilter}`);
        }
    } else if (locationValue) {
        // User provided location via input field
        locationFilter = locationValue;
    }

    const seenIds = new Set();
    let saved = 0;
    let skippedLocationMismatch = 0;
    const startTime = Date.now();
    const MAX_RUNTIME_MS = 3.5 * 60 * 1000; // 210 seconds safety limit
    const stats = { pagesProcessed: 0, jobsSaved: 0, errors: 0 };
    let hasMorePages = true;

    log.info('🚀 Starting Catho Jobs Scraper');
    log.info(`   Keyword: ${keywordValue || '(all jobs)'}`);
    log.info(`   Location: ${locationValue || '(all Brazil)'}`);
    log.info(`   Location Filter: ${locationFilter || '(none)'}`);
    log.info(`   Direct URL: ${directBaseUrl || '(none)'}`);
    log.info(`   Date Filter: ${lastDaysInput} (lastDays=${lastDaysValue !== null ? lastDaysValue : 'not applied'})`);
    log.info(`   Results wanted: ${resultsWanted}`);

    // Create Playwright crawler - optimized for speed
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 30,
        navigationTimeoutSecs: 20,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 5,
        },
        browserPoolOptions: {
            useFingerprints: true,
            preLaunchHooks: [
                async (pageId, launchContext) => {
                    launchContext.launchOptions = {
                        ...launchContext.launchOptions,
                        headless: true,
                        args: [
                            '--disable-blink-features=AutomationControlled',
                            '--disable-dev-shm-usage',
                            '--no-sandbox',
                        ],
                    };
                    launchContext.userAgent = getRandomUserAgent();
                },
            ],
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                });
            },
        ],
        async requestHandler({ request, page }) {
            const capturedPayloads = [];
            const onResponse = async (response) => {
                try {
                    const responseUrl = response.url();
                    if (!/\/api\/|\/_next\/data\/|graphql|job|vaga/i.test(responseUrl)) return;

                    const contentType = response.headers()['content-type'] || '';
                    if (!contentType.includes('application/json') && !responseUrl.includes('/_next/data/')) return;

                    const body = await response.json();
                    if (body && typeof body === 'object') capturedPayloads.push(body);
                } catch {
                    // Ignore noisy/non-JSON response errors from blocked or aborted requests
                }
            };

            page.on('response', onResponse);

            try {
                // Check timeout
                if (Date.now() - startTime > MAX_RUNTIME_MS) {
                    log.info('⏱️ Timeout safety triggered. Stopping.');
                    return;
                }

                // Check if we have enough results
                if (saved >= resultsWanted) {
                    log.info(`✅ Reached target: ${saved}/${resultsWanted} jobs`);
                    return;
                }

                const pageNum = request.userData?.pageNum || 1;
                stats.pagesProcessed += 1;

                await page.waitForLoadState('domcontentloaded');
                await sleep(700);

                log.info(`📄 Page ${pageNum}: ${request.url}`);

                let jobs = [];
                let extractionSource = null;

                const nextData = await extractNextData(page);
                if (nextData) {
                    const nextJobs = extractJobsFromPayload(nextData);
                    if (nextJobs.length > 0) {
                        jobs = nextJobs;
                        extractionSource = '__NEXT_DATA__';
                    }
                }

                if (jobs.length === 0) {
                    const hydrationPayload = await extractHydrationPayload(page);
                    if (hydrationPayload) {
                        const hydrationJobs = extractJobsFromPayload(hydrationPayload);
                        if (hydrationJobs.length > 0) {
                            jobs = hydrationJobs;
                            extractionSource = 'hydration-state';
                        }
                    }
                }

                if (jobs.length === 0 && capturedPayloads.length > 0) {
                    for (const payload of capturedPayloads.slice(0, 15)) {
                        const apiJobs = extractJobsFromPayload(payload);
                        if (apiJobs.length > 0) {
                            jobs = apiJobs;
                            extractionSource = 'network-json';
                            break;
                        }
                    }
                }

                if (jobs.length === 0) {
                    const jsonLdJobs = await extractJobsFromJsonLd(page);
                    if (jsonLdJobs.length > 0) {
                        jobs = jsonLdJobs;
                        extractionSource = 'json-ld';
                    }
                }

                if (jobs.length === 0) {
                    const anchorJobs = await extractJobsFromAnchors(page);
                    if (anchorJobs.length > 0) {
                        jobs = anchorJobs;
                        extractionSource = 'dom-anchor';
                    }
                }

                if (jobs.length === 0) {
                    const htmlJobs = await extractJobsFromHtmlPatterns(page);
                    if (htmlJobs.length > 0) {
                        jobs = htmlJobs;
                        extractionSource = 'html-regex';
                    }
                }

                if (jobs.length === 0) {
                    log.warning(`No jobs found on page ${pageNum} from any source.`);
                    stats.errors += 1;
                    if (pageNum < maxPages && hasMorePages) {
                        const nextPageUrl = buildSearchUrl({
                            keyword: keywordValue,
                            location: locationValue,
                            page: pageNum + 1,
                            baseDirectUrl: directBaseUrl,
                            lastDays: lastDaysValue,
                        });
                        await crawler.addRequests([{
                            url: nextPageUrl,
                            userData: { pageNum: pageNum + 1 },
                        }]);
                    }
                    return;
                }

                log.info(`Found ${jobs.length} jobs on page ${pageNum} via ${extractionSource || 'unknown-source'}`);

                const jobsToSave = [];
                for (const job of jobs) {
                    if (saved + jobsToSave.length >= resultsWanted) break;

                    const parsed = parseJobFromListing(job);
                    if (!parsed) continue;
                    const dedupeKey = parsed.id || parsed.url;
                    if (!dedupeKey || seenIds.has(dedupeKey)) continue;

                    if (locationFilter && !matchesRequestedLocation(parsed.location, locationFilter)) {
                        skippedLocationMismatch++;
                        continue;
                    }

                    seenIds.add(dedupeKey);
                    jobsToSave.push(parsed);
                }

                if (jobsToSave.length > 0) {
                    await Dataset.pushData(jobsToSave);
                    saved += jobsToSave.length;
                    stats.jobsSaved = saved;
                    log.info(`💾 Saved ${jobsToSave.length} jobs (total: ${saved}/${resultsWanted})`);
                }

                if (saved < resultsWanted && pageNum < maxPages && jobs.length > 0 && hasMorePages) {
                    const nextPageUrl = buildSearchUrl({
                        keyword: keywordValue,
                        location: locationValue,
                        page: pageNum + 1,
                        baseDirectUrl: directBaseUrl,
                        lastDays: lastDaysValue,
                    });
                    await crawler.addRequests([{
                        url: nextPageUrl,
                        userData: { pageNum: pageNum + 1 },
                    }]);
                }
            } finally {
                page.off('response', onResponse);
            }
        },
        async failedRequestHandler({ request, error }) {
            stats.errors += 1;
            log.warning(`Request failed: ${request.url} - ${error?.message || 'Unknown error'}`);
        },
    });

    // Start crawling from first page
    const firstPageUrl = buildSearchUrl({
        keyword: keywordValue,
        location: locationValue,
        page: startPage,
        baseDirectUrl: directBaseUrl, // Use direct URL if provided
        lastDays: lastDaysValue,
    });

    log.info(`🔗 Starting URL: ${firstPageUrl}`);

    await crawler.addRequests([{
        url: firstPageUrl,
        userData: { pageNum: startPage },
    }]);

    await crawler.run();

    const totalTime = (Date.now() - startTime) / 1000;

    // Final statistics
    log.info('='.repeat(60));
    log.info('📊 ACTOR RUN STATISTICS');
    log.info('='.repeat(60));
    log.info(`✅ Jobs saved: ${saved}/${resultsWanted}`);
    log.info(`📄 Pages processed: ${stats.pagesProcessed}`);
    log.info(`🚫 Skipped (location mismatch): ${skippedLocationMismatch}`);
    log.info(`⚠️  Errors: ${stats.errors}`);
    log.info(`⏱️  Runtime: ${totalTime.toFixed(2)}s`);
    log.info(`⚡ Speed: ${(saved / totalTime).toFixed(2)} jobs/second`);
    log.info('='.repeat(60));

    if (saved === 0) {
        const warningMsg = 'No jobs extracted after all fallback strategies. Saved diagnostic record for monitoring.';
        log.warning(`⚠️ ${warningMsg}`);
        await Dataset.pushData([{
            is_fallback_notice: true,
            message: warningMsg,
            start_url: firstPageUrl,
            keyword: keywordValue || null,
            location: locationValue || null,
            date_filter: lastDaysInput,
            runtime_seconds: Number(totalTime.toFixed(2)),
            fetched_at: new Date().toISOString(),
        }]);
        await Actor.setStatusMessage(warningMsg, { isStatusMessageTerminal: true });
        await Actor.setValue('OUTPUT_SUMMARY', {
            jobsSaved: 0,
            pagesProcessed: stats.pagesProcessed,
            runtime: totalTime,
            success: false,
            autoHealingFallback: true,
        });
    } else {
        log.info(`✅ SUCCESS: ${saved} job(s) saved to dataset.`);
        await Actor.setValue('OUTPUT_SUMMARY', {
            jobsSaved: saved,
            pagesProcessed: stats.pagesProcessed,
            runtime: totalTime,
            success: true,
        });
    }

} catch (error) {
    log.error(`❌ CRITICAL ERROR: ${error.message}`);
    log.exception(error, 'Actor failed with exception');
    await Actor.fail(`Actor failed: ${error.message}`);
} finally {
    await Actor.exit();
}
