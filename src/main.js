// Catho Jobs Scraper - Playwright + __NEXT_DATA__ extraction
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, sleep } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

const BASE_URL = 'https://www.catho.com.br/vagas/';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];

const getRandomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const cleanHtml = (html) => {
    if (!html) return null;
    const $ = cheerioLoad(html);
    $('script, style, noscript').remove();
    return $.root().text().replace(/\s+/g, ' ').trim();
};

const buildSearchUrl = ({ keyword, location, page = 1 }) => {
    const url = new URL(BASE_URL);
    if (keyword) url.searchParams.set('q', keyword);
    if (location) url.searchParams.set('cidade', location);
    if (page > 1) url.searchParams.set('page', page.toString());
    return url.href;
};

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

const extractJsonLd = async (page) => {
    try {
        const jsonLdData = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            const data = [];
            scripts.forEach(script => {
                try {
                    data.push(JSON.parse(script.textContent));
                } catch { /* ignore */ }
            });
            return data;
        });
        return jsonLdData.find(d => d['@type'] === 'JobPosting') || null;
    } catch (error) {
        log.warning(`Failed to extract JSON-LD: ${error.message}`);
    }
    return null;
};

const parseListingFromNextData = (job) => {
    const customData = job.job_customized_data || job;
    return {
        id: customData.id || job.id,
        title: customData.titulo || job.titulo,
        salary: customData.faixaSalarial || null,
        short_description: customData.descricao || null,
        date_posted: customData.dataAtualizacao || null,
        company_id: customData.empId || null,
        url: customData.id ? `https://www.catho.com.br/vagas/${encodeURIComponent((customData.titulo || 'job').toLowerCase().replace(/\s+/g, '-'))}/${customData.id}/` : null,
    };
};

