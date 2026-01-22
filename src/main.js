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
        .replace(/[^a-z0-9\s,]/g, '') // Keep letters, numbers, spaces, commas
        .trim();
};

// Check if job location matches the requested location
const matchesRequestedLocation = (jobLocation, requestedLocation) => {
    if (!requestedLocation) return true; // No filter requested
    if (!jobLocation) return false; // No location to match

    const jobNorm = normalizeForComparison(jobLocation);
    const reqNorm = normalizeForComparison(requestedLocation);

    // Extract city name from request (handle formats like "sao-paulo-sp", "São Paulo, SP", "sp/sao-paulo")
    const reqCity = reqNorm
        .replace(/,?\s*(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)$/i, '') // Remove state suffix
        .replace(/^(sp|rj|mg|ba|pr|rs|sc|go|df|ce|pe|pa|ma|mt|ms|es|pb|rn|al|se|pi|am|ro|ac|ap|rr|to)\s*/i, '') // Remove state prefix
        .replace(/-/g, ' ') // Convert hyphens to spaces
        .trim();

    // Extract city from job location (usually "City, STATE" format)
    const jobCity = jobNorm.split(',')[0].trim();

    // Check if cities match
    if (jobCity === reqCity) return true;
    if (jobCity.includes(reqCity) || reqCity.includes(jobCity)) return true;

    // Handle slug comparison (e.g., "sao jose dos campos" vs "sao-jose-dos-campos")
    const jobSlug = jobCity.replace(/\s+/g, '-');
    const reqSlug = reqCity.replace(/\s+/g, '-');
    if (jobSlug === reqSlug) return true;

    return false;
};

// Build search URL using Catho's path-based structure
const buildSearchUrl = ({ keyword, location, page = 1, baseDirectUrl = null }) => {
    // If we have a direct URL (user-provided), use it with pagination only
    if (baseDirectUrl) {
        const cleanUrl = baseDirectUrl.replace(/\?.*$/, '').replace(/\/$/, '') + '/';
        return page > 1 ? `${cleanUrl}?page=${page}` : cleanUrl;
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

    // Add page parameter as query string
    if (page > 1) {
        path += `?page=${page}`;
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

// Extract __NEXT_DATA__ from page
const extractNextData = async (page) => {
    try {
        const nextDataStr = await page.evaluate(() => {
            const script = document.querySelector('script#__NEXT_DATA__');
            return script ? script.textContent : null;
        });
        if (nextDataStr) {
            return JSON.parse(nextDataStr);
        }
    } catch (error) {
        log.warning(`Failed to extract __NEXT_DATA__: ${error.message}`);
    }
    return null;
};

// Extract all job data from listing __NEXT_DATA__
const parseJobFromListing = (job) => {
    const data = job.job_customized_data || job;
    const id = data.id || job.id;
    const title = data.titulo || job.titulo || null;

    if (!id || !title) return null;

    // Build clean URL
    const slug = title.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const url = `https://www.catho.com.br/vagas/${slug}/${id}/`;

    // Extract company (anunciante = advertiser, contratante = employer)
    let company = null;
    if (data.contratante?.nome && data.contratante.nome !== 'Confidencial') {
        company = data.contratante.nome;
    } else if (data.anunciante?.nome && data.anunciante.nome !== 'Confidencial') {
        company = data.anunciante.nome;
    } else if (data.contratante?.nome) {
        company = data.contratante.nome; // Use even if confidential
    } else if (data.anunciante?.nome) {
        company = data.anunciante.nome;
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
    }

    // Extract salary
    const salary = data.faixaSalarial || data.salario || null;

    // Extract employment type
    const employmentType = data.regimeContrato || data.tipoContrato || null;

    // Extract description (plain text)
    const description = data.descricao || null;

    // Extract date
    const datePosted = data.dataAtualizacao || data.dataPublicacao || null;

    return {
        id: String(id),
        title,
        company,
        location,
        salary,
        employment_type: employmentType,
        description,
        date_posted: datePosted,
        url,
        apply_url: url,
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
        results_wanted: resultsWantedRaw = 50,
        proxyConfiguration,
    } = input;

    const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 50;
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
            const stateAbbrevs = ['sp', 'rj', 'mg', 'ba', 'pr', 'rs', 'sc', 'go', 'df', 'ce', 'pe', 'pa', 'ma', 'mt', 'ms', 'es', 'pb', 'rn', 'al', 'se', 'pi', 'am', 'ro', 'ac', 'ap', 'rr', 'to'];
            if (segments.length >= 2 && stateAbbrevs.includes(segments[0].toLowerCase())) {
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
    log.info(`   Results wanted: ${resultsWanted}`);

    // Create Playwright crawler
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: MAX_CONCURRENCY,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 45,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
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

            // Wait for page to fully load
            await page.waitForLoadState('domcontentloaded');
            await sleep(200 + Math.random() * 300); // Quick stealth delay

            log.info(`📄 Page ${pageNum}: ${request.url}`);

            // Extract __NEXT_DATA__
            const nextData = await extractNextData(page);
            if (!nextData) {
                log.warning(`No __NEXT_DATA__ found on page ${pageNum}`);
                stats.errors += 1;
                return;
            }

            // Get jobs array from __NEXT_DATA__
            const jobsData = nextData?.props?.pageProps?.jobSearch?.jobSearchResult?.data;
            const jobs = Array.isArray(jobsData) ? jobsData : (jobsData?.jobs || []);

            if (jobs.length === 0) {
                log.info(`No jobs found on page ${pageNum}. End of results.`);
                hasMorePages = false;
                return;
            }

            log.info(`Found ${jobs.length} jobs on page ${pageNum}`);

            // Parse and collect jobs with location filtering
            const jobsToSave = [];
            for (const job of jobs) {
                if (saved + jobsToSave.length >= resultsWanted) break;

                const parsed = parseJobFromListing(job);
                if (!parsed) continue;
                if (seenIds.has(parsed.id)) continue;

                // 🆕 Apply strict location filtering to exclude sponsored/nearby jobs
                if (locationFilter && !matchesRequestedLocation(parsed.location, locationFilter)) {
                    skippedLocationMismatch++;
                    continue; // Skip jobs that don't match the requested location
                }

                seenIds.add(parsed.id);
                jobsToSave.push(parsed);
            }

            // Batch save
            if (jobsToSave.length > 0) {
                await Dataset.pushData(jobsToSave);
                saved += jobsToSave.length;
                stats.jobsSaved = saved;
                log.info(`💾 Saved ${jobsToSave.length} jobs (total: ${saved}/${resultsWanted})`);
            }

            // Queue next page if needed
            if (saved < resultsWanted && pageNum < maxPages && jobs.length >= 10 && hasMorePages) {
                const nextPageUrl = buildSearchUrl({
                    keyword: keywordValue,
                    location: locationValue,
                    page: pageNum + 1,
                    baseDirectUrl: directBaseUrl, // Use direct URL if provided
                });
                await crawler.addRequests([{
                    url: nextPageUrl,
                    userData: { pageNum: pageNum + 1 },
                }]);
            }
        },
        async failedRequestHandler({ request }, error) {
            stats.errors += 1;
            log.warning(`Request failed: ${request.url} - ${error.message}`);
        },
    });

    // Start crawling from first page
    const firstPageUrl = buildSearchUrl({
        keyword: keywordValue,
        location: locationValue,
        page: startPage,
        baseDirectUrl: directBaseUrl, // Use direct URL if provided
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
        const errorMsg = 'No results scraped. Check input parameters and proxy configuration.';
        log.error(`❌ ${errorMsg}`);
        await Actor.fail(errorMsg);
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