const buildJob = ({ listing, detail, jsonLd }) => {
    const title = detail?.titulo || jsonLd?.title || listing?.title || null;
    const company = detail?.empresa?.nome || jsonLd?.hiringOrganization?.name || null;

    // Location handling
    let location = null;
    if (detail?.vagas?.[0]) {
        const loc = detail.vagas[0];
        location = [loc.cidade, loc.uf].filter(Boolean).join(', ');
    } else if (jsonLd?.jobLocation?.address) {
        const addr = jsonLd.jobLocation.address;
        location = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
    }

    // Salary handling
    let salary = listing?.salary || null;
    if (jsonLd?.baseSalary?.value) {
        const val = jsonLd.baseSalary.value;
        if (typeof val === 'object') {
            salary = `R$ ${val.minValue || ''} - R$ ${val.maxValue || ''}`.trim();
        } else {
            salary = `R$ ${val}`;
        }
    }

    // Benefits
    const benefits = detail?.benef?.join(', ') || null;

    // Description
    const descriptionHtml = detail?.descricao || jsonLd?.description || null;
    const descriptionText = cleanHtml(descriptionHtml) || listing?.short_description || null;

    // Employment type
    const employmentType = detail?.regimeContrato || jsonLd?.employmentType || null;

    // Date posted
    const datePosted = detail?.dataAtualizacao || jsonLd?.datePosted || listing?.date_posted || null;

    // Build URL
    let url = listing?.url || null;
    if (listing?.id && listing?.title) {
        const slug = (listing.title || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        url = `https://www.catho.com.br/vagas/${slug}/${listing.id}/`;
    }

    return {
        id: listing?.id || detail?.id || null,
        title,
        company,
        location,
        salary,
        employment_type: employmentType,
        benefits,
        description_text: descriptionText,
        description_html: descriptionHtml,
        date_posted: datePosted,
        url,
        apply_url: jsonLd?.applicationUrl || url,
        source: detail ? 'detail' : 'listing',
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
        collectDetails = false,
        results_wanted: resultsWantedRaw = 10,
        max_pages: maxPagesRaw = 2,
        maxConcurrency = 3,
        proxyConfiguration,
    } = input;

    const resultsWanted = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : 10;
    const maxPages = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 2;
    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

    // Parse startUrl for keyword/location if provided
    let keywordValue = keyword.trim();
    let locationValue = location.trim();
    if (startUrl) {
        try {
            const u = new URL(startUrl);
            const qFromUrl = u.searchParams.get('q');
            const cidadeFromUrl = u.searchParams.get('cidade');
            if (qFromUrl) keywordValue = qFromUrl;
            if (cidadeFromUrl) locationValue = cidadeFromUrl;
        } catch {
            // ignore malformed startUrl
        }
    }

    const seenIds = new Set();
    let saved = 0;
    const startTime = Date.now();
    const MAX_RUNTIME_MS = 3.5 * 60 * 1000; // 210 seconds
    const stats = { pagesProcessed: 0, jobsSaved: 0, detailsFetched: 0, errors: 0 };

    // Create Playwright crawler
    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConf,
        maxConcurrency: Math.max(1, Number(maxConcurrency) || 3),
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 60,
        navigationTimeoutSecs: 45,
        launchContext: {
            launchOptions: {
                headless: true,
                args: ['--disable-blink-features=AutomationControlled'],
            },
        },
        preNavigationHooks: [
            async ({ page }) => {
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                });
                await page.setUserAgent(getRandomUserAgent());
            },
        ],
        async requestHandler({ request, page }) {
            const { userData } = request;
            const isDetailPage = userData?.isDetail || false;

            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            await sleep(500 + Math.random() * 1000);

            if (!isDetailPage) {
                // LISTING PAGE
                stats.pagesProcessed += 1;
                log.info(`📄 Processing listing page: ${request.url}`);

                const nextData = await extractNextData(page);
                if (!nextData) {
                    log.warning('No __NEXT_DATA__ found on listing page');
                    stats.errors += 1;
                    return;
                }

                const jobs = nextData?.props?.pageProps?.jobSearch?.jobSearchResult?.data?.jobs || [];
                log.info(`Found ${jobs.length} jobs on page ${userData?.pageNum || 1}`);

                for (const job of jobs) {
                    if (saved >= resultsWanted) break;
                    if (Date.now() - startTime > MAX_RUNTIME_MS) {
                        log.info('⏱️ Timeout safety triggered. Stopping.');
                        break;
                    }

                    const listing = parseListingFromNextData(job);
                    if (!listing.id) continue;
                    if (seenIds.has(listing.id)) continue;
                    seenIds.add(listing.id);

                    if (collectDetails && listing.url) {
                        // Queue detail page
                        await crawler.addRequests([{
                            url: listing.url,
                            userData: { isDetail: true, listing },
                        }]);
                    } else {
                        // Save listing directly
                        const jobData = buildJob({ listing });
                        await Dataset.pushData(jobData);
                        saved += 1;
                        stats.jobsSaved = saved;

                        if (saved % 10 === 0) {
                            log.info(`💾 Progress: ${saved}/${resultsWanted} jobs saved`);
                        }
                    }
                }

                // Check if we need more pages
                const currentPage = userData?.pageNum || 1;
                if (saved < resultsWanted && currentPage < maxPages && jobs.length > 0) {
                    const nextPageUrl = buildSearchUrl({ keyword: keywordValue, location: locationValue, page: currentPage + 1 });
                    await crawler.addRequests([{
                        url: nextPageUrl,
                        userData: { isDetail: false, pageNum: currentPage + 1 },
                    }]);
                }

            } else {
                // DETAIL PAGE
                stats.detailsFetched += 1;
                const { listing } = userData;
                log.info(`🔍 Processing detail: ${listing.title || listing.id}`);

                const nextData = await extractNextData(page);
                const jsonLd = await extractJsonLd(page);
                const detail = nextData?.props?.pageProps?.jobAdData || null;

                const jobData = buildJob({ listing, detail, jsonLd });
                await Dataset.pushData(jobData);
                saved += 1;
                stats.jobsSaved = saved;

                if (saved % 10 === 0) {
                    log.info(`💾 Progress: ${saved}/${resultsWanted} jobs saved`);
                }
            }
        },
        async failedRequestHandler({ request }, error) {
            stats.errors += 1;
            log.error(`Request failed: ${request.url} - ${error.message}`);
        },
    });

    // Start with first page
    const firstPageUrl = startUrl || buildSearchUrl({ keyword: keywordValue, location: locationValue, page: 1 });
    await crawler.addRequests([{
        url: firstPageUrl,
        userData: { isDetail: false, pageNum: 1 },
    }]);

    log.info(`🚀 Starting Catho Jobs Scraper`);
    log.info(`   Keyword: ${keywordValue || '(all)'}`);
    log.info(`   Location: ${locationValue || '(all)'}`);
    log.info(`   Results wanted: ${resultsWanted}`);
    log.info(`   Max pages: ${maxPages}`);
    log.info(`   Collect details: ${collectDetails}`);

    await crawler.run();

    const totalTime = (Date.now() - startTime) / 1000;

    // Final statistics
    log.info('='.repeat(60));
    log.info('📊 ACTOR RUN STATISTICS');
    log.info('='.repeat(60));
    log.info(`✅ Jobs saved: ${saved}/${resultsWanted}`);
    log.info(`📄 Pages processed: ${stats.pagesProcessed}/${maxPages}`);
    log.info(`🔍 Details fetched: ${stats.detailsFetched}`);
    log.info(`⚠️  Errors encountered: ${stats.errors}`);
    log.info(`⏱️  Total runtime: ${totalTime.toFixed(2)}s`);
    log.info(`⚡ Performance: ${(saved / totalTime).toFixed(2)} jobs/second`);
    log.info('='.repeat(60));

    if (saved === 0) {
        const errorMsg = 'No results scraped. Check input parameters and proxy configuration.';
        log.error(`❌ ${errorMsg}`);
        await Actor.fail(errorMsg);
    } else {
        log.info(`✅ SUCCESS: Actor completed with ${saved} job(s) in dataset.`);
        await Actor.setValue('OUTPUT_SUMMARY', {
            jobsSaved: saved,
            pagesProcessed: stats.pagesProcessed,
            runtime: totalTime,
            success: true
        });
    }

} catch (error) {
    log.error(`❌ CRITICAL ERROR: ${error.message}`);
    log.exception(error, 'Actor failed with exception');
    await Actor.fail(`Actor failed: ${error.message}`);
} finally {
    await Actor.exit();
}
